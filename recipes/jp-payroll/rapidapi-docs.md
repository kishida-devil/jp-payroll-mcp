# 日本の給与・社会保険・労働法API

日本の給与計算は公開データでできているのに、正しく出すのが難しい領域です。
料率は47都道府県ぶんの表に分かれて毎年3月に変わり、源泉徴収税額表は国税庁のワークブック、
最低賃金は毎年10月に**都道府県ごとに違う日付で**改定されます。そして「どの数字を使うか」を
決める規則のいくつかは、法律ではなく**昭和36年の通達**に書かれています。

このAPIはそれらをまとめて、給与計算が実際に問う形で答えます。

## すぐ試す

```bash
curl -X GET \
  'https://japan-payroll-and-labor-constants.p.rapidapi.com/v1/payroll?prefecture=Tokyo&monthly_salary=350000&birth_date=1986-04-01&dependants=2' \
  -H 'X-RapidAPI-Key: あなたのキー' \
  -H 'X-RapidAPI-Host: japan-payroll-and-labor-constants.p.rapidapi.com'
```

1回の呼び出しで、健康保険・介護保険・厚生年金・子ども子育て拠出金・雇用保険・
源泉所得税・手取り・事業主負担が返ります。

## 自前で書くと外れる5か所

例外的な事例ではありません。**毎月起きる普通の処理**です。しかも間違えても計算は完走し、
それらしい数字が出るので、指摘されるまで気づきません。

**1. 資格喪失は退職日の翌日。**3月31日退職なら喪失は4月1日で、**3月分の保険料はかかります**。
3月30日退職なら喪失は3月31日で、その月はかかりません。東京・40歳・月給30万円で
**労使合計95,130円**の差が、1日で生まれます(健康保険法第36条・第156条第3項)。
`GET /v1/eligibility` が判定します。

**2. 年齢は誕生日の前日に上がる。**年齢計算ニ関スル法律により、4月1日生まれの人は
**3月31日に40歳**になります。介護保険料は「40歳に達した日の属する月」からなので、
**3月分から**引きます。1日生まれの人だけ、40歳・65歳・70歳・75歳のすべてが1か月早く動きます。
`GET /v1/age-milestones` が到達日を返します。

**3. 保険料は標準報酬月額にかかる。給与額ではない。**50等級の階段なので、同じ等級内の
昇給では変わらず、等級をまたぐと一気に変わります。**雇用保険だけは実際の賃金**にかかります。
従業員負担分の端数は**0.50円以下切り捨て・超過切り上げ**で、四捨五入ではありません。

**4.「2等級以上」は健康保険法に書いていない。**随時改定の要件は**昭和36年 保発第4号**という
通達にあり、等級表の上下限付近には**1等級で足りる例外が4つ**あります。健康保険と厚生年金は
別々に判定するので、昇給が片方だけ動かすことがよくあります。
`GET /v1/standard-remuneration/revision` が両方を判定し、通達を引用します。

**5. 賞与の上限は2種類で挙動が違う。**健康保険・介護保険・子ども子育て支援金は
**年度累計573万円**、厚生年金は**1回あたり150万円**。`GET /v1/bonus-insurance` が両方を当てます。

## 収録している範囲

| 分類 | エンドポイント |
|---|---|
| **給与** | 月次の給与明細、賞与保険料、割増賃金、通勤手当、休業免除、入社月・退職月、年齢の節目、バッチ |
| **標準報酬月額** | 定時決定、随時改定、休業終了時改定、年間平均による保険者算定、等級照会、50等級表、バッチ |
| **源泉所得税** | 月額表、日額表(丙欄含む)、電算機計算の特例、賞与の算出率表 |
| **料率** | 47都道府県の社会保険、事業の種類別の雇用保険、54業種の労災保険率 |
| **資格** | 被保険者区分(四分の三基準と20時間/88,000円/学生/51人)、年次有給休暇(比例付与含む) |
| **費用** | 1人を1年雇う費用。事業主負担込み |
| **被用者保険の外** | 国民年金。国民健康保険に全国一律の額が無い理由 |
| **最低賃金** | 平成14年度まで遡って、ある日に効力を持つ額 |
| **消費税** | 日付指定の税率、軽減8%、1989年以降のすべての改定 |
| **カレンダー** | 1955〜2027年の祝日、営業日計算、銀行の休業日 |
| **番号** | 法人番号・適格請求書登録番号のチェックディジット(Peppol ICD 0188)、一括検査、13桁目の算出 |
| **条文** | answers が引用した条項の全文(e-Gov より) |
| **メタ** | 受け付ける値の一覧、データの鮮度 |

