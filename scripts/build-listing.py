# -*- coding: utf-8 -*-
"""RapidAPI の出品欄に貼るテキストを、そのまま開ける形で書き出す。

`recipe.py` が出所。手で書き写すと必ずずれるので、生成する。

    python D:\\Claude\\tsumugi\\scripts\\build-listing.py

出力:
    docs/listing/short-description.txt   Short Description 欄(300字以内)
    docs/listing/overview.md             Overview / Long Description 欄

**シェルを選ばない。**cmd.exe でも PowerShell でも Git Bash でも、この1行で動く。
`&&` での連結や `cd /d` は PowerShell 5.1 で落ちるので使わない。
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "listing"


def load_recipe() -> dict:
    p = ROOT / "recipes" / "jp-payroll" / "recipe.py"
    spec = importlib.util.spec_from_file_location("recipe", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.RECIPE


def main() -> int:
    recipe = load_recipe()
    OUT.mkdir(parents=True, exist_ok=True)

    short = recipe["short_description"]
    if len(short) > 300:
        print(f"short_description が {len(short)} 字。RapidAPI の上限は300字。", file=sys.stderr)
        return 1
    (OUT / "short-description.txt").write_text(short + "\n", encoding="utf-8")

    src = ROOT / "recipes" / "jp-payroll" / "rapidapi-docs.md"
    shutil.copyfile(src, OUT / "overview.md")

    # 記事も同じ場所に出す。貼る先が違うだけで、やることは同じ。
    for src_name, out_name in (
        ("zenn-payroll-traps.md", "zenn-article.md"),
        ("qiita-rate-table.md", "qiita-article.md"),
    ):
        article = ROOT / "docs" / "articles" / src_name
        if article.exists():
            shutil.copyfile(article, OUT / out_name)

    print("書き出しました。この2つを RapidAPI に貼ってください。")
    print()
    print(f"  Short Description 欄 ({len(short)}字)")
    print(f"    {OUT / 'short-description.txt'}")
    print()
    print(f"  Overview / Long Description 欄 ({len((OUT / 'overview.md').read_text(encoding='utf-8'))}字)")
    print(f"    {OUT / 'overview.md'}")
    print()
    print("  ※ Overview の欄が2つある場合は、両方に同じものを貼ってください。")
    print("     片方に古い版が残ると、そちらの Quick start が404を返します。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
