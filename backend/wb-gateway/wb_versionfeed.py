# -*- coding: utf-8 -*-
"""wb_versionfeed.py — 自动发现上游客户端版本号。

请求头里的 `WorkBuddy/<版本>`、`X-IDE-Version` 必须跟着官方客户端走。版本号
写死在代码里，客户端一升级网关就开始发旧版本，风控侧看到的是一条不再存在的
客户端指纹。这个模块从官方发布通道本身取值，不猜、不爬网页：

- 桌面端（国内）：`https://www.workbuddy.cn/v2/update?platform=...&version=0.0.0`
- 桌面端（国际）：`https://www.workbuddy.ai/v2/update?...`
- CLI：npm `@tencent-ai/codebuddy-code` 的 latest

前两个就是客户端 `UpdateService` 自己用的接口（`buildUpdateFeedUrl`，base 取
产品配置的 endpoint）。Windows 的 platform id 是 `workbuddy-win32-x64-archive`，
不是 `win32-x64` —— 后者会 400 invalid platform。返回的 `productVersion` 是
四段（`5.9.3.42398134`），前三段才是 `app.getVersion()` 拼进 UA 的值。

三条约束，和 wb_updates 一致：

1. **失败不致命**。单个源超时/400/坏 JSON 只记一行原因，其余源照常生效；进程
   启动时用上次落盘的值，不等网络。
2. **只升不降**。低于内置默认值的响应直接丢弃，避免坏响应把指纹退回到旧版本。
3. **手动优先**。面板显式改过的键永远盖过自动值；自动值只填没有手动值的键。

纯标准库，Python 3.9 兼容。
"""

import json
import re
import threading
import time
import urllib.error
import urllib.request

import wb_settings

USER_AGENT = "wb2api-version-feed"
REQUEST_TIMEOUT = 8
MAX_BODY = 256 * 1024

# 桌面端 feed。platform 用 Windows 归档包：它是唯一在发布通道里可用的桌面
# 平台 id（darwin 也有，但版本号与 Windows 同步发布，取一个就够）。
DESKTOP_FEEDS = (
    ("desktop_cn", "https://www.workbuddy.cn/v2/update"
                   "?platform=workbuddy-win32-x64-archive&version=0.0.0"),
    ("desktop_intl", "https://www.workbuddy.ai/v2/update"
                     "?platform=workbuddy-win32-x64-archive&version=0.0.0"),
)
CLI_FEED = "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest"

# 四段版本号：前三段进 UA，第四段是构建号，只做展示与比对。
_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$")

# 自动检查的节奏。官方发版是小时级，6 小时足够跟上，又不至于把发布通道当
# 心跳打；启动后先等 15 秒，让监听端口和账号池就绪。
CHECK_INTERVAL_SECONDS = 6 * 3600
FIRST_DELAY_SECONDS = 15
# 失败后的重试间隔：比正常周期短，但不会在发布通道故障时形成忙等。
RETRY_SECONDS = 30 * 60


def parse_version(text):
    """`5.9.3.42398134` / `v5.9.3` -> ("5.9.3", "5.9.3.42398134")。

    返回 (应用版本, 原始构建号)；不是版本号就返回 None。
    """
    raw = str(text or "").strip()
    match = _VERSION_RE.match(raw)
    if not match:
        return None
    app = ".".join(match.group(1, 2, 3))
    return app, raw.lstrip("v")


def version_tuple(text):
    """三段版本号 -> (major, minor, patch)，不可解析返回 None。"""
    parsed = parse_version(text)
    if parsed is None:
        return None
    return tuple(int(part) for part in parsed[0].split("."))


def describe_failure(exc):
    """一行能安全落盘的原因：不写 URL、不写响应体。"""
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return "HTTP %d" % code
    if isinstance(exc, json.JSONDecodeError):
        return "invalid JSON"
    if isinstance(exc, ValueError):
        return "unexpected document"
    if isinstance(exc, (urllib.error.URLError, OSError)):
        return "network error: %s" % type(exc).__name__
    return type(exc).__name__


def _fetch_json(url, timeout=REQUEST_TIMEOUT):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                   "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(MAX_BODY)
    return json.loads(body.decode("utf-8", "replace"))


