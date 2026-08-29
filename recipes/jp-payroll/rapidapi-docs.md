# Japan Payroll and Labor Constants
## 日本の給与・社会保険・労働法API

日本の給与計算は公開データでできているのに、正しく出すのが難しい領域です。
料率は47都道府県ぶんの表に分かれて毎年3月に変わり、源泉徴収税額表は国税庁の
ワークブック、最低賃金は毎年10月に**都道府県ごとに違う日付で**改定されます。
そして「どの数字を使うか」を決める規則のいくつかは、法律ではなく**昭和36年の通達**に
書かれています。

このAPIは、それらをまとめて、給与計算が実際に問う形で答えます。

### すぐ試す

```bash
curl -X GET \
  'https://japan-payroll-and-labor-constants.p.rapidapi.com/v1/payroll?prefecture=Tokyo&monthly_salary=350000&birth_date=1986-04-01&dependants=2' \
  -H 'X-RapidAPI-Key: あなたのキー' \
  -H 'X-RapidAPI-Host: japan-payroll-and-labor-constants.p.rapidapi.com'
```

1回の呼び出しで、健康保険・介護保険・厚生年金・子ども子育て拠出金・雇用保険・
源泉所得税・手取り・事業主負担が返ります。

### 自前で書くと外れる5か所

どれも例外ではなく、毎月起きる普通の処理です。**間違えても計算は完走し、
それらしい数字が出ます。**

**1. 資格喪失は退職日の翌日。**3月30日退職なら3月分の保険料はかからず、3月31日退職なら
かかります。東京・40歳・月給30万円で**労使合計95,130円**の差が、1日で生まれます
(健康保険法第36条・第156条第3項)。`GET /v1/eligibility` が判定します。

**2. 年齢は誕生日の前日に上がる。**4月1日生まれの人の介護保険料は**3月から**引きます
(年齢計算ニ関スル法律・介護保険法第9条)。1日生まれだけ、40歳・65歳・70歳・75歳の
すべてが1か月早く動きます。

**3.「2等級差」は健康保険法に書いていない。**随時改定の要件は**昭和36年 保発第4号**という
通達にあり、しかも1等級で足りる例外が4つあります。条文だけを追うと辿り着けません。

**4. 課税標準が2つある。**社会保険料は標準報酬月額(50等級の階段)、雇用保険料は
実際に支払った賃金。残業した月、雇用保険料は増えても社会保険料は等級が動かない限り
増えません。従業員負担分の端数は**0.50円以下切り捨て・超過切り上げ**で、四捨五入ではありません。

**5. 最低賃金は「毎年10月」とは限らない。**発効日は都道府県ごとに違い、令和7年度の
秋田県は**2026年3月31日発効**でした。「10月に一律」と実装すると半年近く違う額を使います。
最低賃金法第4条は、達しない賃金を定める労働契約をその部分について**無効**とします。

### 答えには必ず根拠が付きます

判定系のエンドポイントは、結論だけでなく**そう判断した条文**を返します。
「できません」と答えるときも理由を返します。

```json
{
  "applies": false,
  "blocking_reasons": [
    "固定的賃金の変動がありません (保発第4号 記2(2))。残業手当など非固定的賃金だけの増減では月額変更になりません。"
  ]
}
```

引用した条文の**本文そのもの**も `?include=statute_text` で取れます。
数字を信じるかどうかを、出典に当たって決められます。

### 正直に書いておくこと

- **届出の代わりにはなりません。**保険者算定は日本年金機構の判断で異なることがあり、
  APIから見えない事実で決まる論点もあります。
- **住民税は算出しません。**市区町村が課して事業主に通知するものだからです。
- **国民健康保険の額も返しません。**市町村の条例で決まり、全国一律の額が存在しません。
  「無い」ことを理由つきで返します。
- データは埋め込みで自動更新されません。`GET /v1/data-freshness` が各データの収録範囲と
  次の改定時期を返すので、**古くなったことが見えます。**範囲外の日付は、古い数字を返さずに
  422で断ります。

---

*English below.*

Japanese payroll is public data and still hard to get right. The rates live in 47
separate prefectural spreadsheets that change every March, the withholding tables
are National Tax Agency workbooks, the minimum wage changes every October on a
different date in each prefecture, and several of the rules that decide *which*
number applies are in 1961 ministerial notices rather than in the Acts.

