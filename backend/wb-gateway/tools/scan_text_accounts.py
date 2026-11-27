# -*- coding: utf-8 -*-
"""真实任务扫描：让每个 cn 账号写一篇 300 字作文，判断文本是否真的可用。

与 /accounts/test 的最小探测不同，这里发的是完整生成请求（max_tokens=700），
能区分「能握手」和「能真正干活」：额度耗尽、文本封禁、限流都会暴露。

用法：
    python scan_text_accounts.py            # 全量 90 个
    python scan_text_accounts.py --limit 3  # 先跑 3 个试点
"""
import io, json, glob, os, sys, time, urllib.request, urllib.error, shutil

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = "http://127.0.0.1:8789"
KEY = os.environ.get("WB_GATEWAY_KEY", "")  # 本地网关 key 走环境变量，勿硬编码入库
TOKEN = open("_panel_token.txt", encoding="utf-8").read().strip()
PROMPT = "请以《秋天的校园》为题写一篇300字左右的作文，要有具体场景和细节，不要空话套话。"
MODEL = "glm-5.3-flash"
FALLBACK = "deepseek-v4.1-flash"
CANON = ['hy4-preview-f', 'hy3', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash',
         'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'kimi-k3-1',
         'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro',
         'hy4free', 'hy4std', 'space-bunny', 'minimax-m3.1-flash',
         'kimi-k3.1-pro', 'step-5-preview', 'mimo-v2.6-pro']


def api(path, body=None, headers=None, timeout=240):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        return 200, json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, {}
    except Exception as e:
        return -1, {"error": str(e)}


def set_disabled(uid, models):
    return api("/accounts/set", {"uid": uid, "disabledModels": models},
               {"X-Panel-Token": TOKEN}, 30)


def chat(uid, model):
    body = {"model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": 700, "stream": False, "temperature": 0.7}
    return api("/u/%s/v1/chat/completions" % uid, body,
               {"Authorization": "Bearer " + KEY}, 240)


def classify(status, resp):
    if status == 200 and isinstance(resp, dict) and "choices" in resp:
        try:
            c = resp["choices"][0]["message"].get("content", "") or ""
        except Exception:
            c = ""
        return ("ok" if len(c.strip()) >= 80 else "empty"), c
    msg = json.dumps(resp, ensure_ascii=False)
    if status == 401:
        return "token_expired", msg
    if "14018" in msg or "额度已用尽" in msg:
        return "no_credits", msg
    if "11140" in msg:
        return "text_banned", msg
    if status == 429:
        return "rate_limited", msg
    if status == 403:
        return "forbidden", msg
    return "error_%s" % status, msg


def load_accounts():
    rows = []
    for f in glob.glob(os.path.join(ROOT, "accounts", "*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if "uid" not in d or d.get("realm") != "cn":
            continue
        c = d.get("credits") or {}
        rows.append({
            "uid": d["uid"],
            "nickname": d.get("nickname") or "",
            "remain": c.get("remain"),
            "used": c.get("used"),
            "disabled": d.get("disabledModels") or [],
            "enabled": d.get("enabled", True),
            "file": os.path.basename(f),
        })
    # 有额度的先测，额度未知的其次，明确 0 额度的最后
    def key(r):
        rem = r["remain"]
        if rem is None:
            return (1, 0)
        return (0, -float(rem)) if rem > 0 else (2, 0)
    rows.sort(key=key)
    return rows


def main():
    limit = 0
    resume = False
    for i, a in enumerate(sys.argv):
        if a == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])
        if a == "--resume":
            resume = True
    rows = load_accounts()
    if limit:
        rows = rows[:limit]
    # 断点续测：跳过上一轮已经真实成功的号（它们刚写完作文，短期内必然受限）
    done_ok = set()
    if resume and os.path.exists("text_scan_results.json"):
        try:
            for r in json.load(open("text_scan_results.json", encoding="utf-8")):
                if r.get("verdict") == "ok":
                    done_ok.add(r["uid"])
            rows = [r for r in rows if r["uid"] not in done_ok]
            print("续测：跳过已成功 %d 个" % len(done_ok), flush=True)
        except Exception:
            pass
    print("待测 %d 个 cn 账号；模型 %s；真实任务：300 字作文" % (len(rows), MODEL), flush=True)

    results = []
    out_path = os.path.join(ROOT, "text_scan_results.json")
    t_start = time.time()
    for idx, a in enumerate(rows, 1):
        uid = a["uid"]
        t0 = time.time()
        # 先放开文本模型
        st, _ = set_disabled(uid, [])
        if st != 200:
            results.append(dict(a, verdict="set_failed", status=st, detail="", elapsed=0))
            print("[%d/%d] %s %s 解除禁用失败 HTTP %s" % (idx, len(rows), uid[:8], a["nickname"], st), flush=True)
            continue
        status, resp = chat(uid, MODEL)
        verdict, detail = classify(status, resp)
        # 登录过期：先试着刷新凭证，成功就再打一次
        if verdict == "token_expired":
            rst, rbody = api("/accounts/refresh", {"uid": uid},
                             {"X-Panel-Token": TOKEN}, 90)
            rrow = (rbody.get("results") or [{}])[0] if isinstance(rbody, dict) else {}
            if rrow.get("ok"):
                status, resp = chat(uid, MODEL)
                verdict, detail = classify(status, resp)
                detail = "[refresh后] " + detail
        # 模型级错误（非封禁/额度）时换一个模型再试一次
        if verdict.startswith("error_") and status not in (401, 403, 429):
            status2, resp2 = chat(uid, FALLBACK)
            v2, d2 = classify(status2, resp2)
            if v2 == "ok":
                verdict, detail, status = v2, d2, status2
            else:
                verdict, detail = v2, d2
        elapsed = time.time() - t0
        rec = dict(a, verdict=verdict, status=status, elapsed=round(elapsed, 1),
                   reply=(detail[:120] if verdict == "ok" else ""),
                   detail=("" if verdict == "ok" else detail[:400]))
        results.append(rec)
        if verdict == "ok":
            print("[%d/%d] %s %s ✅ 可用 %.0fs 回复%d字 余额%s" %
                  (idx, len(rows), uid[:8], a["nickname"], elapsed, len(detail), a["remain"]), flush=True)
        else:
            # 失败：恢复原来的禁用列表，避免文本流量打到废号
            restore = a["disabled"] if a["disabled"] else CANON
            set_disabled(uid, restore)
            print("[%d/%d] %s %s ❌ %s %.0fs %s" %
                  (idx, len(rows), uid[:8], a["nickname"], verdict, elapsed,
                   detail[:90].replace("\n", " ")), flush=True)
        json.dump(results, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        if idx < len(rows):
            time.sleep(4)

    # 汇总
    from collections import Counter
    c = Counter(r["verdict"] for r in results)
    ok = [r for r in results if r["verdict"] == "ok"]
    print("\n=== 扫描结束，用时 %.0f 分钟 ===" % ((time.time() - t_start) / 60), flush=True)
    print("结果分布:", dict(c), flush=True)
    print("可用账号 %d 个:" % len(ok), flush=True)
    for r in ok:
        print("  %s %s 余额%s" % (r["uid"][:8], r["nickname"], r["remain"]), flush=True)


if __name__ == "__main__":
    main()
