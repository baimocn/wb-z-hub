# -*- coding: utf-8 -*-
"""文本号真实测试（本地）：
1. 给文本号池每个可用号随机分配出站身份（workbuddy / vscode / cli）
2. 逐个发 300 字作文真实任务，统计真实可用数
失败号保持禁用文本模型（不给废号接流量）。
"""
import io, json, os, random, sys, time, urllib.request, urllib.error

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
BASE = "http://127.0.0.1:8789"
KEY = "sk-wb-TIUGEbM2O9HF2dRl6POCfZRt9QBo9a08lBQSq5FenC8"
MODEL = "glm-5.3-flash"
PROMPT = "请以《夏夜的巷子》为题写一篇300字左右的作文，要有具体场景和细节，不要空话套话。"
CANON = ['hy4-preview-f', 'hy3', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash',
         'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'kimi-k3-1',
         'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro',
         'hy4free', 'hy4std', 'space-bunny', 'minimax-m3.1-flash',
         'kimi-k3.1-pro', 'step-5-preview', 'mimo-v2.6-pro']
PRODUCTS = ["workbuddy", "vscode", "cli"]


def login():
    r = urllib.request.Request(BASE + "/panel/login",
                               data=json.dumps({"password": "Fms613728"}).encode(),
                               headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r, timeout=20).read().decode())["token"]


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


def main():
    T = login()
    rows = api("/accounts?realm=cn", token=T)["accounts"]
    text = [a for a in rows if a.get("realm") == "cn" and a.get("poolScope") == "text"]
    live = [a for a in text if not a.get("restrictedFor") and not a.get("needRelogin")
            and not a.get("tokenExpired")]
    print("文本号 %d 个，可测 %d 个（跳过风控窗口号）" % (len(text), len(live)), flush=True)

    # ---- 1. 随机出站身份 ----
    rng = random.Random()
    for a in live:
        p = rng.choice(PRODUCTS)
        r = api("/accounts/product", {"uid": a["uid"], "product": p}, token=T, timeout=30)
        ok = any(u == a["uid"][:8] for u in (r.get("changed") or [])) if isinstance(r, dict) else False
        print("[身份] %s %s -> %s %s" % (a["uid"][:8], a.get("nickname"), p, "OK" if ok else json.dumps(r)[:80]), flush=True)
        time.sleep(0.5)

    # ---- 2. 真实作文测试 ----
    results = []
    for idx, a in enumerate(live, 1):
        uid = a["uid"]
        body = {"model": MODEL,
                "messages": [{"role": "user", "content": PROMPT}],
                "max_tokens": 700, "stream": False, "temperature": 0.7}
        t0 = time.time()
        r = api("/u/%s/v1/chat/completions" % uid, body, key=KEY)
        dt = time.time() - t0
        if r.get("choices"):
            c = (r["choices"][0].get("message") or {}).get("content", "") or ""
            verdict = "ok" if len(c.strip()) >= 80 else "empty"
            detail = c[:120]
        else:
            msg = json.dumps(r, ensure_ascii=False)
            verdict = ("text_banned" if "11140" in msg
                       else "no_credits" if "14018" in msg or "额度已用尽" in msg
                       else "rate_limited" if (r.get("_http") or 0) == 429
                       else "error")
            detail = msg[:180]
        results.append({"uid": uid, "nickname": a.get("nickname"), "product": None,
                        "verdict": verdict, "elapsed": round(dt, 1),
                        "remain": (a.get("credits") or {}).get("remain"),
                        "detail": detail if verdict != "ok" else ""})
        if verdict == "ok":
            print("[%d/%d] %s %s ✅ %.0fs %d字" % (idx, len(live), uid[:8], a.get("nickname"), dt, len(detail)), flush=True)
        else:
            api("/accounts/set", {"uid": uid, "disabledModels": CANON}, token=T, timeout=30)
            print("[%d/%d] %s %s ❌ %s %s" % (idx, len(live), uid[:8], a.get("nickname"), verdict, detail[:90]), flush=True)
        json.dump(results, open("text_scan_r3.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        if idx < len(live):
            time.sleep(6)

    ok = [r for r in results if r["verdict"] == "ok"]
    print("\n=== 结果：%d/%d 真实可用 ===" % (len(ok), len(live)), flush=True)
    for r in ok:
        print("  %s %s 余额%s" % (r["uid"][:8], r["nickname"], r["remain"]), flush=True)


main()
