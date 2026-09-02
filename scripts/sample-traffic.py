# -*- coding: utf-8 -*-
"""本番に、いま誰か来ているかを実測する。funnel の「試用」段の計器。

    python D:\\Claude\\tsumugi\\scripts\\sample-traffic.py            # 10分
    python D:\\Claude\\tsumugi\\scripts\\sample-traffic.py 120        # 秒で指定

`wrangler tail` を指定秒だけ流し、Worker が1リクエストごとに書く構造化ログ
(channel / path / status / plan)を数える。到達(npm DL・star)は
watch-first-event.py が見るが、**実際に叩かれているか**はここでしか分からない。

計器の生死を自分で確かめる: 開始20秒後に自分で1回叩き、それが数えられて
いなければ tail が繋がっていない。**0件と「見えていない」を区別する。**
自分の1件は user-agent で除いて報告する。

RapidAPI 経由の呼び出しは channel=rapidapi で出る。購読数そのものは
API から取れないが、有料経路が叩かれた事実はここに出る。
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://japan-payroll-api.tsumugi.workers.dev"
SELF_UA = "tsumugi-owner-probe"
seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 600

npx = "npx.cmd" if os.name == "nt" else "npx"
proc = subprocess.Popen(
    [npx, "wrangler", "tail", "--format", "json"],
    cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    encoding="utf-8", errors="replace",
)

buf: list[str] = []
def pump() -> None:
    for line in proc.stdout:  # type: ignore[union-attr]
        buf.append(line)
threading.Thread(target=pump, daemon=True).start()

def probe() -> None:
    time.sleep(20)
    req = urllib.request.Request(API + "/v1/holidays?year=2026", headers={"User-Agent": SELF_UA})
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception:
        pass
threading.Thread(target=probe, daemon=True).start()

print(f"  {seconds}s 観測中 ...", flush=True)
time.sleep(seconds)
proc.terminate()
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()

# wrangler は整形済み JSON を複数行で出す。'{' で始まる行から '}' 単独行までを1件にする。
events: list[dict] = []
cur: list[str] = []
for line in buf:
    if line.startswith("{"):
        cur = [line]
    elif cur:
        cur.append(line)
        if line.rstrip() == "}":
            try:
                events.append(json.loads("".join(cur)))
            except json.JSONDecodeError:
                pass
            cur = []

self_seen = False
by_channel: dict[str, int] = {}
by_path: dict[str, int] = {}
by_status: dict[str, int] = {}
others = 0
for ev in events:
    req = (ev.get("event") or {}).get("request") or {}
    ua = (req.get("headers") or {}).get("user-agent", "")
    if ua == SELF_UA:
        self_seen = True
        continue
    others += 1
    rec = None
    for lg in ev.get("logs") or []:
        for m in lg.get("message") or []:
            if isinstance(m, str) and m.startswith("{"):
                try:
                    rec = json.loads(m)
                except json.JSONDecodeError:
                    pass
    if rec:
        by_channel[rec.get("channel", "?")] = by_channel.get(rec.get("channel", "?"), 0) + 1
        by_path[rec.get("path", "?")] = by_path.get(rec.get("path", "?"), 0) + 1
        by_status[str(rec.get("status"))] = by_status.get(str(rec.get("status")), 0) + 1

print()
if not self_seen:
    print("  !! 自分の1件が見えていない。tail が繋がっていない。0件とは言えない。")
    err = proc.stderr.read()[-400:] if proc.stderr else ""
    if err.strip():
        print("  stderr:", err.strip())
    sys.exit(2)
print(f"  計器: 生きている(自分の1件を捕まえた)")
print(f"  {seconds}s の間の、自分以外のリクエスト: {others} 件")
if others:
    print("  channel:", dict(sorted(by_channel.items(), key=lambda x: -x[1])))
    print("  path:   ", dict(sorted(by_path.items(), key=lambda x: -x[1])[:10]))
    print("  status: ", dict(sorted(by_status.items(), key=lambda x: -x[1])))
else:
    print("  誰も叩いていない。到達はあっても試用に至っていない。")
