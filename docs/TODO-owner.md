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

## 0. RapidAPI に有料プランがあるか確認する 🔴 これが先

- [ ] 確認した(あった / 無かった)

**なぜ最初か:** **未設定なら、他の全部が空振りになります。**
無料のBASICしか無ければ、どれだけ人が来ても購読は0のままです。
私からは確認できません — ページはSPAで取得できず、未購読では403しか返らないためです。

https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants の
**Pricing** タブを開いて、BASIC以外のプランがあるか見てください。
無ければ教えてください。価格設計から一緒にやります。

---

## 1. RapidAPI の出品説明を差し替える 🔴 最優先

- [ ] 実行する

**なぜ最優先か:** いまページを訪れた人全員が、**404を返すコード**を渡されています。

```
japan-payroll-api.p.rapidapi.com                  → 404 API doesn't exists
japan-payroll-and-labor-constants.p.rapidapi.com  → 403 You are not subscribed(正しい)
```

Quick start をコピーして叩いた人は「動かないAPI」と判断して離れます。
購読が0であることの、これ以上の説明は要りません。

**手順**

1. https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants の編集画面
2. Description を、下のファイルの中身で丸ごと置き換える
3. 保存

```bash
python D:\Claude\tsumugi\scripts\build-listing.py
```

**確かめ方:** 保存後、ページの Quick start をそのままコピーして叩く。
**403(未購読)が返れば成功**です。404 なら差し替わっていません。

---

## 2. 公式MCPレジストリに登録する

- [ ] 実行する

**なぜ:** レジストリを `payroll` で検索すると、カナダと台湾の給与MCPが出ます。
**日本がありません。**`package.json` の `mcpName` は最初から入っていて、登録だけが
されていませんでした。`server.json` は作成済みで、レジストリの検証も通っています
(`✅ server.json is valid`)。

**手順**

cmd.exe では `./` が使えません。バックスラッシュで。

```bash
D:\Claude\tsumugi\mcp\mcp-publisher.exe login github
```

表示されたコードを https://github.com/login/device に入力。続けて:

```bash
D:\Claude\tsumugi\mcp\mcp-publisher.exe publish
```

(どのシェルでも同じで動きます。連結も cd も要りません)

**確かめ方:**

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=jp-payroll"
```

いまは0件。1件返れば成功です。

---

## 3. Zenn 記事を確認して公開する

- [ ] 内容を確認した
- [ ] 公開した

**なぜ:** 「社会保険料 API」「標準報酬月額 計算」で検索した日本人が辿り着く場所が、
いまどこにもありません。RapidAPIもMCPレジストリも、**すでにそこにいる人**にしか届きません。

宣伝ではなく、読んで役に立つ内容にしてあります(自前実装で外れる5か所)。
**数字はすべてAPIから取っており**、実装とずれたらテストが落ちるようにしてあります。

```bash
notepad D:\Claude\tsumugi\docs\articles\zenn-payroll-traps.md
```

**あなたの名前で出るもの**なので、私の判断だけでは公開しません。
直したい箇所があれば言ってください。書き直します。

公開するときは冒頭の `published: false` を `true` に。

---

## 4. GitHub の topics を設定する

- [ ] 実行する

**なぜ:** topics が空で、GitHub のトピック検索に一切載りません。

```bash
gh repo edit kishida-devil/jp-payroll-mcp --add-topic mcp --add-topic model-context-protocol --add-topic japan --add-topic payroll --add-topic japanese --add-topic social-insurance --add-topic hr --add-topic labor-law --add-topic api --add-topic claude
```

`gh` が未認証なら `gh auth login` から。

**確かめ方:**

```bash
curl -s https://api.github.com/repos/kishida-devil/jp-payroll-mcp | python -c "import sys,json;print(json.load(sys.stdin)['topics'])"
```

---

## 5. npm を再公開する(急がない)

- [ ] 実行する

**なぜ:** npm検索の順位はテキスト一致で決まっており、`給与計算`(競合43,720件)と
`社会保険`(61,398件)が **keywords 止まりで圏外**でした。description に移してあります。
`社労士` では既に1位・スコア163.9で、首位の99.6を上回っています。
**同じ強さで一致できれば上位に入ります。**

版を上げてから公開してください(同じ版は再公開できません)。

```bash
npm publish --prefix D:\Claude\tsumugi\mcp
```

**確かめ方:**

```bash
curl -s "https://registry.npmjs.org/-/v1/search?text=%E7%B5%A6%E4%BA%8E%E8%A8%88%E7%AE%97&size=20" | python -c "import sys,json;print([o['package']['name'] for o in json.load(sys.stdin)['objects']])"
```

`jp-payroll-mcp` が並びに入れば成功です。

---

## 済んだもの

- [x] npm に 0.4.0 を公開(2026-08-29)。0.2.0 から11周ぶんが届いた
- [x] npm の 2FA リカバリコード再発行
- [x] Discord Webhook の再発行と `.env` 差し替え、実送信まで確認
