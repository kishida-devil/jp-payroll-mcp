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


def _parameters(ep: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for p in ep.get("params", []):
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

    return out
