# jp-payroll-mcp

MCP server for Japanese payroll and labour law. Gives an AI assistant 29 tools for
social insurance premiums, withholding income tax, standard remuneration decisions
and revisions, leave premium exemptions, minimum wage and business-day arithmetic.

Free, no key, no account.

```bash
npx jp-payroll-mcp
```

[日本語のREADMEはこちら](README.md)

## Why this exists

An assistant asked to work out Japanese payroll will answer confidently and be
wrong, because the rules are counter-intuitive rather than obscure:

- Social insurance coverage ends the **day after** the last day worked. Leaving on
  31 March costs a full month of premium; leaving on 30 March costs nothing. One day.
- An age is attained the **day before** the birthday (年齢計算ニ関スル法律). Someone born
  on 1 April turns 40 on 31 March, and their long-term care premium starts a month
  earlier than expected.
- The "two grades or more" test for 随時改定 **is not in 健康保険法**. It is in 昭和36年
  保発第4号, a ministerial notice — along with four exceptions where one grade is enough.
- Premiums are charged on 標準報酬月額, a 50-grade step function — except employment
  insurance, which is charged on actual salary. The employee share rounds half **down**.
- Bonus premiums have two caps that work differently: health caps at 5,730,000 yen
  **cumulatively per fiscal year**, pension at 1,500,000 yen **per payment**.

Every one of those produces a number that looks plausible and is wrong. These tools
compute them from the published tables instead, and cite the statute or notice.

## Setup

### Claude Code

```bash
claude mcp add jp-payroll -- npx -y jp-payroll-mcp
```

### Claude Desktop / other MCP clients

Add to your config file:

```json
{
  "mcpServers": {
    "jp-payroll": {
      "command": "npx",
      "args": ["-y", "jp-payroll-mcp"]
    }
  }
}
```

Requires Node 18 or later.

## Tools

**Payroll**

| Tool | What it does |
|---|---|
| `calculate_payslip` | Full monthly deductions and net pay, employee and employer share |
| `calculate_payroll_batch` | A whole payroll in one call, with run totals and a run id |
| `calculate_bonus` | Bonus premiums with both caps, optionally with withholding tax |
| `calculate_overtime_pay` | 割増賃金 — 25% overtime, 50% past 60 hours, 35% holiday, 25% night on top (労基法37条) |
| `calculate_withholding_tax` | 源泉徴収税額表 — monthly, daily (incl. the 丙 column), or the formula method |
| `commuting_allowance_exemption` | The non-taxable ceiling: counted in full for social insurance, taxed only above the limit |
| `calculate_annual_cost` | What a year of employing someone costs, including the employer share |

**Standard remuneration (標準報酬月額)**

| Tool | What it does |
|---|---|
| `judge_monthly_revision` | Is a 随時改定 (月額変更届) due? Judges health and pension separately |
| `decide_regular_remuneration` | Annual 定時決定 (算定基礎届) from April–June pay |
| `decide_regular_remuneration_batch` | The same for a whole office — June decides everyone at once |
| `judge_leave_end_revision` | Revision on returning from maternity or childcare leave — one grade is enough |
| `judge_annual_average` | 年間平均による保険者算定, for seasonal work |
| `calculate_year_end_adjustment` | Year-end adjustment for 2026: every box of the 源泉徴収簿 from ⑦ to ㉗, matching the Tax Agency's worked example |
| `lookup_standard_remuneration` | Grade for an amount, or the whole 50-grade table |

**Eligibility, leave and age**

| Tool | What it does |
|---|---|
| `judge_worker_type` | Insured or not: the three-quarters test, and 20 hours / ¥88,000 / student / 51 staff |
| `check_insurance_eligibility` | Is a premium due in a joining or leaving month? |
| `check_leave_exemption` | Which months a maternity or childcare leave exempts |
| `judge_annual_leave` | 年次有給休暇 — days granted, including the proportional table for part-timers |
| `get_age_milestones` | When 40, 65, 70 and 75 are reached, and what each changes |

**Reference**

| Tool | What it does |
|---|---|
| `get_insurance_rates` | Rates for any of the 47 prefectures, plus employment insurance |
| `list_workers_compensation_rates` | 労災保険率 by trade — 2.5 to 88 per 1,000, entirely on the employer |
| `national_insurance` | 国民年金 for people outside employee insurance, and why 国民健康保険 has no national figure |
| `get_minimum_wage` | Minimum wage in effect on a date, back to FY2002 |
| `consumption_tax` | The rate in force on a date, the reduced 8%, and every change since 1989 |
| `business_days` | Holidays 1955–2027, business-day counting and shifting, banking calendar |
| `validate_corporate_number` | 法人番号 and invoice registration check digits, or the digit for a 12-digit base |
| `validate_invoice_numbers_batch` | Many registration numbers at once — form only; registration needs the NTA site |
| `get_statute_text` | Full text of any provision the other tools cite |
| `check_data_freshness` | What each dataset covers and when it changes next |

## Building this into a product?

These tools are for asking questions interactively — a person, an assistant, one
case at a time. They cannot be embedded in software: an MCP server runs over stdio
on somebody's own machine, so a payroll product cannot ship one inside itself.

