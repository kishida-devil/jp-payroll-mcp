# あなたにしかできない作業

本番で最初の顧客の道を歩いた結果、**通った5 / 止まる2 / 見えない1** でした。
実装は全部動いています。**止まっているのは、私が触れない場所だけです。**

    1. 止まる  MCPレジストリで見つかる      → 下の 2
    2. 止まる  GitHubのトピック検索         → 下の 4
    3. OK      鍵なしで試せる
    4. OK      上限で有料への道が示される
    5. OK      出品のゲートウェイが生きている
    6. 見えない 有料プランがあり購読できる     → 下の 0
    7. OK      無料枠ちょうどは通る
    8. OK      収録外の日付で誤答しない

---

## 0. 日本語のREADMEと着地頁を世に出す 🔴 いまここ

2つ直してあります。

**1つ目 — READMEの言語。**npm のパッケージ頁も GitHub のトップも、描画されるのは英語版のほうでした。日本語版はずっとあったのに、リンクの先に置いてあって誰も踏みません。入れ替えたので、**publish しないと npmjs.com の頁は英語のまま**です。

**2つ目 — 着地点。**記事もREADMEもRapidAPIも `japan-payroll-api.tsumugi.workers.dev` を指しているのに、ブラウザで開くと9,772バイトの生JSONが出ていました。ブラウザには日本語の頁を、APIクライアントには今までどおりJSONを返すようにしたので、**deploy しないと生JSONのまま**です。

- [ ] 実行する

**下の6行をまとめて貼ってください(2〜3分)。** cmd でも PowerShell でも動きます。

```
cd D:\Claude\tsumugi
git push
npx wrangler deploy
npm publish D:\Claude\tsumugi\mcp
D:\Claude\tsumugi\mcp\mcp-publisher.exe login github
D:\Claude\tsumugi\mcp\mcp-publisher.exe publish D:\Claude\tsumugi\mcp\server.json
gh repo edit kishida-devil/jp-payroll-mcp -d "日本の給与計算・社会保険・労務のAPIとMCPサーバー。47都道府県の保険料率、源泉所得税、標準報酬月額の決定と改定、割増賃金、年次有給休暇、最低賃金を計算し、根拠の条文または通達を返します。Japanese payroll, social insurance and labour law as an MCP server and HTTP API."
```

`mcp-publisher.exe login github` はブラウザで機器認証のコードを聞かれます。
前回と同じ手順です。npm は2FAのコードを聞かれます。

**貼り終えたら、これ1行で答え合わせできます。**

```
python D:\Claude\tsumugi\scripts\verify-published.py
```

18項目を見て、出ていないものを「-- 」で並べます。
いま(公開前)に走らせると 3/18 と正しく答えます。

**確認の中身:**

| 見るところ | 期待 |
|---|---|
| npmjs.com のパッケージ頁 | 日本語で始まる |
| github.com のトップ | 日本語で始まる |
| API のURLをブラウザで開く | 日本語の頁が出る(生JSONではない) |
| 同じURLに `curl` | **今までと同じJSON**(APIを壊していないこと) |
| `/sitemap.xml` | 200 |

貼り終えたら教えてください。全部私が確認します。

## 1. Qiita に2本目の記事を出す(やるなら)

- [ ] 実行する

Zenn の記事は退職日・年齢・随時改定の話で、**狙える検索語が1組しかありません。**
Qiita 用に、**内容の重ならない**2本目を書いてあります。テーマは等級表と料率で、
「実装で最初に詰まるのはロジックではなくデータ」という切り口です。

貼るファイル:

```
D:\Claude\tsumugi\docs\listing\qiita-article.md
```

https://qiita.com/drafts/new で、1行目の `# ` を除いた本文を貼ってください
(Qiita はタイトルを別欄に入れます)。

| 欄 | 値 |
|---|---|
| タイトル | 協会けんぽの保険料額表を、自前で持たずにJSONで引く |
| タグ | 給与計算 / 社会保険 / API / MCP / Python |

記事の数字(等級数・41通り・新潟9.21%・佐賀10.55%・年24,119円)は、
**47都道府県ぶんを実際にAPIから引いて照合する検査**を通してあります。

## 1. 上限の扱いを変えるか(あなたの判断・急がない)

- [ ] 決める

RapidAPI で実際に売れている日本向けAPI(ギークフィード「Search Japanese PostCode」)と、
我々の違いは**価格ではなく上限の扱い**でした。

| | 向こう(実利用あり) | 我々 |
|---|---|---|
| Basic | $0 / 10回・日 **+$0.03/回で継続** | $0 / 20回・日 **停止** |
| Pro | **$3** / 300回・日 +$0.02 | **$4** / 30,000回・月 **停止** |
| Ultra | $30 +$0.015 ⭐ | $10 **停止** |
| Mega | $60 +$0.01 | $15 **停止** |

**入口は向こうのほうが安い**ので、$4 が高すぎる/安すぎるという話ではありません。
違うのは、全プランが Hard Limit で**上限に達すると止まる**ことです。
給与計算は月末に集中するので、月の途中で止まりうるAPIは本番に入れられません。

変えるなら RapidAPI Studio の各プランで Hard Limit を外し、超過料金を設定します。
**私は画面を操作できないので、やるかどうかも含めてあなたの判断です。**
効果は測れません(RapidAPIは非購読者の離脱を提供者に見せません)。

## 済んだもの

- [x] GitHub の topics を10件設定(2026-08-30)

- [x] npm の description に 給与計算/社会保険 を移し 0.4.1 を公開(2026-08-29)。検索順位は 給与計算 2位 / 社会保険 3位 / 社労士 1位

- [x] RapidAPI の出品説明を日本語に差し替え(2026-08-29)。旧ホストの Quick start も撤去
- [x] 公式MCPレジストリに 0.4.0 / 0.4.1 を登録(2026-08-29)
- [x] Zenn 記事を公開(2026-08-30 14:50) https://zenn.dev/kishida_devil/articles/9d5a645a105c0b
- [x] RapidAPI に有料プラン(Pro $4 / Ultra $10 / Mega $15)があることを確認

- [x] npm に 0.4.0 を公開(2026-08-29)。0.2.0 から11周ぶんが届いた
- [x] npm の 2FA リカバリコード再発行
- [x] Discord Webhook の再発行と `.env` 差し替え、実送信まで確認
