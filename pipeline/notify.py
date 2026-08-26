"""Discord Webhook による通知ユーティリティ。

.env の DISCORD_WEBHOOK_URL を使って簡易 POST する。
URL未設定なら何もせず成功扱い（開発環境やCI向けに無害）。

AI_Kindle プロジェクトの code/notify.py と同じ作法。
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv

# REPO_ROOT/.env を明示指定する（find_dotenv だと途中の .env を拾う恐れがある）
_REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_REPO_ROOT / ".env")

logger = logging.getLogger(__name__)

_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "").strip()


def notify_discord(message: str, *, username: Optional[str] = "tsumugi Bot") -> bool:
    """Discordチャンネルにテキストを送る。成功ならTrue。

    - URL未設定時はログに出すだけで True を返す（処理を止めない）
    - 2000文字制限があるので超えたら切る
    - 送信失敗は例外を吐かずログ警告に留める
    """
    url = (_WEBHOOK_URL or os.getenv("DISCORD_WEBHOOK_URL", "")).strip()
    if not url:
        logger.info("[notify] DISCORD_WEBHOOK_URL 未設定。通知スキップ: %s", message[:120])
        return True
    payload = {"content": message[:1900], "username": username or "tsumugi Bot"}
    try:
        r = requests.post(url, json=payload, timeout=10)
        if r.status_code >= 300:
            logger.warning("[notify] Discord応答 %s: %s", r.status_code, r.text[:200])
            return False
        return True
    except Exception as e:  # noqa: BLE001 - 通知失敗で本処理を止めない
        logger.warning("[notify] Discord送信失敗: %s", e)
        return False
