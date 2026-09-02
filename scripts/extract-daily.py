"""国税庁の日額表(.xls)から src/data/withholding-daily-r8.json を作る。

    curl -L -A "Mozilla/5.0" -o build/raw/08-14.xls \
      https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/08-14.xls
    python scripts/extract-daily.py

月額表との違いは丙欄があること。丙欄は日雇労働者や短期雇用者に使い、
甲乙とは別のアンカーと税率を持つ。列の並び:

    0=通番 1=以上 2=未満 3..10=甲(扶養0〜7人) 11=乙 12=丙
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import xlrd

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "build" / "raw" / "08-14.xls"
OUT = REPO / "src" / "data" / "withholding-daily-r8.json"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

YEN = re.compile(r"^([\d,]+)円$")
RATE = re.compile(r"([\d,]+)円を超える金額の([\d.]+)％")
KOU_COLS = list(range(3, 11))
OTSU_COL, HEI_COL = 11, 12



def below_min_otsu_rate(sh):
    """最下段の乙欄セルから率を読む。数値ではなく文章で入っている。"""
    for r in range(min(sh.nrows, 30)):
        for c in range(sh.ncols):
            v = str(sh.cell_value(r, c))
            # アンカーの文も「…相当する金額を加算した金額」と書く。あちらは必ず
            # 「◯◯円を超える金額の」を含むので、それを除くと最下段だけが残る。
            if "相当する金額" not in v or "超える" in v:
                continue
            m = re.search(r"([0-9]+\.[0-9]+)\s*[%％]", v)
            if m:
                return round(float(m.group(1)) / 100, 5)
    raise SystemExit("最下段の乙欄に率が見つかりません。表の形が変わった可能性があります")

def num(v):
    return int(v) if isinstance(v, (int, float)) and v else None


def main() -> int:
    if not SRC.exists():
        print(f"元ファイルがありません: {SRC}", file=sys.stderr)
        return 1
    sh = xlrd.open_workbook(str(SRC)).sheet_by_index(0)

    brackets = []
    for r in range(sh.nrows):
        seq, lo, hi = num(sh.cell_value(r, 0)), num(sh.cell_value(r, 1)), num(sh.cell_value(r, 2))
        if seq is None or lo is None or hi is None:
            continue
        otsu, hei = num(sh.cell_value(r, OTSU_COL)), sh.cell_value(r, HEI_COL)
        if otsu is None:
            continue
        brackets.append({
            "from": lo, "to": hi,
            "kou": [num(sh.cell_value(r, c)) or 0 for c in KOU_COLS],
            "otsu": otsu,
            "hei": int(hei) if isinstance(hei, (int, float)) else 0,
        })

    anchors = []
    for r in range(sh.nrows):
        m = YEN.match(str(sh.cell_value(r, 1)).strip())
        if not m:
            continue
        amount = int(m.group(1).replace(",", ""))
        kou = [num(sh.cell_value(r, c)) for c in KOU_COLS]
        if any(k is None for k in kou):
            continue
        entry = {"amount": amount, "kou": kou}
        for label, col in (("otsu", OTSU_COL), ("hei", HEI_COL)):
            v = num(sh.cell_value(r, col))
            if v is not None:
                entry[label] = v
        # このアンカーを超えたときの税率を、直後の数行から拾う
        for rr in range(r, min(r + 14, sh.nrows)):
            for c in range(sh.ncols):
                mm = RATE.search(str(sh.cell_value(rr, c)))
                if not mm or int(mm.group(1).replace(",", "")) != amount:
                    continue
                rate = float(mm.group(2)) / 100
                key = ("otsu_rate_above" if c == OTSU_COL
                       else "hei_rate_above" if c == HEI_COL
                       else "kou_rate_above")
                entry.setdefault(key, rate)
        # 乙・丙の「基準額+率」は本文中に額が書かれている場合がある
        for rr in range(r, min(r + 14, sh.nrows)):
            for col, label in ((OTSU_COL, "otsu"), (HEI_COL, "hei")):
                txt = str(sh.cell_value(rr, col))
                mm = re.match(r"^([\d,]+)円に、", txt)
                if mm and f"{label}_base_above" not in entry:
                    if RATE.search(txt) and int(RATE.search(txt).group(1).replace(",", "")) == amount:
                        entry[f"{label}_base_above"] = int(mm.group(1).replace(",", ""))
        anchors.append(entry)

    # --- 検証 ---
    if len(brackets) < 200:
        print(f"区間が少なすぎます: {len(brackets)}", file=sys.stderr)
        return 1
    for a, b in zip(brackets, brackets[1:]):
        if a["to"] != b["from"]:
            print(f"区間が連続していません: {a['to']} -> {b['from']}", file=sys.stderr)
            return 1
    for b in brackets:
        if any(b["kou"][i] < b["kou"][i + 1] for i in range(7)):
            print(f"甲欄が扶養人数に対して逆転: {b}", file=sys.stderr)
            return 1
    if not anchors:
        print("アンカーが取れませんでした", file=sys.stderr)
        return 1

    payload = {
        "meta": {
            "label": "給与所得の源泉徴収税額表 日額表",
            "year": "令和8年分 (2026)",
            "source": "国税庁 令和8年分 源泉徴収税額表",
            "source_url": "https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/01.htm",
            "licence": "公共データ利用規約(第1.0版)",
            "attribution_ja": "出典：国税庁ホームページを加工して作成",
            "includes_reconstruction_surtax": True,
            "columns": {
                "kou": "扶養控除等申告書の提出がある人",
                "otsu": "提出がない人",
                "hei": "日雇労働者・短期雇用者(丙欄)",
            },
        },
        "rules": {
            # **乙欄を書き忘れていた。**最下段の乙欄は額ではなく率で、シートには
            # 「その日の社会保険料等控除後の給与等の金額の3.063%に相当する金額」と
            # 文章で入っている。数値セルだけを拾っていたので丸ごと落ち、0円になった。
            # 月額表(105,000円未満)と同じ形。率は本文から読み、見つからなければ止める。
            "below_minimum": {
                "threshold": brackets[0]["from"], "kou": 0, "hei": 0,
                "otsu_rate": below_min_otsu_rate(sh),
                "note": f"{brackets[0]['from']:,}円未満は甲欄・丙欄0円、乙欄は金額の3.063%",
            },
            "dependants_over_seven_deduction": 50,
            "max_dependants_in_table": 7,
        },
        "brackets": brackets,
        "high_income_anchors": anchors,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"区間 {len(brackets)}件 / アンカー {len(anchors)}件 -> {OUT} ({OUT.stat().st_size:,} bytes)")
    print(f"  範囲: {brackets[0]['from']:,} 〜 {brackets[-1]['to']:,}")
    print("  アンカー: " + ", ".join(f"{a['amount']:,}" for a in anchors))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
