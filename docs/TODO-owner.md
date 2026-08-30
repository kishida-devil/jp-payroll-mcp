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

## 0. 日本語のREADMEを世に出す 🔴 いまここ

npm のパッケージ頁も GitHub のトップも、描画されるのは英語版のほうでした。
日本語版はずっとあったのに、リンクの先に置いてあって誰も踏みません。
入れ替えたので、**publish しないと npmjs.com の頁は英語のまま**です。

- [ ] 実行する

**下の6行をまとめて貼ってください(1〜2分)。** cmd でも PowerShell でも動きます。

```
cd D:\Claude\tsumugi
git push
npm publish D:\Claude\tsumugi\mcp
D:\Claude\tsumugi\mcp\mcp-publisher.exe login github
D:\Claude\tsumugi\mcp\mcp-publisher.exe publish D:\Claude\tsumugi\mcp\server.json
gh repo edit kishida-devil/jp-payroll-mcp -d "日本の給与計算・社会保険・労務のAPIとMCPサーバー。47都道府県の保険料率、源泉所得税、標準報酬月額の決定と改定、割増賃金、最低賃金を計算し、根拠の条文を返します。Japanese payroll, social insurance and labour law as an MCP server and HTTP API."
```

`mcp-publisher.exe login github` はブラウザで機器認証のコードを聞かれます。
前回と同じ手順です。npm は2FAのコードを聞かれます。

**うまくいったかの確認(私がやります):**
`https://www.npmjs.com/package/jp-payroll-mcp` が日本語で始まっていること。
`https://github.com/kishida-devil/jp-payroll-mcp` も同様。

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
