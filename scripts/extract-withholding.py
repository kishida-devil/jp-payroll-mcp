"""国税庁の源泉徴収税額表(.xls)から src/data/withholding-r8.json を作る。

    curl -L -A "Mozilla/5.0" -o build/raw/01-07.xls \
      https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/01-07.xls
    python scripts/extract-withholding.py

なぜ e-Gov 法令API を使わないのか:
所得税法別表第二は**復興特別所得税を含まない**。乙欄105,000〜107,000円で
e-Gov 3,700円 に対し国税庁の実務表は 3,800円、105,000円未満は 3% に対し
3.063%(=3%×1.021)。給与実務に使えるのは国税庁の表だけ。

表の構造:
  - 105,000円未満        甲は全て0、乙は金額の3.063%
  - 105,000〜740,000     231行の数値表(2,000〜3,000円刻み)
  - 740,000円以上        基準額ごとに「基準額の税額 + 超過分×税率」
    基準額同士は線形ではない(丸めが入る)ので、各基準額の実値を持つ。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import xlrd

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "build" / "raw" / "01-07.xls"
OUT = REPO / "src" / "data" / "withholding-r8.json"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

YEN = re.compile(r"^([\d,]+)円$")
# 「740,000円を超える金額の20.42％に相当する金額を加算した金額」
RATE = re.compile(r"([\d,]+)円を超える金額の([\d.]+)％")


def num(v) -> int | None:
    return int(v) if isinstance(v, (int, float)) and v else None


def main() -> int:
    if not SRC.exists():
        print(f"元ファイルがありません: {SRC}", file=sys.stderr)
        return 1
    sh = xlrd.open_workbook(str(SRC)).sheet_by_index(0)

    # --- 1. 105,000〜740,000 の数値表 ---
    brackets = []
    for r in range(sh.nrows):
        lo, hi = num(sh.cell_value(r, 1)), num(sh.cell_value(r, 2))
        seq = num(sh.cell_value(r, 0))
        if seq is None or lo is None or hi is None:
            continue
        kou = [num(sh.cell_value(r, 3 + i)) or 0 for i in range(8)]
        otsu = num(sh.cell_value(r, 11))
        if otsu is None:
            continue
        brackets.append({"from": lo, "to": hi, "kou": kou, "otsu": otsu})

    # --- 2. 740,000円以上のアンカー ---
    anchors = []
    for r in range(sh.nrows):
        label = str(sh.cell_value(r, 1)).strip()
        m = YEN.match(label)
        if not m:
            continue
        amount = int(m.group(1).replace(",", ""))
        kou = [num(sh.cell_value(r, 3 + i)) for i in range(8)]
        if any(k is None for k in kou):
            continue
        otsu = num(sh.cell_value(r, 11))
        # 直後の数行から、この基準額を超えたときの税率を拾う
        kou_rate = otsu_rate = None
        for rr in range(r, min(r + 12, sh.nrows)):
            for c in range(sh.ncols):
                cell = str(sh.cell_value(rr, c))
                mm = RATE.search(cell)
                if not mm or int(mm.group(1).replace(",", "")) != amount:
                    continue
                if c == 11:
                    otsu_rate = float(mm.group(2)) / 100
                elif kou_rate is None:
                    kou_rate = float(mm.group(2)) / 100
        anchors.append({
            "amount": amount, "kou": kou,
            **({"otsu": otsu} if otsu is not None else {}),
            **({"kou_rate_above": kou_rate} if kou_rate else {}),
            **({"otsu_rate_above": otsu_rate} if otsu_rate else {}),
        })

    # --- 検証 ---
    if len(brackets) != 231:
        print(f"数値表の行数が想定と違います: {len(brackets)} (231のはず)", file=sys.stderr)
        return 1
    for a, b in zip(brackets, brackets[1:]):
        if a["to"] != b["from"]:
            print(f"区間が連続していません: {a['to']} -> {b['from']}", file=sys.stderr)
            return 1
    if brackets[0]["from"] != 105_000 or brackets[-1]["to"] != 740_000:
        print(f"表の範囲が想定と違います: {brackets[0]['from']}〜{brackets[-1]['to']}", file=sys.stderr)
        return 1
    # 甲欄は扶養が増えるほど税額が下がる（同額はありうるが逆転はない）
    for b in brackets:
        if any(b["kou"][i] < b["kou"][i + 1] for i in range(7)):
            print(f"甲欄が扶養人数に対して逆転しています: {b}", file=sys.stderr)
            return 1
    if len(anchors) < 8:
        print(f"高額域のアンカーが少なすぎます: {len(anchors)}", file=sys.stderr)
        return 1
    missing = [a["amount"] for a in anchors[:-1] if "kou_rate_above" not in a]
    if missing:
        print(f"税率を読めなかったアンカー: {missing}", file=sys.stderr)
        return 1

    payload = {
        "meta": {
            "label": "給与所得の源泉徴収税額表 月額表",
            "year": "令和8年分 (2026)",
            "source": "国税庁 令和8年分 源泉徴収税額表",
            "source_url": "https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/01.htm",
            "licence": "公共データ利用規約(第1.0版)",
            "attribution_ja": "出典：国税庁ホームページを加工して作成",
            "includes_reconstruction_surtax": True,
            "note": (
                "復興特別所得税(2.1%)込みの実務値。所得税法別表第二(e-Gov)は"
                "これを含まないため給与実務には使えない。"
            ),
        },
        "rules": {
            "below_minimum": {
                "threshold": 105_000,
                "kou": 0,
                "otsu_rate": 0.03063,
                "note": "105,000円未満は甲欄0円、乙欄は金額の3.063%",
            },
            "dependants_over_seven_deduction": 1_610,
            "max_dependants_in_table": 7,
        },
        "brackets": brackets,
        "high_income_anchors": anchors,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"区間 {len(brackets)}件 / アンカー {len(anchors)}件 -> {OUT} ({OUT.stat().st_size:,} bytes)")
    print(f"  表の範囲: {brackets[0]['from']:,} 〜 {brackets[-1]['to']:,}")
    print("  アンカー: " + ", ".join(f"{a['amount']:,}" for a in anchors))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
