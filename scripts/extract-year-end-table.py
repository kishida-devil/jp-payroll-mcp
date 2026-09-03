# -*- coding: utf-8 -*-
"""国税庁「令和8年分 年末調整のしかた」(nencho_all.pdf)から、
「令和8年分の年末調整等のための給与所得控除後の給与等の金額の表」を抽出する。

    curl -L -A "Mozilla/5.0" -o build/raw/nencho2026/nencho_all.pdf \
      https://www.nta.go.jp/publication/pamph/gensen/nencho2026/pdf/nencho_all.pdf
    python scripts/extract-year-end-table.py            # src/data/year-end-r8.json を書く
    python scripts/extract-year-end-table.py --check    # 既存と一致するかだけ確認

なぜ計算式ではなく表を持つのか:
表の値は所得税法別表第五の刻み(4,000円)と端数処理から導けるが、年末調整の
実務は**印刷された表の値**で行う。計算式で再現して1円ずれれば、その1円は
利用者の年調年税額に出る。バーは印刷された表そのもの。式は検算に使う。

表の構造(冊子 47〜54ページ、PDF の 0 始まりで 46〜53):
  1ページに3組の「以上 未満 控除後」列。行は 4,000円刻み(最初の3行だけ 2,000/3,000/4,000)。
  表の外側は文で書かれている:
    741,000円未満 → 0
    741,000〜2,190,999 → 給与等の金額 − 740,000
    6,600,000〜8,499,999 → 給与等の金額 × 90% − 1,100,000(1円未満切捨て)
    8,500,000〜19,999,999 → 給与等の金額 − 1,950,000
    20,000,000以上 → 年末調整の対象外
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
YEAR = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--year=")), "2026"))
ERA = {2025: "R7", 2026: "R8"}[YEAR]
PDF = ROOT / "build" / "raw" / f"nencho{YEAR}" / "nencho_all.pdf"
OUT = ROOT / "src" / "data" / f"year-end-{ERA.lower()}.json"
PAGES = range(46, 54)

ROW = re.compile(r"(\d{1,2},\d{3},\d{3}) (\d{1,2},\d{3},\d{3}) (\d{1,2},\d{3},\d{3})")
yen = lambda s: int(s.replace(",", ""))


def extract() -> tuple[list[dict], int, int]:
    rows: list[tuple[int, int, int]] = []
    zero_below = subtract = None
    with pdfplumber.open(PDF) as pdf:
        for i in PAGES:
            text = pdf.pages[i].extract_text() or ""
            m = re.search(r"(\d{3},\d{3})円未満 0", text)
            if m: zero_below = yen(m.group(1))
            m = re.search(r"ら(\d{3},\d{3})円 ?を", text)
            if m: subtract = yen(m.group(1))
            for line in text.split("\n"):
                # 1行に最大3組。行末の表外の文(「給与等の金額に」など)は数字3組に当たらない。
                for m in ROW.finditer(line):
                    a, b, c = (yen(m.group(k)) for k in (1, 2, 3))
                    if a < b and c < a:
                        rows.append((a, b, c))
    rows = sorted(set(rows))
    assert zero_below and subtract, f"表の外側の規則が読めない: {zero_below} {subtract}"
    return [{"from": a, "to": b, "amount": c} for a, b, c in rows], zero_below, subtract


def check_shape(rows: list[dict]) -> None:
    assert rows, "行が1つも取れていない"
    assert rows[0]["from"] in (2_191_000, 1_900_000), f"最初の行が想定外: {rows[0]}"
    assert rows[-1]["to"] == 6_600_000, f"最後の行が 6,600,000 で終わっていない: {rows[-1]}"
    for prev, cur in zip(rows, rows[1:]):
        assert prev["to"] == cur["from"], f"隙間か重なり: {prev} → {cur}"
        assert cur["amount"] > prev["amount"], f"控除後の額が増えていない: {prev} → {cur}"
    steps = {r["to"] - r["from"] for r in rows if not (YEAR == 2026 and r["from"] < 2_200_000)}
    assert steps == {4_000}, f"4,000円刻みでない行がある: {steps}"
    # 検算: 別表第五の式。4,000円刻みの区分では、区分の下限 A に対して
    #   2,200,000〜3,600,000: A×0.7 − 80,000 → 実際は「A÷4 → 千円未満切捨 → ×2.8」
    #   3,600,000〜6,600,000: A÷4 → 千円未満切捨 → ×3.2 − 440,000
    # のように定義されている。全行を式で再現して一致することを確かめる。
    bad = []
    for r in rows:
        a = r["from"]
        q = (a // 4) // 1000 * 1000
        if YEAR == 2026 and a < 2_200_000:
            continue  # 令和8年分の最初の3行だけ個別の値
        # 浮動小数点で掛けると 627,000×2.8 が 1,755,599.99… になる。整数で。
        expect = q * 28 // 10 - 80_000 if a < 3_600_000 else q * 32 // 10 - 440_000
        if expect != r["amount"]:
            bad.append((a, r["amount"], expect))
    assert not bad, f"式と一致しない行: {bad[:5]} (計 {len(bad)})"


def main() -> None:
    rows, zero_below, subtract = extract()
    check_shape(rows)
    wa = {2025: "令和7年分", 2026: "令和8年分"}[YEAR]
    data = {
        "year": YEAR, "era_year": ERA,
        "source": f"国税庁 {wa} 年末調整のしかた 「{wa}の年末調整等のための給与所得控除後の給与等の金額の表」",
        "source_url": f"https://www.nta.go.jp/publication/pamph/gensen/nencho{YEAR}/pdf/nencho_all.pdf",
        "below_table": {
            "zero_below": zero_below,
            "subtract": subtract,
            "subtract_until": rows[0]["from"],
            "note": f"{zero_below:,}円未満は0。{zero_below:,}円以上{rows[0]['from']:,}円未満は給与等の金額から{subtract:,}円を控除した金額。",
        },
        "above_table": [
            {"from": 6_600_000, "to": 8_500_000, "rate": 0.9, "subtract": 1_100_000,
             "note": "給与等の金額に90%を乗じて算出した金額から1,100,000円を控除した金額(1円未満切捨て)"},
            {"from": 8_500_000, "to": 20_000_000, "rate": 1.0, "subtract": 1_950_000,
             "note": "給与等の金額から1,950,000円を控除した金額"},
        ],
        "not_eligible_from": 20_000_000,
        "rows": rows,
    }
    if "--check" in sys.argv:
        cur = json.loads(OUT.read_text("utf-8"))
        same = cur["rows"] == rows
        print("一致" if same else "不一致", len(rows), "行")
        sys.exit(0 if same else 1)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"{len(rows)} 行 -> {OUT}")


if __name__ == "__main__":
    main()
