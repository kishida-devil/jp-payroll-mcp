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
    check(latest == "0.4.2", "npm の latest が 0.4.2", latest)
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
check(is_html and ja_ratio(body[:2000]) > 0.15, "その頁が日本語である",
      f"{round(ja_ratio(body[:2000]) * 100)}%" if is_html else "まだHTMLではない")

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
    check("\u6708\uff14\u30c9\u30eb" in text, "断りの文に値段が入っている",
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
    d = json.loads(body)
    names = [i["full_name"] for i in d["items"]]
    check(REPO in names, f"GitHub 検索「{term}」に出る",
          f"{d['total_count']}件 (公開前は{before}件)")

# --- 収益17: MCP が公開版で価格を伝える -------------------------------------
status, _, body = fetch("https://registry.npmjs.org/jp-payroll-mcp/0.4.2")
check(status == 200, "npm に 0.4.2 が存在する", str(status))

status, _, body = fetch(
    "https://registry.modelcontextprotocol.io/v0/servers?search=jp-payroll")
check(status == 200 and "0.4.2" in body, "公式MCPレジストリが 0.4.2 を持つ", str(status))

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