**43エンドポイント。**全スキーマは Endpoints タブに、OpenAPI 3.0 の仕様書は
`https://japan-payroll-api.tsumugi.workers.dev/openapi.json` で配信しています。

**応答は小さくできます。**どのエンドポイントにも `?detail=compact` を付けると、出典・注記・
条文の引用を落として数字だけになります。バッチではおよそ10分の1です。何を落としたか、
どう取り戻すかは `omitted` に載るので、黙って消えることはありません。

## 「できない」も理由つきで返します

届出の要否を判定するエンドポイントは、結論だけでなく**そう判断した根拠**を返します。
行動につながらない `false` は答えではありません。

```json
{
  "applies": false,
  "blocking_reasons": [
    "固定的賃金の変動がありません (保発第4号 記2(2))。残業手当など非固定的賃金だけの増減では月額変更になりません。"
  ],
  "schemes": {
    "health":  { "current_grade": 22, "extended_grade_gap": 3 },
    "pension": { "current_grade": 19, "extended_grade_gap": 3 }
  }
}
```

## 引用は本文まで辿れます

条文名を挙げて「あとは自分で探してください」では half an answer です。
健康保険法・厚生年金保険法・徴収法など8法令の条項を同梱してあるので、その範囲は同じ呼び出しで**実際の文言**にできます。労働基準法や所得税法のように同梱していない法令は、**推測した本文を返さずに断り、e-Gov の該当条文へ案内します。**

```bash
# 条文そのもの
GET /v1/statute?ref=健康保険法第43条

# 判定が引用したものを、その答えに添える
GET /v1/standard-remuneration/revision?…&include=statute_text
```

**実務で書かれる形はすべて解決します。**略称(健保法43条、厚年法81条の2、徴収法11条)、
「第」の省略、項単位の指定、全角数字。e-Gov の公式略称は実務のものと違い、
e-Gov は「厚生年金法」ですが、実務では「厚年法」と書きます。**両方通ります。**

8法令28条項を、ビルド時に e-Gov 法令API から取得しています。範囲外は近似せず断ります。
`GET /v1/statute/index` に収録の全件があります。

## 数字の出どころ

すべて公式の資料から機械的に抽出し、**そこに印刷されている値と突き合わせて**います。
式の説明から書き直したものではありません。

| データ | 出典 |
|---|---|
| 社会保険料率・等級表 | 全国健康保険協会 保険料額表 |
| 源泉徴収税額表 | 国税庁 源泉徴収税額表 |
| 雇用保険 | 厚生労働省 |
| 最低賃金 | 厚生労働省 地域別最低賃金 |
| 祝日 | 内閣府 |
| 改定の規則 | e-Gov 法令検索、厚生労働省 法令等データベース、日本年金機構 |

**変更のたびに4,549件の表明**を実行します。中核は、協会けんぽの保険料額表に印刷された額と
**250通り(5都道府県×50等級)**を突き合わせ、国税庁の月額表の**公表2,079セル全部**と照合するものです。

`GET /v1/data-freshness` が各データの収録範囲と次の改定時期を返すので、
**古くなったことが黙って進行しません。**

## エラー

エラーには文章と別に**変わらないコード**が付きます。英文を照合するのではなく、
コードで分岐してください(文章は改善で変わることがあります)。

| コード | 意味 |
|---|---|
| `invalid_request` | パラメータが欠落・不正・範囲外 |
| `missing_parameter` | 必須のパラメータが無い |
| `empty_parameter` | パラメータはあるが値が空 |
| `unknown_prefecture` | 都道府県を解決できない |
| `out_of_coverage` | 入力は正しいが、公表されている範囲の外 |
| `batch_too_large` | プランの上限を超える人数 |

多くの400には、受け付ける値を挙げた `hint` が付きます。
`GET /v1/enums` は受け付ける値の集合をすべて返すので、400を食らって知るのではなく、
**ビルド時に型を作れます。**

