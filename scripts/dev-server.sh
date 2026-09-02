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
    # **出力を捨てていたので、落ちた理由が誰にも分からなかった。**
    # スイートが3,500〜3,750件付近で2回連続で死んだとき、手がかりがゼロだった。
    # 残す。場所は固定で、上書きしていく(溜めても読まない)。
    : "${DEV_LOG:=${TMPDIR:-/tmp}/jp-payroll-dev.log}"
    npx wrangler dev --port "$PORT" --local >"$DEV_LOG" 2>&1 &
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
  supervise)
    # **wrangler dev は、この負荷で落ちる。**空のエラーで ProxyController が死ぬ
    # (4.125.0 でも 4.127.1 でも起きる。本文が無いので原因は追えない)。
    # スイートは 3,500〜3,750 件あたりで5回死に、そのたびに50分が消えた。
    # 上流の不具合なのでこちらでは直せない。**落ちたら立て直す。**
    #
    # 多重起動しないこと。待ち受けが 0 のときだけ起こす。
    # 呼び出し側で `&` を付けて背後に置き、終わったら supervise-stop で止める。
    : "${DEV_LOG:=${TMPDIR:-/tmp}/jp-payroll-dev.log}"
    FLAG="${TMPDIR:-/tmp}/jp-payroll-supervise.on"
    # **見張りが多重に走ると、立て直しが競合して同じ秒に何度も再起動する。**
    # 実際そうなった(5本走り、11:26以降 1分おきに立て直しの記録が出た)。
    # **多重起動を防ぐために作ったものが、多重起動していた。**
    # 旗が既にあるなら、他が見張っている。何もせず戻る。
    if [ -f "$FLAG" ]; then
      echo "すでに見張りが動いている。二重には起こさない"
      exit 0
    fi
    echo $$ > "$FLAG"
    # 自分の番号を旗に書き、毎周それが自分か確かめる。
    # 旗が消えたか他人のものになったら降りる。**止め忘れが積み上がらない。**
    trap 'rm -f "$FLAG"' EXIT
    echo "見張り開始 (pid $$)。$PORT が空いたら立て直す(止めるには supervise-stop)"
    # **待ち受けの数で判定してはいけない。**workerd が死んでも親の node が
    # ポートを掴んだままなので「1本ある」と数えられ、実際は何も答えない。
    # 実測でそうなった(count は 1本、curl は 000)。**答えるかどうかで見る。**
    #
    # **3秒では短すぎた。**負荷の最中は健全性検査そのものが待たされる。実測で
    # 0.7〜1.4秒、スパイクではそれ以上。3秒で切ると、生きているサーバを落として
    # 飛んでいた要求を全部殺し、スイートを遅くする。実際に1回の実行で2度やった。
    # **見張りが、見張っている問題を起こしていた(2度目)。**
    # 待つ時間は実測から決める。そのうえで、1回の失敗では動かない — 連続で
    # 落ちたときだけ立て直す。反応は最大20秒遅れるが、スイート側は約40秒待つ。
    misses=0
    while [ "$(cat "$FLAG" 2>/dev/null)" = "$$" ]; do
      if curl -s --max-time 10 -o /dev/null "http://127.0.0.1:$PORT/v1/data-freshness"; then
        misses=0
      else
        misses=$((misses + 1))
        echo "$(date +%H:%M:%S) 応答が無い ($misses 回目)" >> "$DEV_LOG.supervise"
      fi
      if [ "$misses" -ge 2 ]; then
        misses=0
        echo "$(date +%H:%M:%S) 連続で応答が無い。全部落として立て直す" >> "$DEV_LOG.supervise"
        kill_all
        npx wrangler dev --port "$PORT" --local >>"$DEV_LOG" 2>&1 &
        for _ in $(seq 1 60); do
          curl -s --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/v1/data-freshness" && break
          sleep 1
        done
      fi
      sleep 2
    done
    ;;
  supervise-stop)
    rm -f "${TMPDIR:-/tmp}/jp-payroll-supervise.on"
    echo "見張りを止めた"
    ;;
  *) echo "usage: dev-server.sh {restart|count|stop|supervise|supervise-stop}"; exit 2 ;;
esac
