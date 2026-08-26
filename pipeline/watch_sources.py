"""出典URLの変化と、収録データの賞味期限を監視する。

週次で回す想定。2つの異なる失敗を検知する:

  1. **元データが差し替わった** — Last-Modified / ETag / 本文ハッシュの変化
  2. **改定時期が来た** — src/data/freshness.json の next_revision_expected

1だけでは足りない。省庁は改定時に新しいURLでページを作ることがあり、
古いURLは変化しないまま放置される。2はその取りこぼしを拾う。

    python pipeline/watch_sources.py            # 変化があればDiscord通知
    python pipeline/watch_sources.py --dry-run  # 通知せず結果だけ表示
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import logging
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

from notify import notify_discord  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
FRESHNESS = REPO / "src" / "data" / "freshness.json"
STATE = REPO / "state" / "source_watch.json"

TIMEOUT = 30
WARN_WINDOW_DAYS = 45
UA = "tsumugi-source-watch/1.0 (+https://japan-payroll-api.tsumugi.workers.dev)"

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("watch")


def probe(url: str) -> dict:
    """URL の現在の指紋を取る。取得失敗も記録すべき事実として返す。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read(8_000_000)
            return {
                "ok": True,
                "status": r.status,
                "last_modified": r.headers.get("Last-Modified"),
                "etag": r.headers.get("ETag"),
                "length": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            }
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "status": None, "error": str(e)[:160]}


def changed(prev: dict | None, now: dict) -> str | None:
    """前回と比べて意味のある変化があったか。あれば人間向けの説明を返す。"""
    if prev is None:
        return None  # 初回は基準値を作るだけ
    if prev.get("ok") and not now.get("ok"):
        return f"取得できなくなりました（{now.get('error')}）"
    if not prev.get("ok") and now.get("ok"):
        return "再び取得できるようになりました"
    if not now.get("ok"):
        return None
    if prev.get("sha256") != now.get("sha256"):
        lm = now.get("last_modified") or "不明"
        return f"内容が変わりました（Last-Modified: {lm}, {prev.get('length')} → {now.get('length')} bytes）"
    return None


def due_status(iso: str | None, today: datetime.date) -> tuple[str, int | None]:
    if not iso:
        return "not_applicable", None
    due = datetime.date.fromisoformat(iso)
    days = (due - today).days
    if days < 0:
        return "overdue", days
    if days <= WARN_WINDOW_DAYS:
        return "due_soon", days
    return "current", days


# 改定を検知した人が、その通知だけを見て動けるようにするための対応表。
# 「README を参照」とだけ書いた通知は、半年後にそれを読む自分にとって何も言っていない
# のと同じで、READMEのどこを見るのか探すところから始まってしまう。
RUNBOOK = {
    "minimum_wage": (
        'curl -L -A "Mozilla/5.0" -o mw.xlsx https://www.mhlw.go.jp/content/11200000/001571219.xlsx\n'
        "python scripts/extract-minimum-wage.py --check   # まず現状を再現できるか確認\n"
        "python scripts/extract-minimum-wage.py           # 新年度が出ていれば取り込む"
    ),
    "social_insurance": (
        'curl -L -A "Mozilla/5.0" -o r9.xlsx https://www.kyoukaikenpo.or.jp/assets/r9ippan3.xlsx\n'
        "python scripts/extract-insurance.py              # ファイル名の年度部分は要確認"
    ),
    "holidays": (
        "curl -L -o syukujitsu.csv https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv\n"
        "python scripts/extract-holidays.py"
    ),
    "employment_insurance": "厚労省のPDFから手入力。src/data/employment-insurance.json",
    "consumption_tax": "税率が変わったときのみ。src/data/consumption-tax.json",
    "pension_grade_table": "等級表は協会けんぽのExcel由来なので extract-insurance.py に含まれる",
    "corporate_number": "アルゴリズムのみ。データ更新は不要",
}


def main() -> int:
    ap = argparse.ArgumentParser(description="出典の変化と改定時期を監視")
    ap.add_argument("--dry-run", action="store_true", help="通知せず結果のみ表示")
    args = ap.parse_args()

    data = json.loads(FRESHNESS.read_text(encoding="utf-8"))["datasets"]
    prev_state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    today = datetime.date.today()

    new_state: dict[str, dict] = {}
    source_changes: list[str] = []
    schedule_alerts: list[str] = []
    first_run: list[str] = []

    for key, d in data.items():
        status, days = due_status(d.get("next_revision_expected"), today)
        if status in ("overdue", "due_soon"):
            head = (f"🔴 **{d['label']}** 改定予定日を {abs(days)} 日超過（{d['next_revision_expected']}）"
                    if status == "overdue"
                    else f"🟠 **{d['label']}** 改定まで残り {days} 日（{d['next_revision_expected']}）")
            runbook = RUNBOOK.get(key)
            if runbook:
                head += "\n```\n" + runbook + "\n```"
            schedule_alerts.append(head)

        url = d.get("watch_url")
        if not url:
            continue
        now = probe(url)
        new_state[key] = now
        prev = prev_state.get(key)
        if prev is None:
            first_run.append(d["label"])
        msg = changed(prev, now)
        if msg:
            source_changes.append(f"📄 **{d['label']}**: {msg}\n  {url}")
        logger.info("%-22s %s", key, "OK" if now.get("ok") else now.get("error"))

    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(new_state, ensure_ascii=False, indent=1), encoding="utf-8")

    if first_run:
        logger.info("初回実行: %d件の基準値を記録しました", len(first_run))

    parts = []
    if source_changes:
        parts.append("**出典に変化がありました**\n" + "\n".join(source_changes))
    if schedule_alerts:
        parts.append("**改定時期が近づいています**\n" + "\n".join(schedule_alerts))

    if not parts:
        logger.info("変化なし・期限内。通知しません。")
        return 0

    body = "\n\n".join(parts) + (
        "\n\n取り込んだあとは必ず `npm test` → `npx wrangler deploy` → "
        "`npm run rapidapi:prepare`。最後まで通ることを確認すること。"
    )
    print("\n" + body + "\n")
    if args.dry_run:
        logger.info("--dry-run のため通知しませんでした")
    else:
        notify_discord(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