## バッチ

`POST /v1/payroll/batch` が1回の呼び出しで全社員分を計算し、合計を返します。
検証に落ちた行は index と id を持って `errors` に入り、**残りはそのまま計算されます。**
`?detail=compact` で支払額だけにすると、応答はおよそ10分の1です。

## プランの選び方と、評価のしかた

**購読せずに試せます。**同じAPIが鍵なしで
`https://japan-payroll-api.tsumugi.workers.dev` でも答えます。日次の上限はなく、
違いはバッチの人数だけです。**まずそこで作ってください。**10人を超えるバッチが要るとき、
あるいは月間の割当とサポートが要るときに、ここで購読してください。
このページの無料BASICは日次の回数が少なく、疎通の確認には足りますが開発には足りません。

**無料と有料の線は、機能ではなくバッチ人数です。**すべてのエンドポイント、すべての条文引用、
すべての判定は全プランに入っています。払うのは「給与計算を1回で回す」ことに対してで、
最大500人、それを毎月やるだけの回数です。

**帯域は別に従量課金なので、応答サイズは金額です。**500人のバッチは詳細ありで約920KB、
`?detail=compact` で約135KB(実測。およそ14.5%)。応答は**自分の大きさと、compact にした場合の見込み**を返します。
内訳ではなく支払額が要るときは compact を使ってください。

プランと価格は Pricing タブが正です。古くならないよう、ここには書いていません。

## 正直に書いておくこと

- **届出の要否を判定するものであって、届出ではありません。**APIから見えない事実で決まる
  論点があります — 季節変動が「業務の性質上例年発生することが見込まれる」か、手当が
  実費弁償か、本人が同意したか。それらは入力として宣言してもらい、応答に echo します。
  **日本年金機構による保険者算定は、なお別の結論に至ることがあります。**
- **住民税は算出しません。**前年所得と市区町村で決まり、事業主が計算するものではありません。
  `/v1/payroll` は渡された額をそのまま差し引きます。
- **年末調整は対象外です。**
- **チェックディジットが通っても法人とは限りません。**個人事業者の登録番号も同じ規則を
  満たすため、番号から保有者は判別できません。
- **一次資料に辿れなかった実務論点**は、断定せず `guidance.fixed_pay.unverified` として
  返します — 家族手当が固定的賃金に当たるか、有給が支払基礎日数にどう入るか、年俸制の扱い。
  解説書は3点とも一致していますが、省庁が文書で述べているものを見つけられませんでした。
- **政府機関の承認・関与・保証を受けたものではありません。**法定の届出に用いる前に、
  出典と照合してください。

## AIアシスタントから使う

同じ規則を MCP サーバとしても公開しています。無料・鍵不要です。

```bash
npx jp-payroll-mcp
```

対話で問うためのものです。**ソフトウェアに組み込むなら、こちらのAPIを使ってください。**

---

## English

Japanese payroll, social insurance and labour law as an HTTP API. Premiums for all
47 prefectures, withholding income tax, standard remuneration decisions and
revisions (定時決定・随時改定), leave premium exemptions, overtime, annual leave,
minimum wage back to FY2002, consumption tax by date, holidays with business-day
arithmetic, and corporate/invoice number validation. 43 endpoints, OpenAPI 3.0.

Every figure is extracted programmatically from the official government source and
verified against the values printed in it — 250 combinations (5 prefectures × 50 grades)
against the 協会けんぽ workbook, all 2,079 published cells of the National Tax
Agency withholding table, 4,549 assertions on every change.

Every answer names the statute or ministerial notice it rests on, and
`?include=statute_text` attaches the actual text of whatever it cited. Judgements
that come back `false` carry the reason, because a verdict you cannot act on is
not an answer. Where the source data does not cover a date, the API refuses rather
than returning last year's figure.

Try it without subscribing at `https://japan-payroll-api.tsumugi.workers.dev` —
same API, no key, no daily cap. The paid line here is batch size: ten employees
per call on BASIC, five hundred on a paid plan.

**Not endorsed by, affiliated with, or guaranteed by any government agency.**
Verify against the source before relying on a figure for a statutory filing.
