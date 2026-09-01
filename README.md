# jp-payroll-mcp

**日本の給与計算・社会保険・労務を、表を引くのではなく計算して返すAPIとMCPサーバーです。**
47都道府県の保険料率、源泉所得税、標準報酬月額の決定と改定、休業中の保険料免除、
割増賃金、年次有給休暇、最低賃金、営業日計算まで。**答えには根拠の条文または通知が付きます。**

公表されている料額表・税額表と1セルずつ突き合わせ、変更のたびに **4,579件** の検証を実行します。

## 使いかたは2通り

**MCPサーバー** — AIアシスタントに日本語で聞く。28ツール、無料、APIキー不要:

```bash
claude mcp add jp-payroll -- npx -y jp-payroll-mcp
```

**HTTP API** — ソフトウェアに組み込む。43エンドポイント、OpenAPI 3.0、一括処理:

```bash
curl "https://japan-payroll-api.tsumugi.workers.dev/v1/payroll?prefecture=Tokyo&monthly_salary=350000&birth_date=1986-04-01"
```

MCPサーバーはAPIの薄い層なので、どちらも同じ答えを返します。
人が聞くのか、プログラムが聞くのかの違いです。

### なぜ要るのか

自前で書くと、**もっともらしく見えて間違っている数字**が出ます。3月31日退職と3月30日退職では
1か月分の社会保険料が動きます(東京・40歳・月給30万円で労使合計95,130円)。4月1日生まれの人は
3月31日に40歳になるので介護保険料が1か月早く始まります。随時改定の「2等級以上」は健康保険法に
書いておらず、昭和36年保発第4号にあります。

