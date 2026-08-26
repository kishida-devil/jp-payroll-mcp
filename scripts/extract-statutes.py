"""このAPIが引用している条文の本文を e-Gov 法令API から取得して同梱する。

    python scripts/extract-statutes.py

コード中の引用がすべて PROVISIONS に登録されているかは test/verify.mjs が確認する。
同じ名寄せロジックを Python にも持つと、実行時の解決器と乖離したときに気づけない。

判定エンドポイントは「健康保険法第43条による」と根拠を示すが、条文番号だけ返しても
利用者は e-Gov を開き直すことになる。本文まで返せば、答えと根拠が1往復で揃う。

同梱する理由は速度ではなく、e-Gov を実行時に叩くと、あちらが落ちたときにこちらも
落ちるため。データは他のデータセットと同じくビルド時に固定する。

出典: e-Gov法令検索(デジタル庁)。政府標準利用規約(第2.0版)、CC BY 4.0 互換で、
出典明示を条件に商用利用・改変・再配布が可能。2024年7月に公共データ利用規約
(第1.0版)へ移行しており、本APIが厚労省・国税庁データに用いているものと同じ。
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request

API = "https://laws.e-gov.go.jp/api/2/law_data/{law_id}?law_full_text_format=json&elm={elm}"
VIEW = "https://laws.e-gov.go.jp/law/{law_id}#Mp-At_{anchor}"

LAWS = {
    "健康保険法": "211AC0000000070",
    "健康保険法施行規則": "215M10000008036",
    "厚生年金保険法": "329AC0000000115",
    "労働保険の保険料の徴収等に関する法律": "344AC0000000084",
    "子ども・子育て支援法": "424AC0000000065",
    "民法": "129AC0000000089",
    "年齢計算ニ関スル法律": "135AC1000000050",
    "銀行法施行令": "357CO0000000040",
}

# 引用している条文。ここが唯一の名寄せ点で、コード側の引用文字列はすべてこの
# キーに一致していなければならない(test/verify.mjs が突き合わせる)。
#
# 年齢計算ニ関スル法律は条ではなく項だけで構成されているため、elm を個別に持つ。
PROVISIONS: list[tuple[str, str, str]] = [
    # (canonical ref, law, elm)
    ("健康保険法第3条", "健康保険法", "Article_3"),
    ("健康保険法第36条", "健康保険法", "Article_36"),
    ("健康保険法第41条", "健康保険法", "Article_41"),
    ("健康保険法第42条", "健康保険法", "Article_42"),
    ("健康保険法第43条", "健康保険法", "Article_43"),
    ("健康保険法第43条の2", "健康保険法", "Article_43_2"),
    ("健康保険法第43条の3", "健康保険法", "Article_43_3"),
    ("健康保険法第44条", "健康保険法", "Article_44"),
    ("健康保険法第156条", "健康保険法", "Article_156"),
    ("健康保険法第159条", "健康保険法", "Article_159"),
    ("健康保険法第159条の3", "健康保険法", "Article_159_3"),
    ("健康保険法第167条", "健康保険法", "Article_167"),
    ("健康保険法施行規則第24条の2", "健康保険法施行規則", "Article_24_2"),
    ("健康保険法施行規則第135条", "健康保険法施行規則", "Article_135"),
    ("厚生年金保険法第9条", "厚生年金保険法", "Article_9"),
    ("厚生年金保険法第14条", "厚生年金保険法", "Article_14"),
    ("厚生年金保険法第21条", "厚生年金保険法", "Article_21"),
    ("厚生年金保険法第22条", "厚生年金保険法", "Article_22"),
    ("厚生年金保険法第23条", "厚生年金保険法", "Article_23"),
    ("厚生年金保険法第23条の2", "厚生年金保険法", "Article_23_2"),
    ("厚生年金保険法第23条の3", "厚生年金保険法", "Article_23_3"),
    ("厚生年金保険法第81条の2", "厚生年金保険法", "Article_81_2"),
    ("厚生年金保険法第81条の2の2", "厚生年金保険法", "Article_81_2_2"),
    ("労働保険徴収法第11条", "労働保険の保険料の徴収等に関する法律", "Article_11"),
    ("子ども・子育て支援法第70条", "子ども・子育て支援法", "Article_70"),
    ("民法第143条", "民法", "Article_143"),
    ("年齢計算ニ関スル法律", "年齢計算ニ関スル法律", "Paragraph_1"),
    ("銀行法施行令第5条", "銀行法施行令", "Article_5"),
]

ATTRIBUTION = {
    "source": "e-Gov法令検索 (デジタル庁)",
    "source_url": "https://laws.e-gov.go.jp/",
    "api": "法令API Version 2",
    "licence": "公共データ利用規約(第1.0版) / 政府標準利用規約(第2.0版)。CC BY 4.0 互換。",
    "attribution_ja": "出典：e-Gov法令検索（デジタル庁）",
    "note": "条文は取得時点で施行されている版。未施行の改正は含まない。",
}


def fetch(law_id: str, elm: str) -> dict:
    url = API.format(law_id=law_id, elm=elm)
    req = urllib.request.Request(url, headers={"User-Agent": "tsumugi-extract/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def flatten(node, out: list[str]) -> None:
    """条文ツリーから本文だけを拾う。番号・見出しは別に持つので落とす。"""
    if isinstance(node, str):
        out.append(node)
        return
    if not isinstance(node, dict):
        return
    if node.get("tag") in {"ArticleTitle", "ParagraphNum", "ArticleCaption", "ItemTitle"}:
        return
    for c in node.get("children", []):
        flatten(c, out)


def text_of(node) -> str:
    out: list[str] = []
    flatten(node, out)
    return "".join(out).strip()


def find(node, tag: str) -> list:
    found = []
    if isinstance(node, dict):
        if node.get("tag") == tag:
            found.append(node)
        for c in node.get("children", []):
            found += find(c, tag)
    return found


def caption_of(node) -> str | None:
    caps = find(node, "ArticleCaption")
    if not caps:
        return None
    out: list[str] = []
    for c in caps[0].get("children", []):
        if isinstance(c, str):
            out.append(c)
    return "".join(out).strip() or None


def build() -> dict:
    laws: dict[str, dict] = {}
    provisions: dict[str, dict] = {}

    for ref, law, elm in PROVISIONS:
        law_id = LAWS[law]
        try:
            data = fetch(law_id, elm)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"{ref}: e-Gov が HTTP {e.code} を返しました ({law_id} / {elm})。"
                             " 条番号か elm の形式を確認してください。")
        time.sleep(0.4)  # 短時間に大量のリクエストを送らないこと、と案内されている

        rev = data.get("revision_info") or {}
        info = data.get("law_info") or {}
        if law not in laws:
            laws[law] = {
                "law_id": law_id,
                "title": rev.get("law_title"),
                "abbrev": rev.get("abbrev"),
                "law_num": info.get("law_num"),
                "enforced_from": rev.get("amendment_enforcement_date"),
                "url": f"https://laws.e-gov.go.jp/law/{law_id}",
            }

        body = data.get("law_full_text")
        paragraphs = []
        for p in find(body, "Paragraph"):
            t = text_of(p)
            if t:
                paragraphs.append({"num": int(p.get("attr", {}).get("Num", 1)), "text": t})

        full = text_of(body)
        if not full:
            raise SystemExit(f"{ref}: 本文が空です。取得結果の構造が変わった可能性があります。")

        anchor = elm.replace("Article_", "").replace("Paragraph_", "")
        provisions[ref] = {
            "law": law,
            "caption": caption_of(body),
            "text": full,
            **({"paragraphs": paragraphs} if len(paragraphs) > 1 else {}),
            "url": VIEW.format(law_id=law_id, anchor=anchor),
        }
        print(f"  {ref:<34} {len(full):>5} chars"
              + (f"  {len(paragraphs)} 項" if len(paragraphs) > 1 else ""))

    return {"meta": ATTRIBUTION, "laws": laws, "provisions": provisions}


def main() -> int:
    argparse.ArgumentParser(description="引用条文の本文を e-Gov から取得する").parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(here, "..", "src", "data", "statutes.json")

    print(f"fetching {len(PROVISIONS)} provisions from e-Gov ...\n")
    data = build()
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(target, "w", encoding="utf-8") as f:
        f.write(encoded)
    print(f"\nwrote {target} ({len(encoded.encode('utf-8'))} bytes,"
          f" {len(data['provisions'])} provisions, {len(data['laws'])} laws)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
