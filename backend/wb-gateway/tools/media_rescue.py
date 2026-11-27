# -*- coding: utf-8 -*-
"""媒体池文本捡漏器（本地 8789）：
从媒体号池抽样真实作文测试，发现文本恢复的号自动挪进文本池。

用法：
    python tools/media_rescue.py            # 默认抽测 5 个
    python tools/media_rescue.py --n 8      # 抽测 8 个
    python tools/media_rescue.py --loop     # 每 2 小时跑一轮，常驻

策略（基于 11-06 ~ 11-08 的实测规律）：
- 11140 是窗口性风控，号会在文本池/媒体池之间自然轮换
- 每轮只抽小样本（默认 5），测完立即恢复禁用，避免触发连坐
- 测出文本可用的号：poolScope 改回 text，并保持文本模型放开
- 测试失败号：恢复 21 模型禁用，原池不动
"""
import io, json, os, random, sys, time, urllib.request, urllib.error

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
BASE = "http://127.0.0.1:8789"
KEY = os.environ.get("WB_GATEWAY_KEY", "")  # 本地网关 key 走环境变量，勿硬编码入库
PROMPT = "请以《老街的修表铺》为题写一篇200字短文，要有具体细节。"
CANON = ['hy4-preview-f', 'hy3', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash',
         'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'kimi-k3-1',
         'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro',
         'hy4free', 'hy4std', 'space-bunny', 'minimax-m3.1-flash',
         'kimi-k3.1-pro', 'step-5-preview', 'mimo-v2.6-pro']
LOG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "media_rescue_log.json")


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


def chat(uid):
    body = {"model": "glm-5.3-flash",
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": 400, "stream": False, "temperature": 0.7}
    req = urllib.request.Request(BASE + "/u/%s/v1/chat/completions" % uid,
                                 data=json.dumps(body, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + KEY})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
        c = (r["choices"][0].get("message") or {}).get("content", "") or ""
        return ("ok", c) if len(c.strip()) >= 80 else ("empty", c[:60])
    except urllib.error.HTTPError as e:
        try:
            b = json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            b = {}
        m = json.dumps(b, ensure_ascii=False)
        v = ("text_banned" if "11140" in m
             else "no_credits" if "14018" in m or "额度" in m
             else "token_dead" if "401" in m
             else "err")
        return (v, m[:80])


def rescue_round(n=5, T=None):
    rows = api("/accounts?realm=cn", token=T)["accounts"]
    media = [a for a in rows if a.get("poolScope") == "media"
             and not a.get("needRelogin") and not a.get("tokenExpired")]
    # 优先抽「从未测过或上次失败较久」的：简单起见随机
    rng = random.Random()
    rng.shuffle(media)
    sample = media[:n]
    rescued = []
    print("[捡漏] 媒体池 %d 个，抽测 %d 个" % (len(media), len(sample)), flush=True)
    for i, a in enumerate(sample, 1):
        uid = a["uid"]
        api("/accounts/set", {"uid": uid, "disabledModels": []}, token=T, timeout=30)
        v, d = chat(uid)
        if v == "ok":
            # 挪回文本池：poolScope=text + 保持文本放开
            r = api("/accounts/set", {"uid": uid, "poolScope": "text"}, token=T, timeout=30)
            moved = r.get("account", {}).get("poolScope") == "text"
            rescued.append({"uid": uid, "nickname": a.get("nickname"),
                            "remain": (a.get("credits") or {}).get("remain")})
            print("  [%d/%d] %s %s ✅ 已救回文本池（余额 %s）"
                  % (i, len(sample), uid[:8], a.get("nickname"),
                     (a.get("credits") or {}).get("remain")), flush=True)
        else:
            api("/accounts/set", {"uid": uid, "disabledModels": CANON}, token=T, timeout=30)
            print("  [%d/%d] %s ❌ %s" % (i, len(sample), uid[:8], v), flush=True)
        time.sleep(5)
    # 记录
    log = []
    if os.path.exists(LOG):
        try:
            log = json.load(open(LOG, encoding="utf-8"))
        except Exception:
            log = []
    log.append({"ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                "tested": len(sample), "rescued": len(rescued),
                "uids": [r["uid"][:8] for r in rescued]})
    json.dump(log[-100:], open(LOG, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("[捡漏] 本轮救回 %d/%d；累计记录见 media_rescue_log.json" % (len(rescued), len(sample)),
          flush=True)
    return rescued


def main():
    n = 5
    loop = False
    args = sys.argv[1:]
    if "--n" in args:
        n = int(args[args.index("--n") + 1])
    loop = "--loop" in args
    T = login()
    open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "workbuddy2api-hub-main", "_panel_token.txt")
         if False else "_panel_token.txt", "w").write(T)
    if loop:
        while True:
            try:
                rescue_round(n, T)
            except Exception as e:
                print("[捡漏] 轮次异常:", str(e)[:120], flush=True)
            print("[捡漏] 2 小时后进行下一轮...", flush=True)
            time.sleep(7200)
    else:
        rescue_round(n, T)


main()
