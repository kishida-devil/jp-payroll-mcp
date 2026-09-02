# -*- coding: utf-8 -*-
"""「何件の検証を通しているか」を、全部の面で揃える。

    python D:\\Claude\\tsumugi\\scripts\\sync-counts.py 4383

同じ事実に5つの違う数字が載っていた。記事が4,372、出品文が4,320、
READMEが4,339、着地頁が4,349、実際は4,383。
**これは製品の信頼性の根拠なので、面ごとに違うのがいちばん困る。**

原因は検査が「下回るのは古いだけ」と許していたこと。手で5箇所直す運用は
3回続けて守られなかったので、1コマンドにする。

引数を省くと、直近の実行結果を推測せず「渡してください」と言って終わる。
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 面 -> その面での書き方。数字だけを差し替える。
TARGETS = [
    ("README.md", r"\*\*([\d,]+) assertions\*\*"),
    ("README.md", r"runs ([\d,]+) assertions"),
    ("README.md", r"\*\*([\d,]+)件\*\* の検証"),
    ("mcp/README.md", r"\*\*([\d,]+)件\*\* の検証"),
    ("mcp/README.en.md", r"\*\*([\d,]+) assertions\*\*"),
    # 面ごとに書き方が違う。**当たらないパターンは黙って何もしない**ので、
    # 実物を見て書くこと。最初に書いた4本は landing.ts にも出品文にも当たらず、
    # 4,349 と 4,320 が残ったまま「揃っています」と言いかけた。
    ("src/landing.ts", r'<span class="n">([\d,]+)件</span> の検証'),
    ("recipes/jp-payroll/rapidapi-docs.md", r"\*\*変更のたびに([\d,]+)件の表明\*\*"),
    ("recipes/jp-payroll/rapidapi-docs.md", r"([\d,]+) assertions on every change"),
    ("docs/articles/qiita-rate-table.md", r"\*\*([\d,]+)件\*\* の検証"),
    ("docs/articles/zenn-payroll-traps.md", r"\*\*([\d,]+)件\*\* の検証"),
    # ディレクトリ掲載文(mcp.so / Glama / Smithery / PulseMCP)。英日それぞれ。
    ("docs/listing/directories.md", r"([\d,]+) assertions"),
    ("docs/listing/directories.md", r"照合\(([\d,]+)件\)"),
    ("docs/listing/directories.md", r"([\d,]+)件\)は"),
]


def main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1].replace(",", "").isdigit():
        print("検証数を渡してください。npm test の最後の行の数です。", file=sys.stderr)
        print("  python scripts/sync-counts.py 4383", file=sys.stderr)
        return 1
    n = int(sys.argv[1].replace(",", ""))
    pretty = f"{n:,}"

    changed, seen = [], set()
    for rel, pat in TARGETS:
        p = ROOT / rel
        if not p.exists():
            continue
        s = io.open(p, encoding="utf-8").read()
        hits = re.findall(pat, s)
        if not hits:
            continue
        new = re.sub(pat, lambda m: m.group(0).replace(m.group(1), pretty), s)
        if new != s:
            io.open(p, "w", encoding="utf-8", newline="").write(new)
            changed.append(f"{rel}: {'/'.join(sorted(set(hits)))} -> {pretty}")
        seen.add(rel)

    print()
    if changed:
        for c in changed:
            print(f"  {c}")
    else:
        print(f"  すべて {pretty} で揃っています。")
    print()
    print("  生成物も作り直してください:")
    print("    python scripts/build-listing.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
