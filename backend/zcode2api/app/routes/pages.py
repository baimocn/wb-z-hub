"""页面路由：登录、账号管理、设置。

前后端分离（2026-11-14）：后端只做**纯静态文件服务**（FileResponse，etag/
last-modified 协商缓存），不做任何服务端模板替换；前端资源可整体 rsync 到
任意静态源，配合 ZCODE_CORS_ORIGINS 即可跨源调用本 API。业务数据一律走
/admin/api/*（JSON + Bearer），与页面完全解耦。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, RedirectResponse

from .. import constants, settings

router = APIRouter()


def _html(name: str) -> FileResponse:
    path = settings.FRONTEND_DIR / "admin" / name
    if not path.exists():
        raise HTTPException(404, "页面不存在")
    return FileResponse(path, media_type="text/html", headers={"Cache-Control": "no-store"})


@router.get("/", include_in_schema=False)
async def root():
    # 统一壳：单页导航，概览 / wb 域（/wb-ui 深链）/ zc 域 / 全局，全程 3001。
    return RedirectResponse("/hub/index.html#/overview")


@router.get("/wb-ui", include_in_schema=False)
async def wb_ui():
    """WorkBuddy 控制台（wb dashboard.html）——在 3001 端口内直接服务。

    面板的所有相对路径 API 由 /wb/* 反代承载（wb_embed），配合 dashboard
    内置的 API_BASE 判定，控制台可以完整运行在统一网关端口下。
    """
    path = settings.WB_EMBED_SCRIPT.parent / "dashboard.html"
    if not path.exists():
        raise HTTPException(404, "wb 控制台不存在（ZCODE_WB_SCRIPT 未配置）")
    return FileResponse(path, media_type="text/html",
                        headers={"Cache-Control": "no-store"})


@router.get("/admin", include_in_schema=False)
async def admin_root():
    return RedirectResponse("/admin/login")


@router.get("/admin/login", include_in_schema=False)
async def admin_login():
    return _html("login.html")


@router.get("/admin/login.html", include_in_schema=False)
async def admin_login_html():
    return _html("login.html")


@router.get("/admin/accounts", include_in_schema=False)
async def admin_accounts():
    return _html("accounts.html")


@router.get("/admin/accounts.html", include_in_schema=False)
async def admin_accounts_html():
    return _html("accounts.html")


@router.get("/admin/monitoring", include_in_schema=False)
async def admin_monitoring():
    return _html("monitoring.html")


@router.get("/admin/monitoring.html", include_in_schema=False)
async def admin_monitoring_html():
    return _html("monitoring.html")


@router.get("/admin/settings", include_in_schema=False)
async def admin_settings():
    return _html("settings.html")


@router.get("/admin/settings.html", include_in_schema=False)
async def admin_settings_html():
    return _html("settings.html")


def _wb_versions() -> dict:
    """wb versionfeed 探测的版本指纹（落盘在 wb 的 settings.json）。只读，容错。"""
    try:
        data = json.loads(settings.WB_SETTINGS_PATH.read_text(encoding="utf-8"))
        auto = data.get("identity_versions_auto") or {}
        return {
            "versions": auto.get("versions") or {},
            "checked_at": auto.get("checked_at"),
        }
    except Exception:
        return {}


@router.get("/meta", include_in_schema=False)
async def meta():
    """统一网关元信息：网关版本 + 两个上游的版本指纹（zcode 正文锁 / wb 探测）。"""
    return {
        "version": settings.APP_VERSION,
        "upstreams": {
            "zcode": {
                "gateway": settings.APP_VERSION,
                "client": constants.CLIENT_APP_VERSION,
                "prompt_aligned": constants.PROMPT_ALIGNED_VERSION,
            },
            "workbuddy": _wb_versions(),
        },
    }
