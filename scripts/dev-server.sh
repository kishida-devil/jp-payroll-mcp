#!/usr/bin/env bash
# 開発サーバを「必ず1本だけ」にする。
#
# 目的コマンドが複数起動を禁じているのに、3回作ってしまった。原因は手順:
#   - TaskStop は npx の子(node と workerd)まで殺さない
#   - `&` で切り離すと、次の起動と共存する
#   - netstat の LISTENING を1行しか見ずに「1本」と誤認した
# 数えるところまでを1つのコマンドにする。
#
#   bash scripts/dev-server.sh restart   全部落として1本だけ起動
#   bash scripts/dev-server.sh count     いま何本か
#   bash scripts/dev-server.sh stop      全部落とす
#
# **テストを流している間はプロジェクト内のファイルを触らないこと。**
# wrangler dev は変更のたびに worker を再起動し、その瞬間に飛んでいた要求は
# 永久に返らない。横で LOOP.md を編集していた回は 3,500 件で
# fetch failed になりサーバごと死んだ。触らずに流せば完走する。
#
# 速さは 1本でも 0.5s/件(本番は 0.06s)。劣化はしない。全体で約40分かかる。
# 多重起動すると 2.1s/件まで落ちる。そこだけがこのスクリプトで防げること。
set -u
PORT=8799

count() {
  powershell -NoProfile -Command "
    (Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='workerd.exe'\" |
     Where-Object { \$_.CommandLine -like '*wrangler*' -or \$_.Name -eq 'workerd.exe' } |
     Measure-Object).Count" 2>/dev/null | tr -d ' \r'
}

kill_all() {
  powershell -NoProfile -Command "
    Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='workerd.exe'\" |
    Where-Object { \$_.CommandLine -like '*wrangler*' -or \$_.Name -eq 'workerd.exe' } |
    ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  sleep 2
}

case "${1:-count}" in
  count)
    # **数えるべきは待ち受けの数。**wrangler dev は1本でも node と workerd に
    # 分かれるので、プロセス数を見ると「3本走っている」と読み違える。
    # 実際それで誤認した。権威ある数字は $PORT の LISTENING の数。
    listeners=$(netstat -ano | grep ":$PORT" | grep -c LISTENING)
    echo "$PORT を待ち受けているサーバ: ${listeners} 本  (プロセスは $(count) 個、1本でも複数に分かれる)"
    if [ "$listeners" -gt 1 ]; then echo "  多重起動。bash scripts/dev-server.sh restart で直す"; exit 1; fi
    ;;
  stop)
    kill_all; echo "全部落とした。残り $(count) 本"
    ;;
  restart)
    kill_all
    listeners=$(netstat -ano | grep ":$PORT" | grep -c LISTENING)
    if [ "$listeners" != "0" ]; then echo "落としきれていない: $listeners"; exit 1; fi
    npx wrangler dev --port "$PORT" --local >/dev/null 2>&1 &
    for _ in $(seq 1 60); do
      curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/v1/data-freshness" && break
      sleep 1
    done
    listeners=$(netstat -ano | grep ":$PORT" | grep -c LISTENING)
    if [ "$listeners" != "1" ]; then
      echo "起動後に $listeners 本が $PORT を握っている。1本でないので落とす"
      kill_all; exit 1
    fi
    t=$(curl -s -o /dev/null -w '%{time_total}' "http://127.0.0.1:$PORT/v1/data-freshness")
    echo "1本だけ起動。応答 ${t}s"
    ;;
  *) echo "usage: dev-server.sh {restart|count|stop}"; exit 2 ;;
esac