def fetch_versions(timeout=REQUEST_TIMEOUT):
    """问一遍所有源，返回 {"versions", "detail", "errors"}。

    每个源独立失败：一个 400 不影响另一个；全部失败时 versions 为空，调用方
    保留上次落盘的值。
    """
    out = {"versions": {}, "detail": {}, "errors": {}}

    def take(key, raw, source):
        parsed = parse_version(raw)
        if parsed is None:
            out["errors"][key] = "unexpected version"
            return
        app, build = parsed
        out["versions"][key] = app
        out["detail"][key] = {"build": build, "source": source}

    for key, url in DESKTOP_FEEDS:
        try:
            document = _fetch_json(url, timeout=timeout)
            raw = ""
            if isinstance(document, dict):
                raw = document.get("productVersion") or document.get("version") or ""
            take(key, raw, url.split("/")[2])
        except Exception as exc:
            out["errors"][key] = describe_failure(exc)

    try:
        document = _fetch_json(CLI_FEED, timeout=timeout)
        raw = document.get("version") if isinstance(document, dict) else ""
        take("cli", raw, "registry.npmjs.org")
    except Exception as exc:
        out["errors"]["cli"] = describe_failure(exc)

    return out


def accepted_versions(found, floor=None):
    """丢掉低于内置默认值的自动值。

    `floor` 是每个键允许的最低版本（默认取 wb_identity 的默认版本）。发布通道
    回滚或响应被篡改时，宁可继续发内置值，也不把指纹降级。
    """
    import wb_identity  # 延迟导入：模块加载顺序与 identity 无关

    floor = floor or wb_identity.default_versions()
    out = {}
    for key, value in (found or {}).items():
        current = floor.get(key)
        if current:
            left, right = version_tuple(value), version_tuple(current)
            if left is None or right is None or left < right:
                continue
        out[key] = value
    return out


class VersionWatcher(threading.Thread):
    """后台轮询发布通道，把新版本写进 settings 并应用到出站身份。"""

    def __init__(self, settings_dir, apply=None, fetcher=None, log=None,
                 interval=CHECK_INTERVAL_SECONDS,
                 first_delay=FIRST_DELAY_SECONDS):
        super().__init__(daemon=True, name="version-feed")
        self.settings_dir = settings_dir
        self._apply = apply
        self._fetch = fetcher or fetch_versions
        self._log = log
        self._interval = max(60.0, float(interval))
        self._first_delay = max(0.0, float(first_delay))
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._checking = False
        self._last_error = {}
        self._last_attempt = 0.0
        self._last_success = 0.0
        self._versions = {}
        self._detail = {}
        self._load_state()

    def _load_state(self):
        try:
            state = wb_settings.identity_versions_auto(self.settings_dir)
        except Exception:
            return
        self._versions = state.get("versions") or {}
        self._detail = state.get("detail") or {}
        self._last_success = state.get("checked_at") or 0.0

    def status(self):
        return {
            "versions": dict(self._versions),
            "detail": dict(self._detail),
            "checked_at": self._last_success or None,
            "last_attempt": self._last_attempt or None,
            "last_error": dict(self._last_error),
            "checking": self._checking,
        }

    def log(self, message):
        if not self._log:
            return
        try:
            self._log(message)
        except Exception:
            pass

    def check(self):
        """同步跑一次发现；失败保留上次的值，返回状态。"""
        with self._lock:
            if self._checking:
                return self.status()
            self._checking = True
        self._last_attempt = time.time()
        try:
            snapshot = self._fetch()
            found = accepted_versions(snapshot.get("versions") or {})
            errors = snapshot.get("errors") or {}
            self._last_error = errors
            if found:
                merged = dict(self._versions)
                merged.update(found)
                detail = dict(self._detail)
                detail.update(snapshot.get("detail") or {})
                self._versions = merged
                self._detail = detail
                self._last_success = self._last_attempt
                wb_settings.set_identity_versions_auto(
                    self.settings_dir, merged, detail=detail,
                    checked_at=self._last_success)
                if self._apply:
                    self._apply()
                self.log("上游版本已更新：%s" % ", ".join(
                    "%s=%s" % (key, merged[key]) for key in sorted(found)))
            elif errors:
                self.log("上游版本检查失败：%s" % "; ".join(
                    "%s=%s" % (key, value) for key, value in sorted(errors.items())))
        except Exception as exc:
            self._last_error = {"feed": describe_failure(exc)}
            self.log("上游版本检查异常：%s" % self._last_error["feed"])
        finally:
            with self._lock:
                self._checking = False
        return self.status()

    def stop(self):
        self._stop_event.set()

    def run(self):
        if self._stop_event.wait(self._first_delay):
            return
        while not self._stop_event.is_set():
            try:
                status = self.check()
            except Exception:
                status = {}
            delay = RETRY_SECONDS if (status.get("last_error") or {}) else self._interval
            self._stop_event.wait(delay)
