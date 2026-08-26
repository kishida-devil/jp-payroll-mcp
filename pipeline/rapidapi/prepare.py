"""出品の一歩手前まで自動でやる。

  1. レシピを読む
  2. OpenAPI spec を生成する
  3. **本番APIを実際に叩いて、spec に書いた全エンドポイントが生きているか確認する**
     （レシピと実装のズレを、出品前にここで潰す）
  4. Discord に「出品してください」通知を出す。貼る値も全部そこに書く

使い方:
    python pipeline/rapidapi/prepare.py jp-payroll
    python pipeline/rapidapi/prepare.py --all

reCAPTCHA v3 があるため、フォーム送信だけは人間がやる。
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Windows の既定コンソールは cp932 で、絵文字も一部の記号も出せない。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - 出力先がリダイレクトされている場合など
        pass

from config import PROVIDER_ID, STATE_DIR  # noqa: E402
from notify import notify_discord  # noqa: E402
from openapi_build import RECIPES_DIR, RecipeError, load_recipe, write_spec  # noqa: E402
from pipeline_lock import ensure_not_halted  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("rapidapi.prepare")

READY_LOG = STATE_DIR / "ready_to_list.json"
ADD_API_URL = f"https://rapidapi.com/provider/{PROVIDER_ID}/new"
TIMEOUT = 20


MAX_BODY = 4_000_000  # これを超えるレスポンスは設計がおかしいので落とす


def _get(url: str) -> tuple[int, str]:
    """レスポンス全文を返す。切り詰めるとJSON検証が偽陽性になるので全部読む。"""
    req = urllib.request.Request(url, headers={"User-Agent": "tsumugi-prepare/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                return r.status, f"__TOO_LARGE__ ({len(raw)} bytes 超)"
            return r.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)[:200]


def _post(url: str, payload: dict) -> tuple[int, str]:
    """POST 版。GET と同じく全文を返す。"""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"User-Agent": "tsumugi-prepare/1.0", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                return r.status, f"__TOO_LARGE__ ({len(raw)} bytes)"
            return r.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)[:200]


_ANSI = __import__("re").compile(r"\x1b\[[0-9;]*m")


def lint_spec(path: Path) -> tuple[bool, str]:
    """Redocly で OpenAPI として妥当か検証する。

    RapidAPI に弾かれてから気づくと手戻りなので、出品前にここで落とす。
    redocly が使えない環境ではスキップする（検証できないことは失敗ではない）。
    """
    import shutil
    import subprocess

    if not shutil.which("npx"):
        logger.warning("npx が無いため spec の lint をスキップします")
        return True, ""
    try:
        r = subprocess.run(
            ["npx", "--yes", "@redocly/cli@latest", "lint", str(path)],
            capture_output=True, text=True, timeout=180, shell=(sys.platform == "win32"),
            encoding="utf-8", errors="replace",
        )
    except Exception as e:  # noqa: BLE001 - lint 不能は失敗扱いにしない
        logger.warning("lint を実行できませんでした: %s", e)
        return True, ""
    out = _ANSI.sub("", (r.stdout or "") + (r.stderr or ""))
    if r.returncode == 0:
        logger.info("  lint ok  (OpenAPI 3.0 として妥当)")
        return True, out
    return False, out.strip()


def verify_live(recipe: dict, smoke: dict[str, str]) -> tuple[bool, list[str]]:
    """spec の全パスが本番で 200 を返し、JSON を返すか確認する。"""
    base = recipe["base_url"].rstrip("/")
    problems: list[str] = []
    for ep in recipe["endpoints"]:
        path = ep["path"]
        method = ep.get("method", "get").lower()
        if method == "post":
            # POST は spec に載せた body_example をそのまま叩く。例が本番で通らない
            # なら spec が嘘をついているので、出品前に止める。
            if not ep.get("body_example"):
                problems.append(f"{path}: POST なのに body_example がありません")
                continue
            status, body = _post(f"{base}{path}", ep["body_example"])
        else:
            qs = smoke.get(path)
            if qs is None:
                problems.append(f"{path}: SMOKE_QUERIES に定義がありません")
                continue
            status, body = _get(f"{base}{'' if path == '/' else path}{qs}")
        if status != 200:
            problems.append(f"{path}: HTTP {status} ({body[:80]})")
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as e:
            problems.append(f"{path}: JSONとして壊れている ({e})")
            continue
        if not isinstance(payload, dict) or not payload:
            problems.append(f"{path}: JSONオブジェクトが返っていない")
            continue
        # 宣言した必須パラメータを外したら 400 が返ること（仕様と実装の一致確認）
        if method == "post":
            required = list(ep.get("body", {}).get("required", []))
            if required:
                bare, _ = _post(f"{base}{path}", {})
                if bare != 400:
                    problems.append(f"{path}: 空のbodyなのに HTTP {bare}（400のはず）")
                    continue
        else:
            required = [p["name"] for p in ep.get("params", []) if p.get("required")]
            if required:
                bare, _ = _get(f"{base}{'' if path == '/' else path}")
                if bare != 400:
                    problems.append(
                        f"{path}: 必須パラメータ {required} を外したのに HTTP {bare}（400のはず）")
                    continue
        logger.info("  ok  %s %s%s", method.upper(), path,
                    f"  (必須{len(required)}件の400確認済)" if required else "")
    return (not problems), problems


def prepare(slug: str) -> bool:
    logger.info("=== %s ===", slug)
    recipe = load_recipe(slug)

    smoke_path = RECIPES_DIR / slug / "recipe.py"
    import importlib.util
    spec_ = importlib.util.spec_from_file_location(f"smoke_{slug}", smoke_path)
    mod = importlib.util.module_from_spec(spec_)
    spec_.loader.exec_module(mod)  # type: ignore[union-attr]
    smoke = getattr(mod, "SMOKE_QUERIES", {})

    logger.info("本番疎通を確認します: %s", recipe["base_url"])
    ok, problems = verify_live(recipe, smoke)
    if not ok:
        for p in problems:
            logger.error("  NG  %s", p)
        notify_discord(
            f"🔴 **{recipe['title']}** の出品準備に失敗しました。\n"
            + "\n".join(f"- {p}" for p in problems[:8])
        )
        return False

    out = write_spec(recipe)
    logger.info("OpenAPI spec: %s", out)

    lint_ok, lint_msg = lint_spec(out)
    if not lint_ok:
        logger.error("spec が OpenAPI として不正です:\n%s", lint_msg)
        notify_discord(
            f"🔴 **{recipe['title']}** の OpenAPI spec が検証を通りませんでした。\n"
            f"```\n{lint_msg[:1200]}\n```"
        )
        return False

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    ready = json.loads(READY_LOG.read_text(encoding="utf-8")) if READY_LOG.exists() else {}
    ready[slug] = {
        "title": recipe["title"],
        "category": recipe["category"],
        "short_description": recipe["short_description"],
        "spec": str(out),
        "base_url": recipe["base_url"],
        "endpoints": len(recipe["endpoints"]),
        "listed": ready.get(slug, {}).get("listed", False),
    }
    READY_LOG.write_text(json.dumps(ready, ensure_ascii=False, indent=1), encoding="utf-8")

    msg = (
        f"✅ **{recipe['title']}** が出品可能になりました\n"
        f"エンドポイント {len(recipe['endpoints'])}本すべて本番で疎通確認済み\n\n"
        f"**出品ページ**: {ADD_API_URL}\n"
        f"**OpenAPI spec**: `{out}`\n\n"
        f"__貼る値__\n"
        f"• API Name: `{recipe['title']}`\n"
        f"• Category: `{recipe['category']}`\n"
        f"• Specify using: **OpenAPI** を選んで上のspecを読ませる\n"
        f"• Short Description:\n```\n{recipe['short_description']}\n```"
    )
    notify_discord(msg)
    print("\n" + "─" * 68)
    print(msg.replace("**", "").replace("`", "").replace("```", ""))
    print("─" * 68 + "\n")
    return True


def main() -> int:
    ensure_not_halted()
    ap = argparse.ArgumentParser(description="RapidAPI 出品準備")
    ap.add_argument("slug", nargs="?", help="レシピ名 (recipes/<slug>)")
    ap.add_argument("--all", action="store_true", help="全レシピを処理")
    args = ap.parse_args()

    if args.all:
        slugs = sorted(p.name for p in RECIPES_DIR.iterdir()
                       if (p / "recipe.py").exists())
    elif args.slug:
        slugs = [args.slug]
    else:
        ap.error("slug か --all を指定してください")

    if not slugs:
        logger.warning("レシピが1つもありません: %s", RECIPES_DIR)
        return 1

    failed = []
    for s in slugs:
        try:
            if not prepare(s):
                failed.append(s)
        except RecipeError as e:
            logger.error("%s: レシピ不正: %s", s, e)
            failed.append(s)

    if failed:
        logger.error("失敗: %s", ", ".join(failed))
        return 1
    logger.info("完了: %d件", len(slugs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
