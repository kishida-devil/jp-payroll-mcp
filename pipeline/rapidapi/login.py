"""RapidAPI 手動ログイン（初回 / セッション切れ時のみ）。

実ブラウザを開くので、**あなたが手でログインする**。このスクリプトは
パスワードを一切見ないし扱わない。ログイン後のセッションが
rapidapi_profile/ に保存され、以降の出品はそれを再利用する。

    python pipeline/rapidapi/login.py

ログイン完了後に smoke test（プロバイダー画面に入れるか）を実行し、
成功すればパイプライン停止フラグを解除する。
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from playwright.sync_api import Playwright, sync_playwright  # noqa: E402

from config import (  # noqa: E402
    BROWSER_ARGS, BROWSER_CHANNELS, HUB_URL, LOGIN_URL, NAV_TIMEOUT_MS,
    PROFILE_DIR, PROVIDER_URLS, VIEWPORT, signed_out,
)
from notify import notify_discord  # noqa: E402
from pipeline_lock import clear_halt, is_halted  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("rapidapi.login")


def smoke_test(page) -> tuple[bool, str]:
    """プロバイダー画面に入れるかで、セッションが生きているか判定する。

    戻り値: (ok, 到達できたURL or 失敗理由)
    """
    for url in PROVIDER_URLS:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            page.wait_for_timeout(2500)
        except Exception as e:  # noqa: BLE001 - 次の候補を試す
            logger.debug("smoke: %s に到達できず (%s)", url, e)
            continue
        if not signed_out(page.url):
            return True, page.url
        logger.info("smoke: %s → ログイン画面に飛ばされた", url)
    return False, "すべてのプロバイダー画面でログイン画面に飛ばされました"


def launch(playwright: Playwright):
    """実物のChrome → Edge → 同梱Chromium の順で起動を試す。

    OAuth（Google/GitHub）は同梱Chromiumを弾くことがあるので、実ブラウザを優先する。
    """
    last_err = None
    for channel in BROWSER_CHANNELS:
        try:
            ctx = playwright.chromium.launch_persistent_context(
                str(PROFILE_DIR),
                headless=False,
                channel=channel,
                args=BROWSER_ARGS,
                viewport=VIEWPORT,
            )
            logger.info("ブラウザ起動: %s", channel or "bundled chromium")
            return ctx
        except Exception as e:  # noqa: BLE001 - 次の候補を試す
            logger.info("  %s は使えませんでした (%s)", channel or "bundled chromium", str(e)[:80])
            last_err = e
    raise RuntimeError(f"ブラウザを起動できませんでした: {last_err}")


def watch_popups(context) -> None:
    """新しく開いたタブ/ポップアップのURLをコンソールに出す。

    OAuthが空タブで止まったとき、どこで詰まったかを見えるようにする。
    """
    def on_page(p):
        logger.info("[新しいタブ] %s", p.url or "(about:blank)")
        p.on("framenavigated",
             lambda f: logger.info("[遷移] %s", f.url) if f == p.main_frame else None)
    context.on("page", on_page)


def login_flow(playwright: Playwright) -> bool:
    logger.info("ブラウザを起動してRapidAPIを開きます。ブラウザ側でログインしてください。")
    context = launch(playwright)
    watch_popups(context)
    page = context.pages[0] if context.pages else context.new_page()
    try:
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    except Exception as e:  # noqa: BLE001 - 手で開き直せるので致命傷ではない
        logger.warning("ログイン画面を開けませんでした: %s", e)

    print()
    print("─" * 68)
    print("  ブラウザでRapidAPIにログインしてください。")
    print("  このスクリプトは入力内容を一切見ません。")
    print()
    print(f"  ログインが終わったら（{HUB_URL} が普通に見える状態）、")
    print("  このコンソールに戻って Enter を押してください。")
    print("─" * 68)
    input("\n[?] ログインが終わったら Enter > ")

    ok, detail = smoke_test(page)
    context.close()

    if ok:
        logger.info("セッションを %s に保存しました（smoke test OK: %s）", PROFILE_DIR, detail)
        if is_halted():
            clear_halt()
            notify_discord("🟢 RapidAPIログイン復活を確認しました。出品パイプラインを再開します。")
        return True

    logger.error("smoke test 失敗: %s", detail)
    logger.error("ログインが完了していない可能性があります。もう一度実行してください。")
    return False


def main() -> int:
    if PROFILE_DIR.exists():
        logger.info("既存のプロファイルがあります: %s（そのまま引き継ぎます）", PROFILE_DIR)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        ok = login_flow(p)
    if ok:
        print(f"\n完了。セッションは {PROFILE_DIR} にあります。")
        print("このフォルダはRapidAPIアカウントへのアクセス権そのものです。gitignore済みですが、外に出さないでください。\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
