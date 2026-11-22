"""上游版本对齐分析（统一后台「AI 上游分析」的数据源）。

聚合两个上游的版本状态并给出动作建议：

- zcode：官方 manifest 最新版 vs 正文锁 PROMPT_ALIGNED_VERSION。
  正文锁是人工闸门：落后时不自动抬锁，先移植 prompt.mjs 正文再抬锁。
- workbuddy：versionfeed 探测指纹（wb settings.json 的 identity_versions_auto）
  对比 wb_identity 的静态默认值；UA 由 configure_versions 自动跟版，
  静态默认值落后不等于运行时落后。

分析是启发式的：输出「事实 + 建议」，AI 解读在管理端/会话里做。
"""
from __future__ import annotations

import json
import re
import time

from . import constants, settings


def _wb_identity_defaults() -> dict:
    """静态提取 wb_identity._VERSION_DEFAULTS（不 import，避免模块级副作用）。"""
    try:
        text = settings.WB_EMBED_SCRIPT.read_text(encoding="utf-8")
    except Exception:
        return {}
    match = re.search(r"_VERSION_DEFAULTS\s*=\s*\{(.*?)\n\}", text, re.S)
    if not match:
        return {}
    return {
        key: value
        for key, value in re.findall(r'"([a-z_0-9]+)"\s*:\s*"([^"]*)"', match.group(1))
    }


def _wb_runtime() -> dict:
    try:
        data = json.loads(settings.WB_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    auto = data.get("identity_versions_auto") or {}
    manual = data.get("identity_versions") or {}
    return {
        "auto": auto.get("versions") or {},
        "checked_at": auto.get("checked_at") or 0,
        "manual": manual.get("versions") if isinstance(manual, dict) else {},
    }


def analyze(version_state: dict | None) -> dict:
    now = time.time()
    actions: list[dict] = []

    latest = str((version_state or {}).get("version") or "")
    aligned = constants.PROMPT_ALIGNED_VERSION
    port_required = bool((version_state or {}).get("prompt_port_required"))
    zcode_entry = {
        "latest": latest,
        "client": constants.CLIENT_APP_VERSION,
        "prompt_aligned": aligned,
        "prompt_port_required": port_required,
    }
    if latest and constants.is_newer_version(latest, aligned):
        actions.append({
            "upstream": "zcode",
            "level": "manual",
            "action": (
                f"官方已到 {latest}，正文锁停在 {aligned}。先从官方包 "
                f"glm/zcode.cjs 移植 prompt 正文进 app/zcode_system.json，"
                f"再抬 PROMPT_ALIGNED_VERSION；顺序不能反（头新正文旧 = 405/3012）。"
            ),
        })
    else:
        actions.append({
            "upstream": "zcode",
            "level": "ok",
            "action": f"正文锁 {aligned} 与官方 {latest or aligned} 对齐，无需动作。",
        })

    defaults = _wb_identity_defaults()
    runtime = _wb_runtime()
    auto = runtime.get("auto") or {}
    stale_minutes = None
    if runtime.get("checked_at"):
        stale_minutes = round((now - float(runtime["checked_at"])) / 60, 1)
    wb_entry = {
        "probed": auto,
        "identity_defaults": defaults,
        "manual_overrides": runtime.get("manual") or {},
        "probed_minutes_ago": stale_minutes,
    }
    if not auto:
        actions.append({
            "upstream": "workbuddy",
            "level": "warn",
            "action": (
                "versionfeed 还没有探测记录（wb settings.json 无 "
                "identity_versions_auto）；检查 wb 子进程的探测定时器与网络出口。"
            ),
        })
    elif stale_minutes is not None and stale_minutes > 24 * 60:
        actions.append({
            "upstream": "workbuddy",
            "level": "warn",
            "action": f"版本指纹已 {stale_minutes:.0f} 分钟未刷新，探测循环可能停摆。",
        })
    else:
        actions.append({
            "upstream": "workbuddy",
            "level": "ok",
            "action": "UA/版本由 versionfeed→configure_versions 自动跟版，无需人工动作。",
        })

    return {
        "generated_at": now,
        "upstreams": {"zcode": zcode_entry, "workbuddy": wb_entry},
        "actions": actions,
    }
