# -*- coding: utf-8 -*-
"""国内 IP 下全量文本能力测试（本地 8789）。

背景：之前所有 11140 结论都在日本 VPN 出口下得出。现在出口切回福州家网，
上游看到的 IP 从机房变成国内住宅，需要重新验证每个号文本是否真可用。

规则（按用户口径）：
- 全量测试，不抽样
- 测完不禁用模型（不禁用 disabledModels）
- 成功：留在文本池
- 失败：挪回媒体池（文本废了但画图还能用），不禁用
"""
import io, json, os, sys, time, urllib.request, urllib.error

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
BASE = "http://127.0.0.1:8789"
KEY = os.environ.get("WB_GATEWAY_KEY", "")  # 本地网关 key 走环境变量，勿硬编码入库
PROMPT = "请以《雨后的街道》为题写一篇200字左右的短文，要有具体场景和细节。"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "text_scan_domestic.json")


def login():
    r = urllib.request.Request(BASE + "/panel/login",
                               data=json.dumps({"password": "Fms613728"}).encode(),
                               headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r, timeout=30).read().decode())["token"]


def api(path, body=None, token=None, key=None, timeout=240):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if token:
        h["X-Panel-Token"] = token
    if key:
        h["Authorization"] = "Bearer " + key
    req = urllib.request.Request(BASE + path, data=data, headers=h)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return {"_http": e.code}
    except Exception as e:
        return {"_err": str(e)}


def chat(uid):
    body = {"model": "glm-5.3-flash",
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": 400, "stream": False, "temperature": 0.7}
    r = api("/u/%s/v1/chat/completions" % uid, body, key=KEY)
    if r.get("choices"):
        c = (r["choices"][0].get("message") or {}).get("content", "") or ""
        return ("ok" if len(c.strip()) >= 80 else "empty"), c[:100]
    m = json.dumps(r, ensure_ascii=False)
    v = ("text_banned" if "11140" in m
         else "no_credits" if "14018" in m or "额度已用尽" in m
         else "rate_limited" if (r.get("_http") or 0) == 429
         else "boundary" if "媒体号池" in m
         else "error_%s" % (r.get("_http") or "x"))
    return v, m[:160]


def main():
    T = login()
    rows = api("/accounts?realm=cn", token=T)["accounts"]
    cn = [a for a in rows if a.get("realm") == "cn"]
    print("cn 总数 %d，开始全量文本测试（%s）" % (len(cn), time.strftime("%H:%M:%S")), flush=True)

    results = []
    ok_cnt = 0
    t0 = time.time()
    for i, a in enumerate(cn, 1):
        uid = a["uid"]
        name = str(a.get("nickname"))[:14]
        # 挪文本池 + 放开文本模型
        api("/accounts/set", {"uid": uid, "poolScope": "text"}, token=T, timeout=30)
        api("/accounts/set", {"uid": uid, "disabledModels": []}, token=T, timeout=30)
        v, detail = chat(uid)
        rec = {"uid": uid, "nickname": name,
               "remain": (a.get("credits") or {}).get("remain"),
               "verdict": v, "detail": "" if v == "ok" else detail}
        results.append(rec)
        if v == "ok":
            ok_cnt += 1
            print("[%d/%d] %s %-14s ✅ 可用" % (i, len(cn), uid[:8], name), flush=True)
        else:
            # 失败：挪回媒体池，不禁用模型
            api("/accounts/set", {"uid": uid, "poolScope": "media"}, token=T, timeout=30)
            print("[%d/%d] %s %-14s ❌ %s" % (i, len(cn), uid[:8], name, v), flush=True)
        json.dump(results, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        time.sleep(3)

    from collections import Counter
    print("\n=== 完成，用时 %.0f 分钟 ===" % ((time.time() - t0) / 60), flush=True)
    print("结果分布:", dict(Counter(r["verdict"] for r in results)), flush=True)
    ok = [r for r in results if r["verdict"] == "ok"]
    print("文本可用 %d 个：" % len(ok), flush=True)
    for r in ok:
        print("  %s %-14s 余额 %s" % (r["uid"][:8], r["nickname"], r["remain"]), flush=True)


main()
