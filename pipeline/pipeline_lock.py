"""パイプライン停止フラグ（maintenance flag）。

セッション切れ等で出品が詰まったとき、**生成・デプロイ・出品**のすべてを
即止めるための単一フラグファイル。人間が解除するまで自動では戻らない。

設計:
- `state/pipeline.halt.json` の存在 = 停止中
- atomic write (tmp → os.replace) で半端なファイルを残さない
- 解除はファイル削除のみ（auto-expire なし）

使い方:
    from pipeline_lock import ensure_not_halted, set_halt, clear_halt

    ensure_not_halted()                       # halt中なら exit(2)
    set_halt(reason="rapidapi_session_expired",
             message="npm run rapidapi:login で再ログインしてください")
    clear_halt()                              # 再ログイン成功後

AI_Kindle プロジェクトの code/pipeline_lock.py と同じ作法。
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import socket
import sys
from pathlib import Path
from typing import Optional

_REPO_ROOT = Path(__file__).resolve().parent.parent
_STATE_DIR = _REPO_ROOT / "state"
HALT_FILE = _STATE_DIR / "pipeline.halt.json"

_EXIT_HALTED = 2

logger = logging.getLogger(__name__)


def is_halted() -> bool:
    return HALT_FILE.exists()


def read_halt() -> Optional[dict]:
    if not HALT_FILE.exists():
        return None
    try:
        return json.loads(HALT_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 壊れていても「停止中」の事実は変わらない
        return {"reason": "unreadable", "message": "halt ファイルが読めません"}


def set_halt(*, reason: str, message: str = "") -> None:
    """停止フラグを立てる。既に立っている場合は上書きしない（初回の理由を残す）。"""
    if HALT_FILE.exists():
        logger.info("[halt] 既に停止中のため上書きしません (reason=%s)", reason)
        return
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "reason": reason,
        "message": message,
        "at": datetime.datetime.now().astimezone().isoformat(),
        "pid": os.getpid(),
        "host": socket.gethostname(),
    }
    tmp = HALT_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, HALT_FILE)
    logger.warning("[halt] パイプラインを停止しました: %s / %s", reason, message)


def clear_halt() -> bool:
    """停止フラグを解除。解除したら True、元から無ければ False。"""
    if not HALT_FILE.exists():
        return False
    HALT_FILE.unlink()
    logger.info("[halt] 停止フラグを解除しました")
    return True


def ensure_not_halted() -> None:
    """各エントリポイントの先頭で呼ぶ。halt中なら exit(2)。"""
    info = read_halt()
    if info is None:
        return
    logger.error(
        "[halt] 停止中のため実行しません。reason=%s message=%s at=%s",
        info.get("reason"), info.get("message"), info.get("at"),
    )
    logger.error("[halt] 解除するには %s を削除してください", HALT_FILE)
    sys.exit(_EXIT_HALTED)
