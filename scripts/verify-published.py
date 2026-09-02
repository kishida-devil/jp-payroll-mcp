# -*- coding: utf-8 -*-
"""公開したあとの答え合わせを、1コマンドで。

    python D:\\Claude\\tsumugi\\scripts\\verify-published.py

7反復ぶんの変更を貼ったあと、「本当に世に出たか」を確かめる。
**それぞれの反復で事前に書いた成功条件を、そのまま検査にしてある。**
出なければ「出なかった」と言う。推測で埋めない。

事前に決めた期待値との差だけを見るので、実行する順番も回数も問わない。
シェルを選ばない(cmd.exe / PowerShell / Git Bash のどれでも動く)。
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

UA = {
    "User-Agent": "tsumugi-owner-check",
    "Cache-Control": "no-cache",
}
API = "https://japan-payroll-api.tsumugi.workers.dev"
REPO = "kishida-devil/jp-payroll-mcp"
# 期待する版は package.json から読む。"0.4.2" と決め打ちしていたので、
# 0.4.3 を公開した翌日に「npm の latest が 0.4.2」で落ち、
# MCPレジストリが 0.4.2 のまま(=まだ出ていない)なのに緑になっていた。
# 逆向きの誤り2つ。期待値は手で書かず、公開したいものそのものから取る。
from pathlib import Path
PKG_VERSION = json.loads(
    (Path(__file__).resolve().parent.parent / "mcp" / "package.json").read_text("utf-8")
)["version"]

results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    results.append((ok, label, detail))


def fetch(url: str, headers: dict | None = None, data: bytes | None = None):
    h = dict(UA)
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h, data=data)
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")
    except Exception as e:  # 到達できないのも結果のうち
        return None, None, f"{type(e).__name__}: {e}"


def ja_ratio(t: str) -> float:
    n = sum(1 for c in t if "\u3040" <= c <= "\u30ff" or "\u4e00" <= c <= "\u9fff")
    return n / max(len(t), 1)


# --- 収益13: npm のパッケージ頁が日本語で始まる ---------------------------
status, _, body = fetch("https://registry.npmjs.org/jp-payroll-mcp")
if status == 200:
    pkg = json.loads(body)
    latest = pkg["dist-tags"]["latest"]
    check(latest == PKG_VERSION, f"npm の latest が {PKG_VERSION}", latest)
    readme = pkg["versions"].get(latest, {}).get("readme") or pkg.get("readme", "")
    head = readme[:1200]
    check(ja_ratio(head) > 0.25, "npm が描画する README が日本語で始まる",
          f"{round(ja_ratio(head) * 100)}%")
    check("README.en.md" in head, "そして英語話者の行き先が最初の画面にある")
else:
    check(False, "npm レジストリに到達", str(status))

# --- 収益14: 着地頁と、APIを壊していないこと -------------------------------
status, hdr, body = fetch(API + "/", {"Accept": "text/html,application/xhtml+xml"})
ctype = (hdr.get("content-type") if hdr else "") or ""
is_html = status == 200 and "text/html" in ctype
check(is_html, "ブラウザには頁を返す", f"{status} {ctype}")
# **HTMLが返っていないときに「日本語だ」と言ってはいけない。**
# 生JSONも日本語なので、条件を付けないと間違った理由で緑になる。実際なった。
# 先頭2,000バイトは <head> と CSS で、本文に届いていなかった。
# 日本語の頁を「8%」と報告して落としていた。タグを外してから数える。
_visible = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", body)
_visible = re.sub(r"<[^>]+>", " ", _visible)
check(is_html and ja_ratio(_visible) > 0.25, "その頁が日本語である",
      f"本文 {round(ja_ratio(_visible) * 100)}%" if is_html else "まだHTMLではない")

status, hdr, body = fetch(API + "/")
ctype = (hdr.get("content-type") if hdr else "") or ""
check(status == 200 and "application/json" in ctype,
      "APIクライアントには今までどおり JSON", f"{status} {ctype}")
if "application/json" in ctype:
    check("endpoints" in json.loads(body), "そして中身が壊れていない")

status, _, body = fetch(API + "/sitemap.xml")
check(status == 200 and "<urlset" in body, "sitemap.xml が返る", str(status))
status, _, body = fetch(API + "/robots.txt")
check(status == 200 and "Sitemap:" in body, "robots.txt が sitemap を指す", str(status))

# --- 収益15: 課金点に値段が出ている -----------------------------------------
payload = json.dumps({
    "employees": [{"prefecture": "Tokyo", "monthly_salary": 300000, "age": 40}] * 50
}).encode("utf-8")
status, _, body = fetch(API + "/v1/payroll/batch",
                        {"Content-Type": "application/json"}, payload)
check(status == 400, "50人のバッチは無料枠で断られる", str(status))
if status == 400:
    d = json.loads(body)
    text = json.dumps(d, ensure_ascii=False)
    # 全角の 4 で書いていた。実物は半角。出ているものを出ていないと報告していた。
    check(("\u67084\u30c9\u30eb" in text or "\u6708\uff14\u30c9\u30eb" in text), "断りの文に値段が入っている",
          (d.get("hint") or "")[:70])
    check("30,000" in text, "そして何が買えるかも")

# --- 収益19: GitHub の description が日本語で、検索に出る -------------------
status, _, body = fetch(f"https://api.github.com/repos/{REPO}",
                        {"Accept": "application/vnd.github+json"})
if status == 200:
    desc = json.loads(body).get("description") or ""
    check(ja_ratio(desc) > 0.3, "GitHub の説明文が日本語", f"{round(ja_ratio(desc) * 100)}%")
    check("\u7d66\u4e0e\u8a08\u7b97" in desc, "そして検索語が入っている")
else:
    check(False, "GitHub API に到達", str(status))

# 事前に書いた反証可能な予測。出なければ「description では足りない」と分かる。
for term, before in (("\u7d66\u4e0e\u8a08\u7b97", 82), ("\u6a19\u6e96\u5831\u916c\u6708\u984d", 4)):
    q = urllib.parse.quote(term)
    status, _, body = fetch(
        f"https://api.github.com/search/repositories?q={q}&per_page=30",
        {"Accept": "application/vnd.github+json"})
    if status != 200:
        check(False, f"GitHub 検索「{term}」", str(status))
        continue
    # per_page=30 では上位30件しか見ていなかった。83件中82位に出ているのに
    # 「出ていない」と報告した。**順位が低いのと載っていないのは違う。**
    # 1頁目だけ per_page=30、2頁目から 100 にしていたので 31〜100位が飛んだ。
    # 82位にいるものを「上位300件に無い」と報告した。刻みを揃える。
    total = json.loads(body)["total_count"]
    rank = None
    for page in (1, 2, 3):
        st2, _, b2 = fetch(
            f"https://api.github.com/search/repositories?q={q}&per_page=100&page={page}",
            {"Accept": "application/vnd.github+json"})
        if st2 != 200:
            break
        n2 = [i["full_name"] for i in json.loads(b2)["items"]]
        if REPO in n2:
            rank = (page - 1) * 100 + n2.index(REPO) + 1
            break
        if len(n2) < 100:
            break
    check(rank is not None, f"GitHub 検索「{term}」に出る",
          f"{total}件中 {rank}位 (公開前は{before}件)" if rank
          else f"{total}件 (公開前は{before}件) — 上位300件に無い")

# --- 収益17: MCP が公開版で価格を伝える -------------------------------------
status, _, body = fetch(f"https://registry.npmjs.org/jp-payroll-mcp/{PKG_VERSION}")
check(status == 200, f"npm に {PKG_VERSION} が存在する", str(status))

# 検索エンドポイント(?search=)はキャッシュが古く、0.4.3 を登録した直後も
# 0.4.2 を isLatest:true で返した。出ているものを「出ていない」と言う向きの誤り。
# その名前の版一覧(/servers/<name>/versions)はその場で 0.4.3 を latest と返す。
# 名指しできるものは、検索ではなく名指しで取る。
status, _, body = fetch(
    "https://registry.modelcontextprotocol.io/v0/servers/"
    + urllib.parse.quote("io.github.kishida-devil/jp-payroll-mcp", safe="")
    + "/versions")
# 「本文に 0.4.2 が含まれるか」では、なぜ落ちたのかが分からなかった。
# 実際は 0.4.2 が active で latest だったのに 200 とだけ出て落ちていた。
# どの版が latest かを名指しで見る。
reg_latest = None
if status == 200:
    for sv in json.loads(body).get("servers", []):
        srv = sv.get("server", sv)
        meta = sv.get("_meta", {}).get(
            "io.modelcontextprotocol.registry/official", {})
        if meta.get("isLatest"):
            reg_latest = f"{srv.get('version')} ({meta.get('status')})"
check(reg_latest is not None and reg_latest.startswith(PKG_VERSION),
      f"公式MCPレジストリの latest が {PKG_VERSION}", reg_latest or str(status))

# --- 出力 -------------------------------------------------------------------
ok_n = sum(1 for ok, _, _ in results if ok)
print()
for ok, label, detail in results:
    mark = "  OK  " if ok else "  --  "
    print(f"{mark}{label}" + (f"  [{detail}]" if detail else ""))
print()
print(f"  {ok_n} / {len(results)} 件が期待どおり")
if ok_n < len(results):
    print("  -- の行は、まだ世に出ていないか、予測が外れたかのどちらかです。")
sys.exit(0 if ok_n == len(results) else 1)
