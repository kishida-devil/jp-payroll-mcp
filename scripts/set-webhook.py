# -*- coding: utf-8 -*-
"""Discord の Webhook URL を .env に差し替える。

値を画面にもチャットにも出さないための道具。

**伏せ字入力(getpass)には頼らない。**Windows の getpass は msvcrt の低レベル入力を
使うため、Git Bash(mintty)のように実コンソールでない端末では文字が一切届かず、
プロンプトが出たまま固まる。端末の種類で使えたり使えなかったりする入力は、
「URLを差し替える」という一度きりの作業には向かない。

代わりにファイルから読む。どの端末でも同じように動き、値は画面に出ない。

    1) メモ帳などで新しい URL だけを書いたファイルを作る
    2) python scripts/set-webhook.py --from-file <そのファイル>

読み終えたファイルは中身を潰してから削除する(--keep で残せる)。
環境変数 NEW_WEBHOOK_URL でも渡せる。引数も環境変数も無ければ、その場で尋ねる
(端末が伏せ字に対応していなければ、そのまま表示される入力に落とす)。

疎通確認は GET のみ。チャンネルにメッセージは送らない。
**先に疎通を確かめ、通らなければ .env を書き換えない** — 生きている設定を
壊れた値で上書きしないため。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / ".env"
KEY = "DISCORD_WEBHOOK_URL"

# discord.com が現行。discordapp.com は古い表記で、まだ発行済みのものが生きている。
# ptb / canary はテスト用クライアントのホスト。
WEBHOOK_RE = re.compile(
    r"^https://(?:(?:ptb|canary)\.)?discord(?:app)?\.com/api/(?:v\d+/)?webhooks/\d+/[\w-]+/?$"
)


def read_url(args) -> str | None:
    """引数 → 環境変数 → 対話、の順で受け取る。値は返すだけで印字しない。"""
    if args.from_file:
        p = Path(args.from_file)
        if not p.exists():
            print(f"{p} がありません。", file=sys.stderr)
            return None
        return p.read_text(encoding="utf-8-sig").strip()

    env = os.getenv("NEW_WEBHOOK_URL", "").strip()
    if env:
        return env

    print("新しい Webhook URL を貼り付けて Enter を押してください。")
    print("(この端末では入力が表示されることがあります。表示させたくないときは")
    print(" --from-file でファイルから渡してください)")
    try:
        return input("URL: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return None


# Discord は User-Agent の無いリクエストを Cloudflare で弾き、403 を返す。
# これを付けずに 403 を「Webhook が無効」と読むと、生きている設定を無効と誤診する。
# 実際そう誤診した。
UA = "jp-payroll-mcp-setup/1.0 (+https://github.com/kishida-devil/jp-payroll-mcp)"


def check(url: str) -> tuple[bool, str]:
    """GET だけ投げる。Webhook の情報が返れば有効。メッセージは送らない。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=15) as r:
            body = json.load(r)
        return True, f"{r.status} 有効 — Webhook名: {body.get('name') or '(名前なし)'}"
    except urllib.error.HTTPError as e:
        if e.code in (401, 404):
            return False, f"{e.code} 無効 — この URL の Webhook は存在しません(再発行後の古い URL かもしれません)"
        if e.code == 403:
            return False, ("403 — Discord に拒否されました。UA は付けています。"
                           "ネットワーク側(社内プロキシ等)で遮断されている可能性があります")
        return False, f"{e.code} 想定外の応答"
    except Exception as e:  # noqa: BLE001 — 到達不能もDNSも同じ扱いでよい
        return False, f"確認できず: {type(e).__name__}"


def shred(p: Path) -> None:
    """読み終えた一時ファイルを潰す。消すだけだと中身がディスクに残る。"""
    try:
        size = p.stat().st_size
        io.open(p, "w", encoding="utf-8").write("x" * max(size, 1))
        p.unlink()
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Discord Webhook URL を .env に差し替える")
    ap.add_argument("--from-file", help="URL だけを書いたファイル")
    ap.add_argument("--keep", action="store_true", help="--from-file のファイルを消さない")
    args = ap.parse_args(argv)

    if not ENV.exists():
        print(f"{ENV} がありません。", file=sys.stderr)
        return 1

    url = read_url(args)
    if url is None:
        return 1
    url = url.strip().strip('"').strip("'")
    if not url:
        print("入力が空です。中止しました。", file=sys.stderr)
        return 1
    if not WEBHOOK_RE.match(url):
        # URL は出さない。長さと先頭の形だけで見当がつくようにする。
        looks = "https://" if url.startswith("https://") else "https:// で始まっていない"
        print(f"Discord の Webhook URL の形ではありません(長さ {len(url)}、{looks})。",
              file=sys.stderr)
        print("期待する形: https://discord.com/api/webhooks/<数字>/<英数字>", file=sys.stderr)
        return 1

    ok, msg = check(url)
    print(f"疎通: {msg}")
    if not ok:
        print(".env は変更していません。", file=sys.stderr)
        return 1

    text = io.open(ENV, encoding="utf-8").read()
    if re.search(rf"^{KEY}=.*$", text, re.M):
        text = re.sub(rf"^{KEY}=.*$", f"{KEY}={url}", text, count=1, flags=re.M)
    else:
        text = text.rstrip("\n") + f"\n{KEY}={url}\n"
    io.open(ENV, "w", encoding="utf-8", newline="").write(text)
    print(f"{ENV.name} を更新しました。監視の通知先が復活しています。")

    if args.from_file and not args.keep:
        shred(Path(args.from_file))
        print(f"{args.from_file} は中身を潰して削除しました。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