This API packages all of it, and answers the questions payroll actually asks.

## Quick start

```bash
curl -X GET \
  'https://japan-payroll-and-labor-constants.p.rapidapi.com/v1/payroll?prefecture=Tokyo&monthly_salary=350000&birth_date=1986-04-01&dependants=2' \
  -H 'X-RapidAPI-Key: YOUR_KEY' \
  -H 'X-RapidAPI-Host: japan-payroll-and-labor-constants.p.rapidapi.com'
```

One call returns health insurance, long-term care, pension, child support,
employment insurance, withholding income tax, net pay, and the employer's share.

## The five things that make hand-rolled payroll wrong

These are not obscure edge cases. They are the ordinary rules, and they are all
counter-intuitive enough that a plausible implementation gets them wrong.

**Coverage ends the day *after* the last day worked.** An employee leaving on 31
March loses coverage on 1 April and still owes March's premium. Leaving on 30
March owes nothing. A full month of both employee and employer premium turns on a
single day. `GET /v1/eligibility` decides it.

**An age is attained the day *before* the birthday.** 年齢計算ニ関スル法律 puts
attainment on the preceding day, so someone born on 1 April turns 40 on 31 March
and long-term care starts a month earlier than a naive calculation gives.
`GET /v1/age-milestones` returns the exact dates for 40, 65, 70 and 75.

**Premiums are charged on 標準報酬月額, not salary.** It is a 50-grade step
function, so a raise inside a band changes nothing and a raise across one changes
everything — *except* employment insurance, which is charged on actual salary.
The employee share rounds half **down**, not half up.

**The "two grades or more" test for 随時改定 is not in 健康保険法.** It comes from
昭和36年 保発第4号, a ministerial notice, together with four exceptions near the
top and bottom of each table where a single grade is enough. Health insurance and
pension are judged separately, so a raise routinely moves one and not the other.
`GET /v1/standard-remuneration/revision` judges both and cites the notice.

**Bonus caps behave differently from each other.** Health, long-term care and
child support cap at 5,730,000 yen *cumulatively across the fiscal year*; pension
caps at 1,500,000 yen *per payment*. `GET /v1/bonus-insurance` applies both.

## What is covered

| Group | Endpoints |
|---|---|
| **Payroll** | Monthly payslip, bonus premiums, overtime (割増賃金), commuting allowance, leave exemptions, joining/leaving months, age milestones, batch |
| **Standard remuneration** | 定時決定, 随時改定, leave-end revision, annual-average 保険者算定, grade lookup, the 50-grade table, batch |
| **Withholding tax** | 月額表, 日額表 (including the 丙 column), 電算機計算の特例, bonus rate table |
| **Rates** | Social insurance for all 47 prefectures, employment insurance by business type, 労災保険率 for 54 trades |
| **Eligibility** | 被保険者区分 (the three-quarters test and the 20 hours / ¥88,000 / student / 51-staff route), 年次有給休暇 including the proportional table |
| **Cost** | What a year of employing someone costs, employer share included |
| **Outside employee insurance** | 国民年金, and why 国民健康保険 has no national figure to return |
| **Minimum wage** | Point-in-time rate for any date back to FY2002 |
| **Consumption tax** | The rate in force on a date, the reduced 8%, every change since 1989 |
| **Calendar** | Public holidays 1955–2027, business-day arithmetic, the statutory banking calendar |
| **Numbers** | 法人番号 and qualified invoice number check digits (Peppol ICD 0188), bulk validation, check-digit computation |
| **Statutes** | The full text of every provision the answers cite, from e-Gov |
| **Meta** | Enum reference, dataset freshness |

43 endpoints. Full schemas are on the Endpoints tab, and the OpenAPI 3.0 spec is
served live at `https://japan-payroll-api.tsumugi.workers.dev/openapi.json` if you
would rather generate a client.

**Every answer can be made smaller.** Add `?detail=compact` to any endpoint to drop
the attribution, notes and statutory citations and keep the figures — roughly a
tenth the size on a batch run. What was dropped, and how to get it back, is listed
in `omitted` rather than silently removed.

## Judgement endpoints answer "no" usefully

The endpoints that decide whether a filing is due return the reason, not just the
verdict. A `false` you cannot act on is not an answer.

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

Every answer names the statute or notice it rests on, so a filing can be checked
against the source rather than against this API.

