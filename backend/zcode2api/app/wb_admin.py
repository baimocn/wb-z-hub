"""wb 管理面聚合层（E5）：宿主用 host-key 登录 wb 子进程，代理其管理 API。

wb 面板鉴权是内存 session token（PanelSessions，重启即清，不落盘），所以
统一后台不能复用旧 token——这里通过 /panel/host-login（环回 + 共享密钥
WB_HOST_KEY）换一个 panel token，缓存到 401 再重登。

统一后台的前端只调 /admin/api/wb-admin/<wb 路径>，宿主转发到 wb 子进程的
同名管理端点（X-Panel-Token 携带会话 token），鉴权统一走后台密码。
"""
from __future__ import annotations

import time

import httpx

from . import logs, settings

_token: str | None = None
_token_at: float = 0.0
_client: httpx.AsyncClient | None = None
_client_timeout: float = 0.0


def _get_client(timeout: float) -> httpx.AsyncClient:
    """复用长连接客户端：面板每 5 秒轮询，反复建连也是开销。"""
    global _client, _client_timeout
    if _client is None or _client.is_closed or abs(_client_timeout - timeout) > 0.5:
        if _client is not None and not _client.is_closed:
            return _client  # 并发中先不换，避免关闭正在使用的连接
        _client = httpx.AsyncClient(timeout=timeout, trust_env=False,
                                    limits=httpx.Limits(max_connections=16,
                                                        max_keepalive_connections=8))
        _client_timeout = timeout
    return _client


async def close() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def configured() -> bool:
    return bool(str(settings.WB_EMBED_SCRIPT)) and bool(settings.WB_HOST_KEY)


def _base() -> str:
    return f"http://127.0.0.1:{settings.WB_EMBED_PORT}"


async def _login() -> str:
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(f"{_base()}/panel/host-login", json={},
                                 headers={"X-Host-Key": settings.WB_HOST_KEY})
    resp.raise_for_status()
    token = (resp.json() or {}).get("token") or ""
    if not token:
        raise RuntimeError("wb host-login 未返回 token")
    return token


async def call(method: str, path: str, payload=None,
               query: dict | None = None, timeout: float = 90) -> httpx.Response:
    """调 wb 管理面 API，返回原始 Response（字节透传，避免大 payload 二次序列化）。

    token 失效（401）自动重登一次再试。直连 wb 的 /accounts 有 1.9MB，
    若在这里 resp.json() 再交给 FastAPI 重新 dumps，会多出数次大对象转换，
    实测经聚合层耗时从直连 0.05s 膨胀到 2-8s。
    """
    global _token, _token_at
    # 子进程由 lifespan 管理，这里不再每请求 _alive() 探测——
    # 那会多一次往返，且大传输期间无意义（wb 是 ThreadingHTTPServer）。
    client = _get_client(timeout)
    headers = {"X-Panel-Token": _token or ""}
    for attempt in (1, 2):
        resp = await client.request(method, _base() + path, json=payload,
                                    params=query, headers=headers)
        if resp.status_code == 401 and attempt == 1:
            _token = await _login()
            _token_at = time.time()
            headers = {"X-Panel-Token": _token}
            continue
        return resp
    return resp
