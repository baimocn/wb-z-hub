"""官方客户端包探针（E3）：下载 → 提取版本与提示词指纹 → 与网关配置 diff。

不整包下载：zip 包 300MB+，用 HTTP Range 读 EOCD / 中央目录，只解出
`glm/zcode.cjs`（几 MB），提取 APP_VERSION 并把本地 zcode_system.json 的
stableSections 中段指纹拿到上游正文里比对——命中说明该段未变，缺失说明
正文已变、需要人工移植。

所有出站 URL 先过 _safe_public_url：仅 https 公网 host，拒绝环回/私有/
保留地址（SSRF 闸门）。结果按版本缓存到 data/upstream-cache/，同一版本
二次分析不重复下载。
"""
from __future__ import annotations

import ipaddress
import json
import re
import struct
import time
import zlib
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from . import constants, logs, settings

ZIP_URL_TEMPLATE = (
    "https://cdn-zcode.z.ai/zcode/electron/releases/{version}"
    "/macos-arm64/ZCode-{version}-mac-arm64.zip"
)
TARGET_MEMBER_SUFFIX = "glm/zcode.cjs"
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
_APP_VERSION_RE = re.compile(r'APP_VERSION\s*[:=]\s*["\']([0-9]+\.[0-9]+\.[0-9]+)["\']')


class PackProbeError(Exception):
    """包探针失败（下载/解析/格式），消息可直接展示给运维。"""


def _safe_public_url(url: str) -> str:
    """SSRF 闸门：仅 https 公网 host，拒绝环回/私有/保留地址。"""
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise PackProbeError(f"仅允许 https 出站请求: {url}")
    host = (parts.hostname or "").lower()
    if not host:
        raise PackProbeError("URL 缺少 host")
    if host == "localhost" or host.endswith(".local") or host.endswith(".internal"):
        raise PackProbeError(f"拒绝内网/环回地址: {host}")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return url  # 公网域名
    if (ip.is_private or ip.is_loopback or ip.is_reserved
            or ip.is_link_local or ip.is_multicast):
        raise PackProbeError(f"拒绝私有/保留地址: {host}")
    return url


def _range(url: str, start: int, end: int) -> bytes:
    safe = _safe_public_url(url)
    with httpx.Client(timeout=90, trust_env=False, follow_redirects=True) as client:
        resp = client.get(safe, headers={"Range": f"bytes={start}-{end}"})
    if resp.status_code not in (206, 200):
        raise PackProbeError(f"Range 请求失败 HTTP {resp.status_code}")
    return resp.content


def _central_directory(url: str) -> list[dict]:
    total = None
    with httpx.Client(timeout=60, trust_env=False, follow_redirects=True) as client:
        head = client.head(url)
        content_length = head.headers.get("content-length")
        if content_length:
            total = int(content_length)
        else:
            raise PackProbeError("上游未返回 content-length，无法 Range 读取")
    tail_len = min(66000, total)
    tail = _range(url, total - tail_len, total - 1)
    sig = b"PK\x05\x06"
    idx = tail.rfind(sig)
    if idx < 0:
        raise PackProbeError("未找到 EOCD：目标不是 zip 或尾部被截断")
    cd_size, cd_offset = struct.unpack_from("<II", tail, idx + 12)
    if cd_offset + cd_size > total:
        raise PackProbeError("中央目录范围超出文件大小（疑似 zip64，暂不支持）")
    directory = _range(url, cd_offset, cd_offset + cd_size - 1)
    entries = []
    i = 0
    while i + 46 <= len(directory) and directory[i:i + 4] == b"PK\x01\x02":
        (method, _mtime, _mdate, _crc, csize, usize, nlen, elen, clen,
         _disk, _iattr, _eattr, lho) = struct.unpack_from(
            "<HHHIIIHHHHHII", directory, i + 10)
        name = directory[i + 46:i + 46 + nlen].decode("utf-8", "replace")
        entries.append({"name": name, "method": method,
                        "csize": csize, "usize": usize, "lho": lho})
        i += 46 + nlen + elen + clen
    return entries


def _extract_member(url: str, entry: dict) -> bytes:
    lho = entry["lho"]
    head = _range(url, lho, lho + 29)
    if head[:4] != b"PK\x03\x04":
        raise PackProbeError("本地文件头签名异常")
    nlen, elen = struct.unpack_from("<HH", head, 26)
    start = lho + 30 + nlen + elen
    data = _range(url, start, start + entry["csize"] - 1)
    if entry["method"] == 8:
        return zlib.decompress(data, -15)
    if entry["method"] == 0:
        return data
    raise PackProbeError(f"不支持的压缩方法 {entry['method']}")


def _cache_path(version: str) -> Path:
    return settings.DATA_DIR / "upstream-cache" / f"zcode-{version}.cjs"


