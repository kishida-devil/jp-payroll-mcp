"""内閣府の祝日CSVから src/data/holidays.json を作る。

    curl -L -A "Mozilla/5.0" -o build/raw/holidays.csv \
      https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv
    python scripts/extract-holidays.py

自前でアルゴリズムを実装しない理由: ハッピーマンデー・春分/秋分・振替休日・
国民の休日に加え、2019年の即位礼や2020/2021年の五輪移動のような一度きりの
例外がある。内閣府CSVはそれらを計算済みの確定値として持っている。
"""
from __future__ import annotations

import csv
import io
import json
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "build" / "raw" / "holidays.csv"
OUT = REPO / "src" / "data" / "holidays.json"

# 名称の英訳。内閣府CSVに実際に出現する23種すべてを網羅する（実測で確認）。
# CSVは振替休日と国民の休日を区別せず、どちらも「休日」として記録している。
EN = {
    "元日": "New Year's Day",
    "成人の日": "Coming of Age Day",
    "建国記念の日": "National Foundation Day",
    "天皇誕生日": "The Emperor's Birthday",
    "春分の日": "Vernal Equinox Day",
    "昭和の日": "Showa Day",
    "憲法記念日": "Constitution Memorial Day",
    "みどりの日": "Greenery Day",
    "こどもの日": "Children's Day",
    "海の日": "Marine Day",
    "山の日": "Mountain Day",
    "敬老の日": "Respect for the Aged Day",
    "秋分の日": "Autumnal Equinox Day",
    "スポーツの日": "Sports Day",
    "体育の日": "Health and Sports Day",
    "体育の日（スポーツの日）": "Health and Sports Day (Sports Day)",
    "文化の日": "Culture Day",
    "勤労感謝の日": "Labor Thanksgiving Day",
    # 振替休日・国民の休日はいずれもこの名称で記録される
    "休日": "Public holiday (substitute or bridge day)",
    "休日（祝日扱い）": "Public holiday (treated as a national holiday)",
    "即位礼正殿の儀": "Enthronement Ceremony Day",
    "大喪の礼": "State Funeral Ceremony",
    "結婚の儀": "Imperial Wedding Ceremony",
}

# 「休日」は振替か国民の休日かを名称からは区別できないので、種別を別に持たせる。
SUBSTITUTE_NAMES = {"休日", "休日（祝日扱い）"}


def main() -> int:
    if not SRC.exists():
        print(f"元CSVがありません: {SRC}", file=sys.stderr)
        print("README の手順で内閣府からダウンロードしてください。", file=sys.stderr)
        return 1

    raw = SRC.read_bytes()
    text = None
    for enc in ("cp932", "utf-8-sig", "utf-8"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        print("CSVの文字コードを判別できません", file=sys.stderr)
        return 1

    rows = [r for r in csv.reader(io.StringIO(text)) if r and len(r) >= 2]
    body = rows[1:]  # 1行目はヘッダ

    seen: set[str] = set()
    out: list[dict] = []
    unknown: set[str] = set()
    for d_raw, name in body:
        y, m, dd = (int(x) for x in d_raw.strip().split("/"))
        iso = date(y, m, dd).isoformat()
        if iso in seen:
            print(f"日付が重複しています: {iso}", file=sys.stderr)
            return 1
        seen.add(iso)
        name = name.strip()
        if name not in EN:
            unknown.add(name)
        out.append({
            "date": iso,
            "name": name,
            "name_en": EN[name],
            "substitute": name in SUBSTITUTE_NAMES,
        })

    if unknown:
        print(f"英訳が未定義の名称: {sorted(unknown)}", file=sys.stderr)
        return 1

    out.sort(key=lambda r: r["date"])
    years = sorted({int(r["date"][:4]) for r in out})
    # 年の抜けが無いか（1955以降は毎年必ず祝日がある）
    gaps = [y for y in range(years[0], years[-1] + 1) if y not in years]
    if gaps:
        print(f"祝日が1件も無い年があります: {gaps}", file=sys.stderr)
        return 1

    payload = {
        "meta": {
            "source": "内閣府 国民の祝日について",
            "source_url": "https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html",
            "license": "公共データ利用規約(第1.0版)",
            "count": len(out),
            "year_from": years[0],
            "year_to": years[-1],
        },
        "holidays": out,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)}件 / {years[0]}-{years[-1]} / {OUT.stat().st_size:,} bytes -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
