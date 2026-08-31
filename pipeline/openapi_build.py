"""レシピ定義から OpenAPI 3.0 spec を組み立てる。

RapidAPI の「Specify using: OpenAPI」に読ませる用。レシピは
recipes/<slug>/recipe.py の RECIPE 辞書。エンドポイントを1箇所に書けば
spec も出品用の文言もそこから生成される。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
RECIPES_DIR = REPO_ROOT / "recipes"
SPEC_DIR = REPO_ROOT / "build" / "openapi"

_REQUIRED_RECIPE_KEYS = ("slug", "title", "short_description", "category",
                         "base_url", "version", "endpoints")
_REQUIRED_ENDPOINT_KEYS = ("path", "summary")


class RecipeError(ValueError):
    """レシピの書き方が不正。spec を作る前に落とす。"""


def load_recipe(slug: str) -> dict[str, Any]:
    """recipes/<slug>/recipe.py の RECIPE を読む。"""
    import importlib.util

    path = RECIPES_DIR / slug / "recipe.py"
    if not path.exists():
        raise RecipeError(f"レシピがありません: {path}")
    spec = importlib.util.spec_from_file_location(f"recipe_{slug}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    recipe = getattr(mod, "RECIPE", None)
    if not isinstance(recipe, dict):
        raise RecipeError(f"{path} に RECIPE 辞書がありません")
    validate_recipe(recipe)
    return recipe


def validate_recipe(recipe: dict[str, Any]) -> None:
    missing = [k for k in _REQUIRED_RECIPE_KEYS if not recipe.get(k)]
    if missing:
        raise RecipeError(f"RECIPE に必須キーがありません: {', '.join(missing)}")
    if not recipe["base_url"].startswith("https://"):
        raise RecipeError("base_url は https:// で始めてください")
    if not isinstance(recipe["endpoints"], list) or not recipe["endpoints"]:
        raise RecipeError("endpoints が空です")
    # RapidAPI の Short Description は短い方が通りやすい
    if len(recipe["short_description"]) > 300:
        raise RecipeError("short_description が長すぎます(300字以内)")
    seen = set()
    for i, ep in enumerate(recipe["endpoints"]):
        miss = [k for k in _REQUIRED_ENDPOINT_KEYS if not ep.get(k)]
        if miss:
            raise RecipeError(f"endpoints[{i}] に {', '.join(miss)} がありません")
        if not ep["path"].startswith("/"):
            raise RecipeError(f"endpoints[{i}].path は / で始めてください: {ep['path']}")
        method = ep.get("method", "get").lower()
        if method not in ("get", "post"):
            raise RecipeError(f"{ep['path']} の method は get か post です: {method}")
        if (method, ep["path"]) in seen:
            raise RecipeError(f"path が重複しています: {method.upper()} {ep['path']}")
        seen.add((method, ep["path"]))
        if method == "post" and not ep.get("body"):
            raise RecipeError(f"{ep['path']} は POST なので body が必要です")
        for p in ep.get("params", []):
            if not p.get("name"):
                raise RecipeError(f"{ep['path']} のパラメータに name がありません")


# どのエンドポイントでも受けるもの。レシピ側に書くと足し忘れるので、ここで一度だけ付ける。
# 受け付けるのに仕様書に無い状態は、機能が無いのと同じ — 読んだ人には見えない。
CROSS_CUTTING = [
    {
        "name": "detail",
        "enum": ["full", "compact"],
        "description": (
            "compact drops the attribution, notes and statutory citations and keeps the "
            "figures — roughly a tenth the size on a batch run. What was dropped, and how "
            "to get it back, is listed in `omitted` rather than silently removed. "
            "Defaults to full."
        ),
    },
    {
        "name": "include",
        "enum": ["statute_text"],
        "description": (
            "statute_text attaches the full text of every provision this answer cites, so a "
            "figure can be checked against the words it rests on without a second call. Off "
            "by default because the text is long."
        ),
    },
]


def _parameters(ep: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for p in [*ep.get("params", []), *CROSS_CUTTING]:
        schema: dict[str, Any] = {"type": p.get("type", "string")}
        if p.get("enum"):
            schema["enum"] = p["enum"]
        if p.get("example") is not None:
            schema["example"] = p["example"]
        out.append({
            "name": p["name"],
            "in": "query",
            "required": bool(p.get("required")),
            "description": p.get("description", ""),
            "schema": schema,
        })
    return out


def build_spec(recipe: dict[str, Any]) -> dict[str, Any]:
    """レシピ → OpenAPI 3.0.3 spec。"""
    paths: dict[str, Any] = {}
    for ep in recipe["endpoints"]:
        op: dict[str, Any] = {
            "summary": ep["summary"],
            "description": ep.get("description", ep["summary"]),
            "operationId": ep.get("operation_id") or _operation_id(ep["path"], ep.get("method", "get").lower()),
            "responses": {
                "200": {
                    "description": ep.get("response_description", "Successful response"),
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                "400": {"description": "Invalid or missing query parameter"},
                # 経路はあるがメソッドが違うときに返る。仕様書に無い応答は、
                # 生成したクライアントが扱えない。GET /v1/payroll/batch を
                # ブラウザで開いた人が最初に当たるのはこれ。
                "405": {
                    "description": (
                        "The path exists but not for this method. "
                        "The Allow header lists what it takes."
                    ),
                },
                "422": {
                    "description": (
                        "The date asked for is outside the bundled data. "
                        "Refused rather than answered with a stale figure."
                    ),
                },
            },
        }
        method = ep.get("method", "get").lower()
        params = _parameters(ep)
        if params:
            op["parameters"] = params
        if ep.get("tags"):
            op["tags"] = ep["tags"]
        if method == "post":
            op["requestBody"] = {
                "required": True,
                "content": {"application/json": {
                    "schema": ep["body"],
                    **({"example": ep["body_example"]} if ep.get("body_example") else {}),
                }},
            }
        paths.setdefault(ep["path"], {})[method] = op

    return {
        "openapi": "3.0.3",
        "info": {
            "title": recipe["title"],
            "description": recipe.get("long_description", recipe["short_description"]),
            "version": recipe["version"],
            **({"contact": recipe["contact"]} if recipe.get("contact") else {}),
            **({"license": recipe["license"]} if recipe.get("license") else {}),
        },
        "servers": [{"url": recipe["base_url"]}],
        # 空配列 = 認証不要であることの明示。RapidAPI 経由の X-RapidAPI-Key は
        # マーケットプレイス側が被せる層なので、こちらの spec には書かない。
        "security": [],
        "paths": paths,
    }


def _operation_id(path: str, method: str = "get") -> str:
    parts = [p for p in path.strip("/").split("/") if p and not p.startswith("{")]
    if not parts:
        return f"{method}Root"
    head, *tail = parts
    return method + "".join(w.capitalize() for w in (head.split("-") + [t for p in tail for t in p.split("-")]))


# Custom GPT Actions は **最大30オペレーション**。超えると読み込みが失敗するので、
# 会話で呼ばれないものを落とした版を別に出す。落とした理由も一緒に持たせる。
# (スキーマの上限は1MB。こちらは85KBなので問題にならない。)
GPT_ACTIONS_MAX_OPERATIONS = 30

GPT_EXCLUDE: dict[str, str] = {
    '/': '入口の一覧。仕様書を読み込んだ時点で不要。',
    '/v1/enums': 'クライアントを書く人がビルド時に読む参照。会話では出てこない。',
    '/v1/prefectures': '47件の名前一覧。各エンドポイントが名前を直接受け取る。',
    '/v1/standard-remuneration/table': '全等級表。点で引ければ会話の問いには足りる。',
    '/v1/consumption-tax': 'LOOP.md の3条件すべてで落ちる。',
    '/v1/consumption-tax/history': '同上。',
    '/v1/corporate-number/check-digit': 'テスト用番号の生成。実務の問いは validate 側。',
    '/v1/minimum-wage/history': '「この時給で大丈夫か」には点の照会で足りる。',
    '/v1/statute/index': '条文は ref で引ければよい。',
    '/v1/data-freshness': '有用だが、会話の中で行動に結びつかない。',
    '/v1/payroll/batch': 'バルク。会話は1人ずつ。',
    '/v1/standard-remuneration/regular/batch': 'バルク。',
    '/v1/invoice-number/validate/batch': 'バルク。',
    '/v1/withholding-tax/computer': '同じ税額の別解法。会話では月額表で足りる。',
}


def build_gpt_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """会話用に絞った仕様書。30オペレーションに収める。"""
    import copy

    out = copy.deepcopy(spec)
    out["paths"] = {p: v for p, v in spec["paths"].items() if p not in GPT_EXCLUDE}

    ops = sum(len([m for m in v if m in ("get", "post", "put", "patch", "delete")])
              for v in out["paths"].values())
    if ops > GPT_ACTIONS_MAX_OPERATIONS:
        raise RecipeError(
            f"GPT 用の仕様書が {ops} オペレーションで、上限 {GPT_ACTIONS_MAX_OPERATIONS} を超えています。"
            f"GPT_EXCLUDE に追加するか、エンドポイントを統合してください。"
        )

    info = out.setdefault("info", {})
    info["title"] = info.get("title", "") + " (GPT Actions)"
    dropped = "\n".join(f"- {p} — {why}" for p, why in sorted(GPT_EXCLUDE.items()))
    info["description"] = (
        (info.get("description", "") or "")
        + f"\n\nCustom GPT Actions は最大 {GPT_ACTIONS_MAX_OPERATIONS} オペレーションまでしか"
          "読み込めないため、会話で呼ばれないものを落としてあります。"
          f"全 {len(spec['paths'])} 件の完全版は /openapi.json にあります。\n\n"
          f"落としたもの:\n{dropped}"
    )
    return out


def write_spec(recipe: dict[str, Any]) -> Path:
    spec = build_spec(recipe)
    SPEC_DIR.mkdir(parents=True, exist_ok=True)
    out = SPEC_DIR / f"{recipe['slug']}.openapi.json"
    out.write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")

    # Worker が /openapi.json で配信する版も同時に更新する。ここを手動コピーに
    # すると、配信される仕様書だけが古いまま残り、しかも「specは生成し直した」と
    # 思い込んでいるぶん気づきにくい。
    served = REPO_ROOT / "src" / "data" / "openapi.json"
    if served.parent.exists():
        served.write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")

    # Custom GPT Actions 用の絞った版。上限を超えていれば build_gpt_spec が落ちる。
    gpt = build_gpt_spec(spec)
    (SPEC_DIR / f"{recipe['slug']}.gpt.openapi.json").write_text(
        json.dumps(gpt, ensure_ascii=False, indent=1), encoding="utf-8")
    if served.parent.exists():
        (served.parent / "openapi-gpt.json").write_text(
            json.dumps(gpt, ensure_ascii=False, indent=1), encoding="utf-8")

    return out


def main(argv: list[str] | None = None) -> int:
    """レシピから spec を生成して書き出す。

    以前ここに入口が無く、`python pipeline/openapi_build.py` は関数を定義して
    黙って終了していた。生成したつもりで配信される仕様書だけが古いまま残る。
    実行して何も起きないコマンドは、失敗するコマンドより見つけにくい。
    """
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug", nargs="*", help="recipes/<slug>/ の名前。省略すると全件。")
    args = parser.parse_args(argv)

    slugs = args.slug or sorted(
        p.name for p in RECIPES_DIR.iterdir() if (p / "recipe.py").exists()
    )
    if not slugs:
        print(f"レシピがありません: {RECIPES_DIR}")
        return 1

    for slug in slugs:
        recipe = load_recipe(slug)
        out = write_spec(recipe)
        spec = json.loads(out.read_text(encoding="utf-8"))
        print(f"{slug}: {len(spec['paths'])} paths -> {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