def _load_member_text(version: str, refresh: bool) -> tuple[str, bool]:
    """返回 (cjs 文本, 是否本次下载)。同一版本缓存在 data/upstream-cache/。"""
    cache = _cache_path(version)
    if cache.exists() and not refresh:
        return cache.read_text("utf-8", errors="replace"), False
    url = ZIP_URL_TEMPLATE.format(version=version)
    entries = _central_directory(url)
    target = next((e for e in entries if e["name"].endswith(TARGET_MEMBER_SUFFIX)), None)
    if target is None:
        raise PackProbeError(f"包内没有 {TARGET_MEMBER_SUFFIX}（清单共 {len(entries)} 项）")
    data = _extract_member(url, target)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(data)
    logs.ok("pack-probe", f"已提取官方包成员 {target['name']}（{len(data)//1024} KiB）→ {cache.name}")
    return data.decode("utf-8", "replace"), True


def _line_status(line: str, probe_text: str) -> tuple[str, list[str]]:
    """行级判定：full（整行命中）/ partial（整行不在但句子片段全在）/ missing。

    官方正文里有模板拼接行（实测 3.18.2：` - ${e ? A : B} hooks...`），整行
    永远不在 cjs 里，但句子片段都在——partial 不算缺失，只做标记。
    """
    if line in probe_text:
        return "full", []
    # 切出的片段可能仍带列表标记前缀（官方元素无 "- "），剥掉再比对。
    segments = [s.lstrip("- ") for s in re.split(r"(?<=[.;])\s+", line)
                if len(s.lstrip("- ")) >= 25]
    if not segments:
        segments = [line]
    missing = [s for s in segments if s not in probe_text]
    if not missing:
        return "partial", []
    return "missing", missing


def _probe_view(text: str) -> str:
    r"""cjs → 比对视图：反转义 \uXXXX / \' / \" / \\。

    cjs 里非 ASCII 字符以 \uXXXX 字面转义存在（实测 em-dash 为 \u2014），
    撇号行实测是 don\'t——不反转义，本地正文里这些行会被误判「缺失」。
    """
    probe = re.sub(r"\\u([0-9a-fA-F]{4})",
                   lambda m: chr(int(m.group(1), 16)), text)
    return (probe.replace("\\'", "'").replace('\\"', '"')
            .replace("\\\\", "\\"))


def analyze_zcode_package(version: str, refresh: bool = False) -> dict:
    """下载指定版本的官方包，提取版本与提示词指纹，与网关配置 diff。"""
    if not VERSION_RE.match(version or ""):
        raise PackProbeError(f"版本号格式非法: {version!r}（期望 x.y.z）")
    started = time.time()
    text, downloaded = _load_member_text(version, refresh)
    probe_text = _probe_view(text)

    app_match = _APP_VERSION_RE.search(text)
    app_version = app_match.group(1) if app_match else None

    local_path = settings.ROOT_DIR / "app" / "zcode_system.json"
    local = json.loads(local_path.read_text(encoding="utf-8"))
    sections = local.get("stableSections") or []

    fingerprints = []
    for index, section in enumerate(sections):
        # cjs 里提示词是结构化数组（每行一个元素，join 组装），与本地拼好的
        # 整段文本字节序列不同——按行比对；行首缩进在组装时产生，先 strip。
        # 模板拼接行走 partial 判定（见 _line_status）。
        lines = [ln.strip() for ln in section.split("\n") if len(ln.strip()) >= 20]
        missing_entries: list[dict] = []
        full = partial = 0
        for ln in lines:
            verdict, fragments = _line_status(ln, probe_text)
            if verdict == "missing":
                missing_entries.append({"line": ln[:200],
                                        "fragments": fragments[:3]})
            elif verdict == "partial":
                partial += 1
            else:
                full += 1
        fingerprints.append({"index": index, "lines": len(lines),
                             "found": not missing_entries and bool(lines),
                             "full": full, "partial": partial,
                             "missing_count": len(missing_entries),
                             "missing_lines": missing_entries[:5]})
    missing = [f["index"] for f in fingerprints if f["found"] is False]
    stale = [f["index"] for f in fingerprints if f["found"] is None]

    if missing:
        detail = "；".join(
            f"段{f['index']}缺 {f.get('missing_count', len(f['missing_lines']))} 行"
            for f in fingerprints if f["found"] is False)
        recommendation = (
            f"段落 {missing} 在官方 {version} 正文里已有变化（{detail}）——"
            f"缺失行见 missing_lines，人工核对后更新 app/zcode_system.json，"
            f"再抬 PROMPT_ALIGNED_VERSION（先移植正文，后抬锁）。"
        )
    elif stale:
        recommendation = "全部可指纹行命中；有短段未比对（长度不足），人工过目一遍即可。"
    else:
        recommendation = f"全部段落逐行命中：本地正文与官方 {version} 一致，无需动作。"

    return {
        "version": version,
        "package_url": ZIP_URL_TEMPLATE.format(version=version),
        "member": TARGET_MEMBER_SUFFIX,
        "downloaded_now": downloaded,
        "app_version_in_package": app_version,
        "local_prompt_aligned": constants.PROMPT_ALIGNED_VERSION,
        "sections": fingerprints,
        "missing_sections": missing,
        "elapsed_s": round(time.time() - started, 1),
        "recommendation": recommendation,
    }
