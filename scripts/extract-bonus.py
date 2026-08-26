"""賞与に対する源泉徴収税額の算出率の表を src/data/bonus-r8.json にする。

    curl -L -A "Mozilla/5.0" -o build/raw/15-16.xls \
      https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/15-16.xls
    python scripts/extract-bonus.py

賞与の源泉徴収は月額表とは別物で、手順がまるごと違う:
  1. **前月**の社会保険料等控除後の給与額から税率を引く
  2. その税率を、**賞与から社会保険料を引いた額**に乗じる

表の値は千円単位。列は扶養親族等0〜7人以上の「以上/未満」ペアが並び、
最後に乙欄が続く。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import xlrd

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "build" / "raw" / "15-16.xls"
OUT = REPO / "src" / "data" / "bonus-r8.json"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

# 甲欄は扶養0〜7人以上で col 3..18、乙欄は col 19,20
KOU_COLS = [(3 + i * 2, 4 + i * 2) for i in range(8)]
OTSU_COLS = (19, 20)
THOUSAND = 1000


def num(v):
    return v if isinstance(v, (int, float)) and str(v).strip() != "" else None


def main() -> int:
    if not SRC.exists():
        print(f"元ファイルがありません: {SRC}", file=sys.stderr)
        return 1
    sh = xlrd.open_workbook(str(SRC)).sheet_by_index(0)

    kou: list[list[dict]] = [[] for _ in range(8)]
    otsu: list[dict] = []

    for r in range(sh.nrows):
        rate = num(sh.cell_value(r, 1))
        if rate is None and str(sh.cell_value(r, 1)).strip() != "0":
            continue
        # 税率の行だけを対象にする（0.0 も有効な税率）
        raw = str(sh.cell_value(r, 1)).strip()
        try:
            rate_val = float(raw)
        except ValueError:
            continue

        for i, (lo_c, hi_c) in enumerate(KOU_COLS):
            lo, hi = num(sh.cell_value(r, lo_c)), num(sh.cell_value(r, hi_c))
            hi_txt = str(sh.cell_value(r, hi_c)).strip()
            if lo is None:
                continue
            if hi is None and "未満" in hi_txt:
                # 先頭行は「82千円未満」の形。下限0、上限が lo。
                kou[i].append({"rate": rate_val / 100, "from": 0, "to": int(lo) * THOUSAND})
            elif hi is not None:
                kou[i].append({"rate": rate_val / 100,
                               "from": int(lo) * THOUSAND, "to": int(hi) * THOUSAND})
            else:
                # 最終行は上限なし
                kou[i].append({"rate": rate_val / 100, "from": int(lo) * THOUSAND, "to": None})

        lo, hi = num(sh.cell_value(r, OTSU_COLS[0])), num(sh.cell_value(r, OTSU_COLS[1]))
        hi_txt = str(sh.cell_value(r, OTSU_COLS[1])).strip()
        if lo is not None:
            if hi is None and "未満" in hi_txt:
                otsu.append({"rate": rate_val / 100, "from": 0, "to": int(lo) * THOUSAND})
            elif hi is not None:
                otsu.append({"rate": rate_val / 100, "from": int(lo) * THOUSAND, "to": int(hi) * THOUSAND})
            else:
                otsu.append({"rate": rate_val / 100, "from": int(lo) * THOUSAND, "to": None})

    # --- 検証 ---
    for i, band in enumerate(kou):
        if len(band) < 10:
            print(f"甲欄 {i}人 の行数が少なすぎます: {len(band)}", file=sys.stderr)
            return 1
        band.sort(key=lambda x: x["from"])
        for a, b in zip(band, band[1:]):
            if a["to"] != b["from"]:
                print(f"甲欄 {i}人 が連続していません: {a['to']} -> {b['from']}", file=sys.stderr)
                return 1
        if band[0]["from"] != 0 or band[-1]["to"] is not None:
            print(f"甲欄 {i}人 の範囲が閉じていません: {band[0]}, {band[-1]}", file=sys.stderr)
            return 1
        rates = [x["rate"] for x in band]
        if rates != sorted(rates):
            print(f"甲欄 {i}人 の税率が単調増加していません", file=sys.stderr)
            return 1

    otsu.sort(key=lambda x: x["from"])
    for a, b in zip(otsu, otsu[1:]):
        if a["to"] != b["from"]:
            print(f"乙欄が連続していません: {a['to']} -> {b['from']}", file=sys.stderr)
            return 1
    if not otsu or otsu[0]["from"] != 0 or otsu[-1]["to"] is not None:
        print(f"乙欄の範囲が閉じていません", file=sys.stderr)
        return 1

    payload = {
        "meta": {
            "label": "賞与に対する源泉徴収税額の算出率の表",
            "year": "令和8年分 (2026)",
            "source": "国税庁 令和8年分 源泉徴収税額表",
            "source_url": "https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/01.htm",
            "statute": "平成24年3月31日財務省告示第115号 (令和7年4月30日改正)",
            "licence": "公共データ利用規約(第1.0版)",
            "attribution_ja": "出典：国税庁ホームページを加工して作成",
            "method": (
                "前月の社会保険料等控除後の給与額と扶養親族等の数から率を引き、"
                "社会保険料等控除後の賞与額に乗じる。"
            ),
        },
        "table_does_not_apply_when": {
            "no_previous_month_pay": "前月中の給与等の金額がない",
            "previous_pay_at_or_below_insurance": "前月中の給与等が前月中の社会保険料等以下",
            "bonus_exceeds_ten_times": "賞与(社保控除後)が前月の社保控除後給与の10倍を超える",
            "instead_use": "財務省告示第115号による計算（月額表の電算機計算の特例に準じる）",
        },
        "kou": kou,
        "otsu": otsu,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"甲欄 {[len(b) for b in kou]} / 乙欄 {len(otsu)} -> {OUT} ({OUT.stat().st_size:,} bytes)")
    print(f"  税率: {kou[0][0]['rate']*100:.3f}% 〜 {kou[0][-1]['rate']*100:.3f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