- 解説記事: **[日本の給与計算・社会保険をAPIとMCPにしました](https://zenn.dev/kishida_devil/articles/9d5a645a105c0b)**
- MCPサーバーの詳細: **[mcp/README.md](mcp/README.md)**
- 大量処理の有料プラン: [RapidAPI](https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants)

以下は英語の詳細仕様です。

---

Japanese payroll, social insurance and labour law, computed rather than looked up —
premiums for all 47 prefectures, withholding tax, standard remuneration decisions and
revisions, leave exemptions, minimum wage — with the statute or ministerial notice each
answer rests on.

Verified against the published tables cell by cell: **4,579 assertions** on every change.

## Two ways in

**As an MCP server**, for asking questions through an AI assistant. 28 tools, free, no key:

```bash
claude mcp add jp-payroll -- npx -y jp-payroll-mcp
```

**As an HTTP API**, for building it into software. 43 endpoints, OpenAPI 3.0, batch:

```bash
curl "https://japan-payroll-api.tsumugi.workers.dev/v1/payroll?prefecture=Tokyo&monthly_salary=350000&birth_date=1986-04-01"
```

The MCP server is a thin layer over the API, so both give the same answers. Which you
want depends on whether a person or a program is asking.

- MCP server source and its own README: [`mcp/`](mcp/) · [English](mcp/README.en.md)
- Live API: `https://japan-payroll-api.tsumugi.workers.dev`
- OpenAPI spec: [`/openapi.json`](https://japan-payroll-api.tsumugi.workers.dev/openapi.json)

## Related tools

Japanese statutory MCP servers mostly *retrieve* — they hand you the text of a law and
leave the reasoning to you. This one *computes*, and returns the provision it relied on.
They fit together rather than compete:

| | "What does the law say?" | "So what do I pay?" |
|---|---|---|
| [`labor-law-mcp`](https://www.npmjs.com/package/labor-law-mcp) | 45 labour and social insurance laws, MHLW and JAISH notices | — |
| [`tax-law-mcp`](https://www.npmjs.com/package/tax-law-mcp) | 24 tax laws, 17 NTA circulars, tribunal decisions | — |
| [`hourei-mcp-server`](https://www.npmjs.com/package/hourei-mcp-server) | Any Japanese law, via e-Gov | — |
| **jp-payroll-mcp** | The 28 provisions it cites, in full | Premiums, withholding tax, grade revisions, exemptions |

If you already run one of those, add this alongside it. An assistant with both picks the
right one per question.

## Why this exists

- **No consolidated API exists.** Developers assemble this from 協会けんぽ, 厚生労働省 and
  each prefectural labour bureau separately.
- **The rules are fiddly.** Premiums are computed on the *standard monthly remuneration*
  (a 50-grade step function), not on actual salary — except employment insurance, which
  uses actual salary. Pension caps at grade 32. Long-term care applies only to ages 40–64.
  The employee share rounds *half down* (≤ 0.50 yen truncates). Getting one of these wrong
  produces numbers that look plausible and are wrong.

## MCP server

Source in [`mcp/`](mcp/), with its own [README](mcp/README.md) (日本語) ·
[English](mcp/README.en.md). Test it with `npm run mcp:test` — it drives a real stdio
transport with the real MCP client, because a tool with a broken handler still lists
perfectly and only fails when something calls it.

The MCP server is free and always will be. It is a distribution channel rather than a
revenue one: npm pays nothing and MCP has no billing of its own. That is deliberate —
the problem was never billing, which RapidAPI already handles, but discovery, and MCP
is where the traffic for Japanese statutory data measurably is.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | API info and endpoint list |
| **Payroll and insurance** | |
| `GET /v1/prefectures` | All 47 prefectures with JIS codes |
| `GET /v1/insurance-rates?prefecture=Tokyo` | Health, long-term care, pension, child-support rates |
| `GET /v1/standard-remuneration?remuneration=350000` | Grade lookup for a monthly amount |
| `GET /v1/standard-remuneration/table` | Full 50-grade table |
| `GET /v1/employment-insurance?business_type=general` | Employment insurance rates |
| `GET /v1/payroll?prefecture=Tokyo&monthly_salary=350000&age=40` | Full deduction breakdown |
| **Minimum wage** | |
| `GET /v1/minimum-wage?prefecture=Tokyo&date=2020-01-01` | Rate in effect on a date |
| `GET /v1/minimum-wage/history?prefecture=Tokyo` | Full history since FY2002 |
| **Calendar** | |
| `GET /v1/holidays?year=2026` | Public holidays (or `from=`/`to=` for a range) |
| `GET /v1/holidays/check?date=2026-01-01` | Holiday / weekend / business-day flags |
| `GET /v1/business-days?from=&to=` | Count business days in a range |
| `GET /v1/business-days/shift?date=&days=1` | Move N business days forward or back |
| **Tax** | |
| `GET /v1/consumption-tax?date=&amount=&reduced=` | Rate in force, optionally applied to an amount |
| `GET /v1/consumption-tax/history` | Every rate change since 1989 |
| **Identifiers** | |
| `GET /v1/corporate-number/validate?number=8700110005901` | 法人番号 check digit (Peppol ICD 0188) |
| `GET /v1/corporate-number/check-digit?base=700110005901` | Check digit for a 12-digit base number |
| `GET /v1/invoice-number/validate?number=T8700110005901` | Qualified invoice registration number |
| **Withholding tax** | |
| `GET /v1/withholding-tax?taxable_amount=300000&dependants=2` | Monthly withholding income tax (月額表) |
| `GET /v1/withholding-tax/daily?taxable_amount=12000&column=hei` | Daily table (日額表), including the 丙 column |
| `GET /v1/withholding-tax/computer?taxable_amount=400000` | Same, by the formula method (電算機計算の特例) |
| **Bonuses** | |
| `GET /v1/bonus-tax?bonus=500000&previous_month_pay=350000` | Withholding on a bonus (賞与の算出率表) |
| `GET /v1/bonus-insurance?prefecture=Tokyo&bonus=800000&age=40` | Social insurance on a bonus, with both caps |
| **Standard remuneration decisions** | |
| `GET /v1/standard-remuneration/regular?months=350000:30,352000:31,349000:30` | 定時決定 (算定基礎) from April–June |
| `GET /v1/standard-remuneration/revision?current_remuneration=&months=&fixed_pay_change=` | Is a 随時改定 (月額変更) due? |
| `GET /v1/standard-remuneration/leave-end?kind=childcare&current_remuneration=&months=` | Revision on returning from leave |
| `POST /v1/standard-remuneration/annual-average` | 年間平均による保険者算定, for seasonal work |
| **Eligibility and leave** | |
| `GET /v1/eligibility?month=2026-03&left_on=2026-03-30` | Is a premium due in a joining or leaving month? |
| `GET /v1/leave-exemption?kind=childcare&start=&end=` | Which months a maternity or childcare leave exempts |
| `GET /v1/age-milestones?birth_date=1986-04-01` | When 40, 65, 70 and 75 are reached, and what changes |
| **Batch** | |
| `POST /v1/payroll/batch` | Up to 500 payslips in one call, with run totals |
| **Statutes** | |
| `GET /v1/statute?ref=健康保険法第43条` | Full text of a provision this API cites |
| `GET /v1/statute/index` | Every provision available, with its law |
| `include=statute_text` | Add to any endpoint to attach the text of whatever it cited |
| **Meta** | |
| `GET /v1/enums` | Every accepted enum value and error code |
| `GET /v1/data-freshness` | What each dataset covers and when it changes next |

`prefecture` accepts an English name (`Tokyo`, case-insensitive), Japanese (`東京` or
`東京都`), or a JIS code (`13`).

### The one call that matters

Running payroll for one employee is a single request:

```bash
curl "https://japan-payroll-api.tsumugi.workers.dev/v1/payroll?prefecture=Tokyo&monthly_salary=350000&age=40&dependants=2"
```

```
gross                    350,000
social insurance          -55,750
                       ----------
after social insurance   294,250   <- the base withholding tax is charged on
withholding income tax    -4,480
                       ----------
net pay                  289,770
```

That middle line is the point. Income tax is charged on pay **after** social insurance,
not on gross pay, and deriving it by hand is the mistake this endpoint exists to stop.
The response also carries the grade that was resolved, every premium split into employee
and employer shares, and which bracket produced the tax — so the arithmetic can be
audited rather than trusted.

Resident tax (住民税) is assessed by the municipality and notified to the employer; no API
can compute it. Pass `resident_tax=` and it will be subtracted from net pay.

Pass `income_tax=false` to get social insurance only.

### Before you integrate

- `GET /v1/enums` lists every accepted value — `business_type`, `column`, `calendar` —
  and every error code, so they can be read at build time instead of discovered from a 400.
- Errors carry a stable `code`. `invalid_request` and `missing_parameter` mean fix the
  call; `out_of_coverage` means the input was valid but falls outside what is published,
  which needs a different branch. Do not match on the English prose — it will change.
- `GET /v1/data-freshness` tells you how current each dataset is.

## Data

| Dataset | Coverage | Source |
|---|---|---|
| Social insurance rates | 47 prefectures, FY2026 (令和8年度), effective 2026-03 | [協会けんぽ 保険料額表](https://www.kyoukaikenpo.or.jp/g7/cat330/sb3150/r08/r8ryougakuhyou3gatukara/) |
| Standard remuneration table | 50 health grades / 32 pension grades | same |
| Employment insurance | 3 business types, FY2026, effective 2026-04-01 | [厚生労働省](https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000108634.html) |
| Minimum wage | 47 prefectures × 24 years (FY2002–FY2025) | [厚生労働省 地域別最低賃金](https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/minimumichiran/) |
| Public holidays | 1,067 days, 1955–2027 | [内閣府 国民の祝日について](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html) |
| Consumption tax | 4 rate periods since 1989, with reduced rate | [国税庁 No.6303](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6303.htm) |
| Corporate number check digit | algorithm, no dataset | [国税庁 チェックデジットの計算](https://www.houjin-bangou.nta.go.jp/documents/checkdigit.pdf) |
| Withholding tax (monthly) | 231 brackets + 9 high-income anchors, 令和8年分 | [国税庁 源泉徴収税額表](https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/01.htm) |
| Withholding tax (formula) | 4 statutory tables, 令和8年分以降 | [電算機計算の特例](https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/denshi_01.pdf) |

All figures are extracted programmatically from the official spreadsheets — not
transcribed by hand. See `scripts/` for the extractors.

### Why not the statute

Income tax figures come from the National Tax Agency's published tables rather than from
所得税法 via the e-Gov law API, because the statutory version omits the 2.1% reconstruction
surtax. At 105,000–107,000 yen the 乙 column is 3,700 yen in 別表第二 and 3,800 yen in
practice; below 105,000 yen it is 3% rather than 3.063%. The statute is the wrong source
for payroll.

Above 740,000 yen the table stops being a table: it becomes anchor points with a marginal
rate. Those anchors are not collinear — rounding is baked into each — so the published
anchor values are carried rather than recomputed. The 乙 column has only two anchors
(740,000 and 1,710,000) where 甲 has nine, and measuring the 乙 excess from a 甲 anchor
silently under-charges. That was a real bug here, caught by the cell-by-cell comparison.

### Citations resolve to text

Naming a statute and leaving the reader to find it is half an answer. Every provision
this API cites is bundled, so `健康保険法第43条` can be turned into its actual words in
the same round trip:

```bash
curl 'https://japan-payroll-api.tsumugi.workers.dev/v1/statute?ref=健康保険法第43条'
curl '…/v1/standard-remuneration/revision?…&include=statute_text'
```

Citations are written many ways in practice and all of them resolve — `健保法43条`,
`厚年法81条の2`, `徴収法11条`, a missing 第, paragraph-level references, full-width
digits. The e-Gov abbreviations are not the ones practitioners use (e-Gov calls it
厚生年金法; everyone writes 厚年法), so both are accepted.

Text comes from the e-Gov 法令API at build time rather than at request time: calling
out to e-Gov on every request would mean this API goes down when theirs does.

`scripts/extract-statutes.py` holds the one list of provisions, and the test suite
checks that every citation the code emits resolves — a citation added without a
provision to back it fails the build rather than silently returning nothing.

### Known gaps

- **The year-end adjustment tables are not included.** 令和8年分's
  「給与所得控除後の給与等の金額の表」 was not yet published as of 2026-08; the Tax Agency
  releases it around September. 令和8年度税制改正 also raises the minimum employment income
  deduction to 740,000 yen with effect from 2026-12-01, so that table changes too.
- **FY2026 minimum wage is not included.** As of 2026-08, revisions were still being
  issued prefecture by prefecture and take effect from October 2026. The API serves
  FY2025, which is the rate currently in force. This must be refreshed once all 47
  prefectures publish.
- **Employment insurance history is FY2026 only.** Earlier years were not verified
  against a primary source, so they are omitted rather than guessed.
- **Resident tax is out of scope.** It depends on the previous year's income and on
  the municipality, and it is levied by the municipality rather than computed by the
  employer, so `/v1/payroll` deducts whatever figure you pass and never derives one.
- **The judgement endpoints decide whether a filing is due; they are not the filing.**
  Several rules turn on facts an API cannot see — whether a seasonal swing is
  「業務の性質上例年発生することが見込まれる」, whether an allowance is 実費弁償, whether the
  employee consented. Those are declared inputs, echoed back in the response, and the
  insurer can still reach a different conclusion under 保険者算定.
- **Not every standard-remuneration route is covered.** 資格取得時決定 returns how long
  the decision stays in force but does not compute the initial 報酬月額 (健保法42条1項
  has four methods, three of which need figures about *other* employees). 二以上事業所
  勤務 — where remuneration from several employers is summed and the premium split
  between them — is not implemented at all. Neither is the re-anchoring that happens
  when fixed pay changes twice inside the three-month window.

- **A few practice points could not be sourced to a primary document** and are listed
  as `guidance.fixed_pay.unverified` in the response rather than being asserted:
  whether 家族手当 counts as fixed pay, how paid leave is counted toward 支払基礎日数,
  and how 年俸制 is treated. Secondary sources agree on all three; the ministries do
  not appear to say so in writing.

## Verification

`test/verify.mjs` runs 4,579 assertions against a live server. The core of it compares the
API's computed premiums to the **amounts printed in the official 協会けんぽ workbook** for
250 combinations (5 prefectures × 50 grades) — the published half-share figures, not a
reimplementation of the formula. It also checks:

- grade boundary contiguity, and that a boundary yen value belongs to the upper grade
- pension clamping at grades 1 and 32
- long-term care switching on at 40 and off at 65
- employment insurance charged on actual salary while other premiums use the grade
- point-in-time minimum wage (including the day before an effective date)
- prefecture resolution across all four input forms
- all 47 prefectures returning a valid payroll response
- business-day counts against an independently computed reference
- the 2026-09-22 国民の休日 (a holiday only because it sits between two others)
- one-off imperial holidays: 大喪の礼, 即位礼正殿の儀, 結婚の儀
- the corporate-number check digit against the worked example in the NTA PDF, and that
  every other check digit is rejected for the same base
- every published cell of the withholding tax table — 231 brackets x 8 甲 columns plus
  the 乙 column, 2,079 figures, compared against the National Tax Agency's own workbook
- that a passing invoice check digit is **not** attributed to a corporation: sole
  proprietors satisfy the same rule, so the holder cannot be inferred from the number
- all eight single-grade 随時改定 cases 日本年金機構 publishes — four for health, four
  for pension — each landing on the standard remuneration the table names, on both
  the real grade and the extended scale the implementation uses
- that health and pension are judged independently: a raise above the pension ceiling
  moves six health grades and no pension grade at all
- the 15-day 定時決定 fallback firing for 短時間就労者 and **not** for anyone else, and
  not in 随時改定 at any time
- that every closed set of values appears in `/v1/enums`, so a new enum cannot ship
  without reaching the endpoint integrators generate their types from

```bash
npx wrangler dev --port 8799
node test/verify.mjs

# or against production
BASE=https://japan-payroll-api.tsumugi.workers.dev node test/verify.mjs
```

## Develop / deploy

```bash
npm install
npx wrangler dev
npx wrangler deploy
```

Data is embedded in the bundle (~40 KB gzipped), so there is no database, no KV, and no
cold start.

Responses carry `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`.
An hour rather than a day, because rates change on known dates and a correction should
reach callers the same day; `stale-while-revalidate` keeps responses instant while the
refresh happens behind it. Note that **`workers.dev` responses are not cached at
Cloudflare's own edge** — every request invokes the Worker. A custom domain would enable
edge caching if that becomes worth doing.

Measured from Japan against the deployed Worker: median 65 ms, max 83 ms round trip;
gzip takes the 50-grade table from 6,841 to 1,041 bytes.

## Maintenance

Statutory figures change on fixed dates, and an API that misses a revision keeps
answering — with numbers that stopped being true. Two mechanisms guard against that.

**The API reports its own staleness.** `GET /v1/data-freshness` states what each dataset
covers and when it is next due to change, and the main data responses carry a `freshness`
marker. A caller can see a stale figure even if our monitoring failed.

**A weekly job watches the sources.**

```bash
npm run watch          # fingerprints each source, alerts Discord on change
npm run watch:dry      # same, without notifying
```

It checks two independent things, because either alone leaves a gap: the source file's
hash and `Last-Modified` (catches a silent re-issue), and the calendar (catches the case
where a ministry publishes the revision at a *new* URL and leaves the old one untouched).

An alert carries the exact commands for that dataset rather than pointing back here. The
alert is read months later, usually by someone who has forgotten the layout of this repo.

**Rehearse an extractor before you need it.** The minimum wage extractor takes `--check`,
which runs the full extraction and compares it to the data currently shipped instead of
writing anything:

```bash
curl -L -A "Mozilla/5.0" -o mw.xlsx https://www.mhlw.go.jp/content/11200000/001571219.xlsx
python scripts/extract-minimum-wage.py --check
```

It should say the output matches. If it does not while the fiscal year is unchanged, the
extractor and the shipped data have drifted apart — which is worth knowing in August
rather than discovering on the day the new figures land, when the temptation is to ship
whatever the script produces.

Register it to run weekly:

```bash
powershell -ExecutionPolicy Bypass -File scripts
egister_watch_task.ps1
```

### Verifying the paid path

The test suite cannot check that RapidAPI's paid plans get full-size batches: doing so
needs the proxy secret RapidAPI issues, and a secret that lives in a test is not a
secret. It checks the half that matters for revenue — that a caller *without* the
secret cannot claim a paid plan by setting a header.

Confirm the other half from the logs after any change to entitlement:

```bash
npx wrangler tail --format json
```

Call any endpoint from the RapidAPI playground and look for the request line. It should
carry the subscription name:

```json
{"channel":"rapidapi","path":"/","status":200,"plan":"BASIC"}
```

`plan` present means the proxy secret matches. `plan: null` on a `rapidapi` request
means it does not — and every paying customer is being served the free-tier caps while
being charged. That failure is silent from the outside, which is why it is worth a
deliberate check rather than waiting for a complaint.

### The dates that matter

| When | What changes |
|---|---|
| **March** | 協会けんぽ prefectural rates, effective with the March salary month |
| **April** | Employment insurance rates; tax tables |
| **Late Aug – October** | Minimum wage, issued prefecture by prefecture, effective from October |
| **February** | Cabinet Office publishes the following year's holidays |

After refreshing any dataset, update `src/data/freshness.json` and run
`npm run rapidapi:prepare` so the live API is re-verified and the OpenAPI spec regenerated.

## Publishing pipeline

Each API is a recipe under `recipes/<slug>/recipe.py` — endpoints are declared once
there, and both the OpenAPI spec and the RapidAPI listing text are generated from it.

```bash
npm run rapidapi:prepare
```

That command, for every recipe:

1. validates the recipe,
2. hits **every declared endpoint on the live API** and requires a 200 with parseable
   JSON — and for endpoints with required parameters, requires a 400 when they are
   omitted. This is what catches drift between `recipe.py` and `src/index.ts`,
3. writes `build/openapi/<slug>.openapi.json`,
4. sends a Discord notification containing the listing URL, the spec path, and the
   exact values to paste.

Listing itself is manual. The Add-API form at
`https://rapidapi.com/provider/<id>/new` is protected by reCAPTCHA v3, so the final
submit is done by a person — three fields, choose "Specify using: OpenAPI", upload the
generated spec. Roughly two minutes per API, which does not bottleneck a
one-or-two-per-week cadence.

Set `DISCORD_WEBHOOK_URL` in `.env` (see `.env.example`) for the notification to
actually arrive; without it the message only prints to the console.

### Browser session

`npm run rapidapi:login` opens a real Chrome window for you to sign in by hand — the
script never sees the password. The session persists in `rapidapi_profile/` (gitignored).
Re-run it when the session expires.

### Operational safety

- `state/pipeline.halt.json` halts everything until a human removes it. `set_halt()` is
  called when a session dies; `clear_halt()` on successful re-login.
- `MAX_PUBLISH_PER_DAY` / `MIN_SECONDS_BETWEEN_PUBLISH` in
  `pipeline/rapidapi/config.py` keep the pace human.

## Licence and attribution

Underlying data is Japanese government open data under
[公共データ利用規約(第1.0版)](https://data.e-gov.go.jp/data/dataset/pulic_data_license),
which permits commercial use and redistribution with attribution. Every response carries
an `attribution` block naming the source.

**This service is not endorsed by any Japanese government agency.** Verify against the
official source before relying on it for statutory filings.
