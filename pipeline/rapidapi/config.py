"""RapidAPI 出品自動化の共通設定。

ブラウザは Playwright の launch_persistent_context を使い、専用プロファイルに
セッションを保存する（AI_Kindle の kdp_profile と同じ方式）。

**KDP のプロファイルとは共有しない。** 本業の自動投稿を巻き込まないため、
RapidAPI 専用のプロファイルを別に持つ。
"""
from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# ブラウザプロファイル（Cookie/セッションの実体）
PROFILE_DIR = REPO_ROOT / "rapidapi_profile"

# 状態ファイル
STATE_DIR = REPO_ROOT / "state"
PUBLISH_LOG = STATE_DIR / "rapidapi_publish_log.json"

# 生成した OpenAPI spec の置き場
SPEC_DIR = REPO_ROOT / "build" / "openapi"

# --- URL ---
HUB_URL = "https://rapidapi.com/hub"
LOGIN_URL = "https://rapidapi.com/auth/login"
# プロバイダー側の入口。/provider は /provider/<PROVIDER_ID>/ に飛ぶ。
# 実測(2026-08-25): /my-apis は404。正解は /provider または /studio。
PROVIDER_ID = "12268965"
PROVIDER_URLS = (
    f"https://rapidapi.com/provider/{PROVIDER_ID}/",
    "https://rapidapi.com/provider",
    "https://rapidapi.com/studio",
)

# --- 出品ペース ---
# 規約に自動化の禁止条項は無いが、「サービスの完全性や性能を妨害しない」義務は
# あるうえ、Rapid は裁量でアカウントを停止できる。人間と同程度の頻度に抑える。
MAX_PUBLISH_PER_DAY = 2
MIN_SECONDS_BETWEEN_PUBLISH = 90

# --- ブラウザ ---
# 同梱Chromiumだと Google/GitHub の OAuth が「安全でないブラウザ」として弾かれ、
# ポップアップが空タブのまま止まる。実物の Chrome を優先し、無ければ同梱に落とす。
BROWSER_CHANNELS = ("chrome", "msedge", None)

BROWSER_ARGS = [
    "--lang=en-US",
    # navigator.webdriver を消す。OAuth 側の自動化検出でよく見られる。
    "--disable-blink-features=AutomationControlled",
]
VIEWPORT = {"width": 1400, "height": 900}
NAV_TIMEOUT_MS = 30_000


def signed_out(url: str) -> bool:
    """URL がログイン画面に落ちているか。"""
    u = (url or "").lower()
    return "/auth/login" in u or "/auth/sign-up" in u or "/login" in u
