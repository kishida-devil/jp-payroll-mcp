# -*- coding: utf-8 -*-
"""「初めて起きた出来事」を捕まえるための計器。

    python D:\\Claude\\tsumugi\\scripts\\watch-first-event.py

率は測れない。funnel が無いので、母数も経路も分からない。
測れるのは「0 だったものが 0 でなくなった瞬間」だけ。それを見張る。

初回に基準値を書き、以後は差だけを言う。変化が無ければ「変化なし」と言う。
**推測で埋めない。**

RapidAPI の購読数は API から取れない(提供者の画面にしか出ない)ので、
ここでは扱わない。利用者に聞くしかない。
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

UA = {"User-Agent": "tsumugi-owner-check", "Cache-Control": "no-cache"}
PKG = "jp-payroll-mcp"
REPO = "kishida-devil/jp-payroll-mcp"
STATE = Path(__file__).resolve().parent.parent / "docs" / "first-event.json"


def get(url: str):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return {"_error": e.code}
    except Exception as e:
        return {"_error": f"{type(e).__name__}"}


def measure() -> dict:
    reg = get(f"https://registry.npmjs.org/{PKG}")
    latest = (reg.get("dist-tags") or {}).get("latest", "")
    dl = get(f"https://api.npmjs.org/versions/{PKG}/last-week").get("downloads", {})
    gh = get(f"https://api.github.com/repos/{REPO}")
    return {
        "npm_latest_version": latest,
        # **これが本命。**ミラーは全版を機械的に引き、人間は npx で latest を引く。
        # 古い版に均等・最新版だけ 0 という形が、実利用ゼロの証拠だった。
        "npm_latest_downloads": dl.get(latest, 0),
        "npm_total_downloads": sum(v for v in dl.values() if isinstance(v, int)),
        "github_stars": gh.get("stargazers_count", 0),
        "github_forks": gh.get("forks_count", 0),
        "github_watchers": gh.get("subscribers_count", 0),
        "github_issues": gh.get("open_issues_count", 0),
    }


# 何が「初めて」なのか。0 から動いたら、それは人。
FIRST = {
    "npm_latest_downloads": "**最新版が初めてダウンロードされた。** ミラーではなく人の可能性が高い",
    "github_stars": "**初めて star が付いた。**",
    "github_forks": "**初めて fork された。**",
    "github_watchers": "**初めて watch された。**",
    "github_issues": "**初めて issue が立った。** 中身を読むこと",
}
LABEL = {
    "npm_latest_version": "npm の latest",
    "npm_latest_downloads": "latest のDL",
    "npm_total_downloads": "npm 合計DL",
    "github_stars": "star",
    "github_forks": "fork",
    "github_watchers": "watch",
    "github_issues": "issue",
}


def main() -> int:
    now = measure()

    if not STATE.exists():
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(now, ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
        print()
        print("  基準値を記録しました。次回から差だけを報告します。")
        print()
        for k, v in now.items():
            print(f"    {LABEL.get(k, k)}: {v}")
        print()
        print(f"  {STATE}")
        print()
        print("  RapidAPI の購読数は API から取れません。画面で見てください。")
        return 0

    before = json.loads(STATE.read_text(encoding="utf-8"))
    events, moved = [], []
    for k, v in now.items():
        b = before.get(k)
        if b == v:
            continue
        moved.append(f"{LABEL.get(k, k)}: {b} → {v}")
        if k in FIRST and isinstance(b, int) and isinstance(v, int) and b == 0 < v:
            events.append(FIRST[k])

    print()
    if events:
        print("  " + "=" * 46)
        for e in events:
            print(f"  {e}")
        print("  " + "=" * 46)
        print()
    if moved:
        for m in moved:
            print(f"    {m}")
    else:
        print("    変化なし")
    print()
    for k, v in now.items():
        print(f"    いま {LABEL.get(k, k)}: {v}")
    print()
    print("  RapidAPI の購読数は API から取れません。画面で見てください。")

    STATE.write_text(json.dumps(now, ensure_ascii=False, indent=2) + "\n",
                     encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
