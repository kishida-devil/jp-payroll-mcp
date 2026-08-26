"""レシピからRapidAPI用のアイコン(500x500 PNG)を作る。

RapidAPI の推奨は 500x500 の JPEG/PNG。一覧では小さく表示されるので、
文字に頼らず図形で識別できることを優先する。

    python pipeline/make_icon.py jp-payroll
    python pipeline/make_icon.py --all
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent
RECIPES_DIR = REPO_ROOT / "recipes"
OUT_DIR = REPO_ROOT / "build" / "icons"

SIZE = 500
SS = 4  # スーパーサンプリング倍率（斜線とカーブのジャギー除去）

# 既定パレット。レシピ側で "icon" を定義すれば上書きできる。
DEFAULT_ICON = {
    "bg": "#16233F",
    "accent": "#E23A48",
    "fg": "#FFFFFF",
    "motif": "steps",
}


def _load(slug: str) -> dict:
    path = RECIPES_DIR / slug / "recipe.py"
    spec = importlib.util.spec_from_file_location(f"icon_{slug}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod.RECIPE


def _steps(d: ImageDraw.ImageDraw, s: int, fg: str, accent: str) -> None:
    """階段関数。標準報酬月額の等級表（段階的に上がる）を表す。"""
    n = 5
    pad = int(0.17 * s)
    span = s - pad * 2
    step_w = span / n
    base_y = s - pad
    # 段はだんだん高くなる。最後の段だけアクセント色（等級の上限=クランプ）
    for i in range(n):
        h = span * (0.16 + 0.168 * i)
        x0 = pad + i * step_w
        y0 = base_y - h
        color = accent if i == n - 1 else fg
        d.rectangle([x0, y0, x0 + step_w * 0.82, base_y], fill=color)


def build(recipe: dict) -> Path:
    cfg = {**DEFAULT_ICON, **(recipe.get("icon") or {})}
    s = SIZE * SS
    img = Image.new("RGB", (s, s), cfg["bg"])
    d = ImageDraw.Draw(img)

    # 左上の余白に円（日本のデータであることの示唆）。
    # 右上に置くと最も高い段と接して「!」に見えるので、段が低い側に置く。
    r = int(s * 0.075)
    cx, cy = int(s * 0.245), int(s * 0.215)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=cfg["accent"])

    _steps(d, s, cfg["fg"], cfg["accent"])

    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{recipe['slug']}.png"
    img.save(out, "PNG", optimize=True)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="RapidAPI用アイコン生成")
    ap.add_argument("slug", nargs="?")
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()

    slugs = (sorted(p.name for p in RECIPES_DIR.iterdir() if (p / "recipe.py").exists())
             if a.all else [a.slug] if a.slug else [])
    if not slugs:
        ap.error("slug か --all を指定してください")

    for slug in slugs:
        out = build(_load(slug))
        w, h = Image.open(out).size
        print(f"{slug}: {out}  ({w}x{h}, {out.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