For that, use the HTTP API these tools wrap:
**https://japan-payroll-api.tsumugi.workers.dev**

Same data, same rules, over REST — plus batch processing and an OpenAPI 3.0 spec
to generate a client from.

The free tier covers interactive use comfortably and is what these MCP tools run
on: 300 requests per minute, and batches of up to 10 employees. Nothing is metered
per call and no key is needed. Production volume — full 500-row batches and higher
limits — is on RapidAPI, where billing, keys and quotas are handled for you:
https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants

## Related tools

Japanese statutory MCP servers mostly *retrieve* — they hand you the text of a law and
leave the reasoning to you. This one *computes*, and returns the statute it relied on.
They fit together rather than compete:

| | Answers "what does the law say?" | Answers "so what do I pay?" |
|---|---|---|
| [`labor-law-mcp`](https://www.npmjs.com/package/labor-law-mcp) | 45 labour and social insurance laws, MHLW and JAISH notices | — |
| [`tax-law-mcp`](https://www.npmjs.com/package/tax-law-mcp) | 24 tax laws, 17 NTA circulars, tribunal decisions | — |
| [`hourei-mcp-server`](https://www.npmjs.com/package/hourei-mcp-server) | Any Japanese law, via e-Gov | — |
| **jp-payroll-mcp** | The 28 provisions it cites, in full | Premiums, withholding tax, grade revisions, exemptions |

Ask `labor-law-mcp` for 健康保険法第43条 and you get the article. Ask this one whether a
月額変更届 is due and you get yes or no, which grade, and *why not* when the answer is
no — plus the article, if you add `get_statute_text`.

If you already have one of those installed, install this alongside it. An assistant
with both picks the right one per question.

## Where the numbers come from

Every figure is extracted programmatically from the official source and verified
against the values published in it — not reimplemented from a description of the
formula.

| Data | Source |
|---|---|
| Social insurance rates, grade table | 全国健康保険協会 保険料額表 |
| Withholding tax tables | 国税庁 源泉徴収税額表 |
| Employment insurance | 厚生労働省 |
| Minimum wage | 厚生労働省 地域別最低賃金 |
| Public holidays | 内閣府 |
| Revision rules | e-Gov 法令検索, 厚生労働省 法令等データベース, 日本年金機構 |

The API behind these tools runs **4,661 assertions** on every change. The core of it
compares computed premiums against the amounts printed in the 協会けんぽ workbook for
250 combinations (5 prefectures × 50 grades), and against all 2,079 published cells of the
National Tax Agency withholding table.

## Honest limits

- **These tools decide whether a filing is due. They are not the filing.** Some rules
  turn on facts no API can see — whether a seasonal swing is 「業務の性質上例年発生すること
  が見込まれる」, whether an allowance is 実費弁償, whether the employee consented. Those are
  declared inputs, echoed back in the response. 保険者算定 can still reach a different
  conclusion.
- **Resident tax is never derived.** It depends on the previous year's income and the
  municipality. Pass the figure from the 特別徴収税額通知書.
- **Year-end adjustment (年末調整) is computed for 2026 (令和8年分).** Medical, donation and casualty-loss deductions are outside 年末調整 by law; only what the employee declared is deducted — no spouse or dependant is assumed.
- **A passing invoice check digit does not identify a corporation.** Sole proprietors
  satisfy exactly the same rule.
- **A few practice points could not be sourced to a primary document** and are returned
  as `guidance.fixed_pay.unverified` rather than asserted: whether 家族手当 counts as
  fixed pay, how paid leave counts toward 支払基礎日数, how 年俸制 is treated.
- Not endorsed by, affiliated with, or guaranteed by any government agency. Verify
  against the source before relying on a figure for a statutory filing.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JP_PAYROLL_API_URL` | `https://japan-payroll-api.tsumugi.workers.dev` | Point at your own deployment. Trailing slashes are stripped |
| `JP_PAYROLL_TIMEOUT_MS` | `15000` | Request timeout. Clamped to a 1000 ms floor, since a timeout shorter than a round trip fails every call |

## Development

```bash
npm test           # 138 checks: 109 behavioural, 29 failure-path
npm run test:smoke # tool behaviour, against production
```

Both suites drive a real stdio transport with the real MCP client, because a tool
with a broken handler still lists perfectly — the failure only appears when
something calls it. The failure suite spawns the server against deliberately
broken origins (unreachable, hanging, HTML instead of JSON, 500, 400) and asserts
on what the assistant is *told*, since in every one of those cases the model's next
move is chosen from the error text alone.

Point `JP_PAYROLL_API_URL` at a local `wrangler dev` to test against unreleased API
changes. `npm publish` runs the full suite first and aborts if anything fails.

## Licence

Code MIT. Underlying data is Japanese government open data; licensing differs by
publisher — 厚生労働省 and 国税庁 material is under 公共データ利用規約 (第1.0版), while
全国健康保険協会 permits reproduction with attribution but not modification. Each
response carries the terms for the source it drew on.
