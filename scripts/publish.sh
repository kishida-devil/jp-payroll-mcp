#!/usr/bin/env bash
# 貼るのを1行にする。
#
#   bash D:/Claude/tsumugi/scripts/publish.sh
#   bash D:/Claude/tsumugi/scripts/publish.sh --check    # 空打ちだけ
#
# これまで3回、手順の途中で失敗している:
#   - `npm publish --prefix` は効かない(--prefix は install 先を変えるだけ)
#   - `mcp-publisher.exe publish` は cwd の server.json を読む
#   - npm の E404 は「無い」ではなく認証切れ
# だから、**先に全部空打ちしてから**本番を叩く。途中で落ちたらそこで止める。
#
# 2FA のコードと GitHub の機器認証は、途中で聞かれる。手元で入力する。
# このスクリプトは秘密を読まないし、保存もしない。
set -u

# **どの bash で起動されても動くようにする。**
# `bash publish.sh` は、PATH の引き当て次第で WSL の bash が起動する。
# WSL から見ると D:/Claude/tsumugi は存在せず(/mnt/d/... になる)、
# 実際に `cd: D:/Claude/tsumugi: No such file or directory` で止まった。
# 場所を決め打ちせず、自分がどこに置かれているかから割り出す。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Git Bash の pwd は /d/Claude/tsumugi を返すが、Windows の node は
# require('/d/...') を解決できない。混在形式 (D:/Claude/tsumugi) なら両方が読む。
# 場所を決め打ちしていた頃はたまたま正しく、自動判定にして壊した。
if command -v cygpath >/dev/null 2>&1; then
  ROOT="$(cygpath -m "$ROOT")"
fi

# WSL だと Windows 側の npm / gh / wrangler / mcp-publisher.exe が揃わない。
# 中途半端に走らせるより、入口を教えて止める。
case "$(uname -s)" in
  Linux*)
    cat <<'WSL'

WSL の bash で起動されています。Windows 側の npm / gh / wrangler が使えません。
かわりに、cmd か PowerShell でこれを実行してください:

    D:\Claude\tsumugi\scripts\publish.cmd

WSL
    exit 1;;
esac

MCP="$ROOT/mcp"
EXE="$MCP/mcp-publisher.exe"
REPO="kishida-devil/jp-payroll-mcp"
DESC="日本の給与計算・社会保険・労務のAPIとMCPサーバー。47都道府県の保険料率、源泉所得税、標準報酬月額の決定と改定、割増賃金、年次有給休暇、最低賃金を計算し、根拠の条文または通達を返します。Japanese payroll, social insurance and labour law as an MCP server and HTTP API."

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

step() { printf '\n=== %s ===\n' "$1"; }
die()  { printf '\n止めました: %s\n' "$1" >&2; exit 1; }

cd "$ROOT" || die "$ROOT に入れません"

# ---- 先に全部確かめる ------------------------------------------------------
step "事前確認"

[ -x "$EXE" ] || die "mcp-publisher.exe が $MCP にありません"
printf '  mcp-publisher: %s\n' "$("$EXE" --version 2>&1 | tail -1)"

who=$(npm whoami 2>&1) || die "npm にログインしていません。npm login を先に実行してください"
printf '  npm: %s\n' "$who"

gh auth status >/dev/null 2>&1 || die "gh にログインしていません。gh auth login を先に実行してください"
perm=$(gh api "repos/$REPO" --jq '.permissions.push' 2>&1)
[ "$perm" = "true" ] || die "gh の有効アカウントに $REPO への push 権限がありません ($perm)"
printf '  gh: %s に push できます\n' "$REPO"

[ -z "$(git status --porcelain)" ] || die "未コミットの変更があります。先にコミットしてください"
ahead=$(git log --oneline origin/main..HEAD | wc -l | tr -d ' ')
printf '  git: 未push %s コミット\n' "$ahead"

ver=$(node -p "require('$MCP/package.json').version" 2>/dev/null)
# 版が読めないまま先へ進むと `npm view pkg@` が latest に当たり、
# 「既にあります」と誤って報告する。実際にそう出た。空なら止める。
[ -n "$ver" ] || die "mcp/package.json から版を読めませんでした ($MCP)"
printf '  版: %s\n' "$ver"
if npm view "jp-payroll-mcp@$ver" version >/dev/null 2>&1; then
  die "npm に $ver は既にあります。mcp/package.json と mcp/server.json の版を上げてください"
fi

npx wrangler deploy --dry-run >/dev/null 2>&1 || die "wrangler deploy の空打ちが失敗しました"
printf '  wrangler: 空打ち成功\n'
npm publish "$MCP" --dry-run >/dev/null 2>&1 || die "npm publish の空打ちが失敗しました"
printf '  npm: 空打ち成功\n'

if [ "$CHECK_ONLY" = "1" ]; then
  printf '\n全部通りました。--check を外すと本番に出します。\n'
  exit 0
fi

# ---- 本番 ------------------------------------------------------------------
step "1/5 git push"
git push || die "git push"

step "2/5 wrangler deploy"
npx wrangler deploy || die "wrangler deploy"

step "3/5 npm publish (2FAのコードを聞かれます)"
npm publish "$MCP" || die "npm publish"

step "4/5 MCPレジストリ (ブラウザで機器認証のコードを聞かれます)"
"$EXE" login github || die "mcp-publisher login"
"$EXE" publish "$MCP/server.json" || die "mcp-publisher publish"

step "5/5 GitHub の説明文"
gh repo edit "$REPO" -d "$DESC" || die "gh repo edit"

# ---- 答え合わせ ------------------------------------------------------------
step "答え合わせ"
printf '  npm と MCPレジストリの反映には数分かかることがあります。\n\n'
PYTHONIOENCODING=utf-8 python "$ROOT/scripts/verify-published.py"