## Citations resolve to their text

Naming a statute and leaving you to find it is half an answer. Every provision this API
cites is bundled, so a citation can be turned into the actual words in the same call:

```bash
# the provision on its own
GET /v1/statute?ref=健康保険法第43条

# or attached to whatever a judgement cited
GET /v1/standard-remuneration/revision?…&include=statute_text
```

`include=statute_text` works on any endpoint and attaches only what that response
actually cited — an endpoint that cites nothing gets nothing.

Citations are written many ways in practice and all of them resolve: abbreviations as
practitioners use them (`健保法43条`, `厚年法81条の2`, `徴収法11条`), a missing 第,
paragraph-level references, full-width digits. The official e-Gov abbreviations are not
the ones people write — e-Gov calls it 厚生年金法, everyone writes 厚年法 — so both work.

28 provisions across 8 laws, taken from the e-Gov 法令API at build time. Anything
outside that set is refused rather than approximated: `GET /v1/statute/index` lists
exactly what is available.

## Where the numbers come from

Every figure is extracted programmatically from the official source and verified
against the values printed in it — not reimplemented from a description of the
formula.

| Data | Source |
|---|---|
| Social insurance rates, grade table | 全国健康保険協会 保険料額表 |
| Withholding tax tables | 国税庁 源泉徴収税額表 |
| Employment insurance | 厚生労働省 |
| Minimum wage | 厚生労働省 地域別最低賃金 |
| Public holidays | 内閣府 |
| Revision rules | e-Gov 法令検索, 厚生労働省 法令等データベース, 日本年金機構 |

The test suite runs **3,638 assertions** on every change. Its core compares
computed premiums against the amounts printed in the 協会けんぽ workbook for 250
prefecture × grade combinations, and against all 2,079 published cells of the
National Tax Agency withholding table.

`GET /v1/data-freshness` reports what each dataset currently covers and when its
next revision is due, so a stale figure is visible rather than silent.

## Errors

Errors carry a stable `code` alongside the prose, so you can branch on the code
rather than matching English sentences that may improve later.

| Code | Meaning |
|---|---|
| `invalid_request` | A parameter was missing, malformed or out of range |
| `missing_parameter` | A required parameter was absent |
| `unknown_prefecture` | The prefecture could not be resolved |
| `out_of_coverage` | Valid input, but outside the range published |
| `batch_too_large` | More rows than the plan allows |

Most 400s also carry a `hint` naming the accepted values.

`GET /v1/enums` returns every closed set of values the API accepts, so client
types can be generated at build time instead of discovered from a 400.

## Batch

`POST /v1/payroll/batch` computes a whole run in one call, with totals. Rows that
fail validation come back as errors carrying their index and id; the rest still
compute. Add `?detail=compact` for payout figures only, roughly a tenth the
response size.

BASIC is limited to 10 employees per batch. Paid plans allow up to 500.

## Honest limits

- **These endpoints decide whether a filing is due. They are not the filing.**
  Several rules turn on facts an API cannot see — whether a seasonal swing is
  「業務の性質上例年発生することが見込まれる」, whether an allowance is 実費弁償,
  whether the employee consented. Those are declared inputs, echoed back in the
  response. 保険者算定 by the insurer can still reach a different conclusion.
- **Resident tax is never derived.** It depends on the previous year's income and
  the municipality, and is levied by the municipality rather than computed by the
  employer. `/v1/payroll` deducts whatever figure you pass.
- **Year-end adjustment (年末調整) is not covered.**
- **A passing invoice check digit does not identify a corporation.** Sole
  proprietors satisfy exactly the same rule, so the holder cannot be inferred
  from the number.
- **A few practice points could not be sourced to a primary document** and are
  returned as `guidance.fixed_pay.unverified` rather than asserted: whether
  家族手当 counts as fixed pay, how paid leave counts toward 支払基礎日数, and how
  年俸制 is treated. Commentary agrees on all three; the ministries do not appear
  to say so in writing.
- Not endorsed by, affiliated with, or guaranteed by any government agency.
  Verify against the source before relying on a figure for a statutory filing.

## Using it from an AI assistant

The same rules are published as an MCP server, free and without a key:

```bash
npx jp-payroll-mcp
```

It is for answering questions interactively. For embedding the calculations in
software, use this API.
