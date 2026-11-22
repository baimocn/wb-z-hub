"""WorkBuddy 网关内嵌（统一入口 /wb/*）。

wb_proxy.py 是 2.9 万行的 http.server 单文件，直接 import 会带入模块级副作用
与阻塞式 serve_forever，所以这里以**子进程**托管它（内部端口，默认 18790），
FastAPI 侧把 /wb/* 反代过去：

- Authorization / query / body 原样透传，wb 的 API Key 鉴权仍在 wb 侧完成；
- 流式响应（wb 的 SSE/chunk）按原始字节转发，不重编码；
- 子进程由本模块管理：启动时拉起、退出时终止、请求前确保存活。

ZCODE_WB_SCRIPT 为空 = 关闭内嵌，/wb/* 返回 404（wb 继续独立跑 8789）。
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

from . import logs, settings
from .settings import WB_EMBED_PORT, WB_EMBED_SCRIPT

router = APIRouter()

_HOP_HEADERS = {
    "host", "content-length", "connection", "keep-alive", "transfer-encoding",
    "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate",
}

_proc: subprocess.Popen | None = None
_lock = asyncio.Lock()
_client: httpx.AsyncClient | None = None
_alive_until: float = 0.0  # 健康检查缓存：避免每个请求都建新连接查 /health（每次 ~600ms）


def configured() -> bool:
    return bool(str(WB_EMBED_SCRIPT))


def _base_url() -> str:
    return f"http://127.0.0.1:{WB_EMBED_PORT}"


async def _alive() -> bool:
    global _alive_until
    import time
    if time.monotonic() < _alive_until:
        return True  # 缓存期内直接放行，不查 /health
    try:
        client = _client_get()
        resp = await client.get(f"{_base_url()}/health", timeout=3)
        ok = resp.status_code == 200
        if ok:
            _alive_until = time.monotonic() + 30  # 30 秒内不再查
        return ok
    except Exception:
        return False


def _invalidate_alive():
    global _alive_until
    _alive_until = 0.0


def _spawn() -> None:
    global _proc
    script = Path(str(WB_EMBED_SCRIPT))
    if not configured() or not script.exists():
        logs.err("wb-embed", f"WB 脚本不存在: {WB_EMBED_SCRIPT}")
        return
    cmd = [sys.executable, str(script), "--port", str(WB_EMBED_PORT)]
    env = {**os.environ}
    if settings.WB_HOST_KEY:
        # 宿主管理通道密钥：/panel/host-login 只认这个
        env["WB_HOST_KEY"] = settings.WB_HOST_KEY
    _proc = subprocess.Popen(
        cmd, cwd=str(script.parent), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    logs.ok("wb-embed", f"已拉起 WorkBuddy 网关子进程 pid={_proc.pid} :{WB_EMBED_PORT}")


async def ensure_running() -> bool:
    """请求前确保 wb 子进程与 /health 就绪；返回是否可用。

    缓存期内跳过锁和健康检查（2026-11-22 实证：每请求新建 AsyncClient 查 /health
    多 ~600ms，是 /wb/* 全部 API 的统一瓶颈）。
    """
    global _proc, _alive_until
    import time
    # 快路径：子进程活着 + 健康缓存未过期 → 直接放行
    if _proc is not None and _proc.poll() is None and time.monotonic() < _alive_until:
        return True
    async with _lock:
        if await _alive():
            return True
        if _proc is not None and _proc.poll() is not None:
            logs.warn("wb-embed", f"wb 子进程已退出 code={_proc.returncode}，重新拉起")
            _proc = None
        if _proc is None:
            _spawn()
        for _ in range(20):
            await asyncio.sleep(1)
            if _proc is not None and _proc.poll() is not None:
                return False
            if await _alive():
                return True
        logs.err("wb-embed", "wb 子进程启动超时（/health 未就绪）")
        return False


async def stop() -> None:
    global _proc, _client, _alive_until
    _alive_until = 0.0
    if _client is not None:
        await _client.aclose()
        _client = None
    if _proc is not None and _proc.poll() is None:
        _proc.terminate()
        try:
            _proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            _proc.kill()
    _proc = None


def _client_get() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10))
    return _client


def _strip_hop(headers) -> dict:
    out = {}
    for key, value in headers.items():
        low = key.lower()
        if low in _HOP_HEADERS or low == "content-encoding":
            continue
        out[key] = value
    return out


@router.api_route("/wb/{path:path}",
                  methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def wb_forward(request: Request, path: str):
    if not configured():
        return Response(
            content='{"error":{"message":"wb 内嵌未启用（ZCODE_WB_SCRIPT 未配置）"}}',
            status_code=404, media_type="application/json")
    if not await ensure_running():
        return Response(
            content='{"error":{"message":"WorkBuddy 网关子进程不可用"}}',
            status_code=503, media_type="application/json")
    headers = _strip_hop(request.headers)
    url = f"{_base_url()}/{path}"
    client = _client_get()
    up_request = client.build_request(
        request.method, url, headers=headers,
        content=await request.body(), params=dict(request.query_params))
    try:
        up = await client.send(up_request, stream=True)
    except httpx.HTTPError as err:
        _invalidate_alive()
        logs.err("wb-embed", f"转发失败 {request.method} /{path}: {err}")
        return Response(
            content='{"error":{"message":"WorkBuddy 网关转发失败"}}',
            status_code=502, media_type="application/json")

    async def _stream():
        try:
            async for chunk in up.aiter_raw():
                yield chunk
        finally:
            await up.aclose()

    return StreamingResponse(
        _stream(), status_code=up.status_code,
        headers=_strip_hop(up.headers),
        background=None)
