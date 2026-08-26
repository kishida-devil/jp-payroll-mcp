#!/usr/bin/env node
/**
 * jp-payroll-mcp — Japanese payroll and labour statutory rules as MCP tools.
 *
 * A thin, deliberate layer over https://japan-payroll-api.tsumugi.workers.dev.
 * All the domain logic lives in the API; this file's job is to make an assistant
 * pick the right tool and hand it the right arguments.
 *
 * ## Why plain ESM rather than TypeScript
 *
 * The rest of the repository is TypeScript. This package is not, because its one
 * job is to run reliably from `npx` on a stranger's machine. A build step adds a
 * way for the published artifact to drift from the source, and buys nothing here:
 * every tool boundary is already validated at runtime by Zod, and every response
 * is validated by the API itself.
 *
 * ## Why the descriptions are so long
 *
 * A model that already "knows" Japanese payroll will confidently produce wrong
 * numbers, because the traps are counter-intuitive rather than obscure — coverage
 * ends the day *after* the last day worked, an age is reached the day *before* the
 * birthday, the two-grade revision test is in a 1961 ministerial notice and not in
 * the Act at all. So each description states its trap. The point is not to explain
 * the domain; it is to stop the model answering from memory when a tool exists.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Trailing slashes are stripped because every path below starts with one, and a
// pasted "https://host/" would otherwise produce "//v1/..." — which this origin
// answers with a 404, so the failure looks like a missing endpoint rather than a
// mistyped setting.
const BASE = (process.env.JP_PAYROLL_API_URL ?? 'https://japan-payroll-api.tsumugi.workers.dev')
  .replace(/\/+$/, '');
const VERSION = '0.3.0';

// A floor of 1000ms: a timeout shorter than a round trip fails every call, and
// the resulting "the API did not respond" is a confusing way to learn that.
const TIMEOUT_MS = Math.max(1000, Number(process.env.JP_PAYROLL_TIMEOUT_MS) || 15000);

/**
 * Identifies MCP traffic separately from REST traffic in the origin's analytics.
 * The URL is the npm page, which exists; there is no source repository to point at,
 * and a User-Agent that advertises a 404 is worse than one that advertises nothing.
 */
const UA = `jp-payroll-mcp/${VERSION} (+https://www.npmjs.com/package/jp-payroll-mcp)`;

async function call(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return fail(`The API returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    // A 400 from this API carries a specific reason and often a hint. Passing it
    // through unchanged lets the model correct its own arguments and retry, which
    // it cannot do if the error is flattened to "request failed".
    if (!res.ok) return fail(JSON.stringify(json, null, 1));
    return ok(json);
  } catch (e) {
    if (e?.name === 'AbortError')
      return fail(`The API did not respond within ${TIMEOUT_MS}ms. Set JP_PAYROLL_TIMEOUT_MS to raise the limit.`);
    return fail(`Could not reach the API at ${BASE}: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
// ローカルで止めたエラーにも、APIが返すのと同じ形で code を載せる。止まった場所に
// よってエラーの形が変わると、呼ぶ側が両方を扱わなければならなくなる。
const fail = (message, code = 'invalid_request') =>
  ({ isError: true, content: [{ type: 'text', text: `${message} [${code}]` }] });

/** Drops undefined so optional arguments do not become the string "undefined". */
const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * The operating contract, sent once at connect time rather than repeated in every
 * response — a pointer stapled to sixteen tool results is noise, and noise inside
 * a tool result is worse than none because it competes with the answer.
 *
 * It is long on purpose. The failure this package exists to prevent is not "the
 * model cannot find the tool"; it is "the model already believes it knows the
 * answer". A model that has read a hundred Japanese payroll blog posts will
 * produce a confident figure without calling anything, and the figure will be
 * wrong in ways nobody notices until a labour inspection. So the rules are written
 * as prohibitions rather than suggestions, and they name the specific traps —
 * a rule the model can check itself against beats a rule it has to interpret.
 */
const INSTRUCTIONS = `Japanese payroll, social insurance and labour law. Every figure
these tools return is computed from the published government tables and carries the
statute or ministerial notice it came from.

## Rules

- Do not answer a Japanese payroll question from memory. Call a tool. These rules are
  counter-intuitive rather than obscure, so a remembered answer is not vague — it is
  specific, confident and wrong.
- If a tool result contradicts what you believe, the tool is right. Say so plainly
  rather than averaging the two.
- Quote the statute or notice the response names (\`attribution\`, \`statutes\`,
  \`notice\`) when you state a rule. "健康保険法第43条" is checkable; "under Japanese law"
  is not. \`get_statute_text\` returns the actual words if the reader needs them.
- When a tool answers "no" it also returns \`blocking_reasons\`. Give the reason, not
  just the verdict — the reason is what tells the user what to change.
- Never present a figure as a filing. These tools decide what is *due*; several rules
  turn on facts they cannot see, and 保険者算定 by the insurer can still differ.

## The traps these tools exist for

- Social insurance coverage ends the day **after** the last day worked. Leaving on the
  last day of a month still owes that month's premium; leaving one day earlier owes
  nothing. A full month of premium turns on one day.
- An age is attained the day **before** the birthday (年齢計算ニ関スル法律). Someone born
  on the 1st crosses a threshold in the previous month.
- The "two grades or more" test for 随時改定 appears nowhere in 健康保険法. It is in
  昭和36年 保発第4号, a notice — with four exceptions where one grade is enough.
- Premiums are charged on 標準報酬月額, a 50-grade step function, **except** employment
  insurance, which uses actual salary. The employee share rounds half **down**.
- Bonus caps differ: health is cumulative per fiscal year, pension is per payment.

## How to work through a question

1. Establish the facts a tool needs — prefecture, birth date (not age), the exact
   dates, whether pay that changed was fixed or variable. Ask if any are missing;
   guessing them silently is how a wrong answer looks right.
2. Call the tools. Several questions need more than one — a leaver's final month is
   \`check_insurance_eligibility\` plus \`calculate_payslip\`; a returning parent is
   \`judge_leave_end_revision\`, and \`judge_monthly_revision\` will usually say no for
   the same facts, which is the point.
3. If a call fails, read the error. A 400 from this API names what was wrong and
   usually how to fix it. Correct the arguments and retry rather than falling back to
   memory — falling back is the exact failure these tools prevent.
4. Answer with the figure, the rule it came from, and anything the response flagged
   as unverified or capped.

## Interactive use versus building software

These tools answer questions. They cannot be embedded in a product: an MCP server runs
over stdio on someone's own machine, so a payroll application cannot ship one inside
itself. For that, use the HTTP API they wrap —
https://japan-payroll-api.tsumugi.workers.dev — the same data over REST, with batch
processing and an OpenAPI 3.0 spec.

The free tier these tools run on allows 300 requests per minute and batches of up to
10 employees. Larger batches and higher limits are on RapidAPI:
https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants`;

const server = new McpServer(
  { name: 'jp-payroll', version: VERSION },
  { instructions: INSTRUCTIONS },
);

// ---------------------------------------------------------------------------
// Shared argument shapes
// ---------------------------------------------------------------------------

const prefecture = z.string().describe(
  'Prefecture of the employer\'s 適用事業所 — English ("Tokyo"), Japanese ("東京" or "東京都"), ' +
  'or JIS code 1-47. Health insurance rates differ by prefecture; pension does not.');

const birthDate = z.string().optional().describe(
  'Date of birth, YYYY-MM-DD. Strongly preferred over `age`: 年齢計算ニ関スル法律 puts the ' +
  'attainment of an age on the day *before* the birthday, so someone born on the 1st of a ' +
  'month crosses a threshold in the previous month and their premium changes a month earlier ' +
  'than a naive calculation gives.');

const workerType = z.enum(['general', 'part_time_short_hours', 'short_time_insured']).optional()
  .describe(
    'general = 一般の被保険者 (17-day threshold). ' +
    'part_time_short_hours = 短時間就労者, works shorter hours but meets the three-quarters ' +
    'test (17 days, with a 15-day fallback that exists ONLY in 定時決定). ' +
    'short_time_insured = 短時間労働者 at a 特定適用事業所 (11 days). Defaults to general.');

const monthsArg = z.string().describe(
  'Three months as "remuneration:payment_basis_days", comma separated — e.g. ' +
  '"350000:31,352000:30,349000:31". 支払基礎日数 is calendar days for monthly-paid staff, ' +
  'or days actually worked for daily-paid staff.');

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

server.registerTool('calculate_payslip', {
  title: '給与計算 — 社会保険料・源泉所得税・手取り',
  description:
    'Full monthly deduction breakdown for one employee: health insurance, long-term care, ' +
    'pension, child support, employment insurance, withholding income tax and net pay, with ' +
    'the employer share as well.\n\n' +
    'Use this rather than computing it yourself. Premiums are charged on 標準報酬月額 — a ' +
    '50-grade step function — and not on actual salary, while employment insurance IS charged ' +
    'on actual salary; the employee share rounds half DOWN; pension stops at grade 32; ' +
    'long-term care applies only from 40 to 64. Income tax is computed on pay after social ' +
    'insurance, which the tool derives internally, so do not pre-deduct it.',
  inputSchema: {
    prefecture,
    monthly_salary: z.number().describe('Gross monthly pay in yen, before any deduction.'),
    age: z.number().optional().describe(
      'Age in years. Either this or birth_date is required — long-term care is charged only ' +
      'from 40 to 64, so the premium cannot be settled without it. Prefer birth_date.'),
    birth_date: birthDate,
    dependants: z.number().optional().describe('源泉控除対象親族の数. Defaults to 0.'),
    column: z.enum(['kou', 'otsu']).optional().describe(
      '甲 if the employee filed a 扶養控除等申告書 (the normal case), 乙 if not. Defaults to 甲.'),
    business_type: z.enum(['general', 'agriculture_forestry_fishery_sake', 'construction']).optional()
      .describe('Employment insurance rate band. Defaults to general.'),
    resident_tax: z.number().optional().describe(
      'Resident tax to deduct, in yen. It is levied by the municipality on the previous ' +
      'year\'s income and is never derived here — pass the figure from the 特別徴収税額通知書.'),
    income_tax: z.boolean().optional().describe('Set false to skip withholding tax. Defaults to true.'),
    standard_remuneration: z.number().optional().describe(
      'The 標準報酬月額 fixed by 算定基礎届 or 月額変更届. Pass it whenever it is known. Without ' +
      'it the grade is re-derived from the pay you send, which is wrong in any month with ' +
      'overtime — a 300,000 yen earner who made 369,469 in a busy month is over-deducted by ' +
      '8,445 yen. decide_regular_determination returns the right figure.'),
    employment_type: z.enum(['employee', 'director', 'director_employee']).optional().describe(
      '役員 are not employment-insurance insured (雇用保険法第4条). Pass "director" for a ' +
      'company officer, or the premium comes out too high. Defaults to employee.'),
    commuting_allowance: z.number().optional().describe(
      'Commuting allowance in yen per month. Social insurance counts it as remuneration in ' +
      'full, income tax exempts it up to a ceiling — 150,000 a month by public transport. ' +
      'Do NOT fold it into monthly_salary: doing so taxes it, and leaving it out understates ' +
      'the premiums. The split comes back in earnings.items.'),
    commuting_distance_km: z.number().optional().describe(
      'One-way distance for a car or bicycle commute. The exempt ceiling then comes from the ' +
      'distance table (国税庁 No.2585) rather than the 150,000 transit ceiling; under 2 km ' +
      'nothing is exempt.'),
    commuting_fare: z.number().optional().describe(
      'Reasonable fare or toll paid on top of a car or bicycle commute. With ' +
      'commuting_distance_km the ceiling is the distance band plus this, capped at 150,000.'),
    workers_comp_type: z.string().optional().describe(
      '労災保険 事業の種類の番号, e.g. "98" for wholesale/retail/restaurants/hotels. Workers ' +
      'compensation falls entirely on the employer and is left out unless you pass this, ' +
      'because rates run from 2.5/1000 to 88/1000 and there is no safe default. ' +
      'list_workers_compensation_rates has the table.'),
    as_of: z.string().optional().describe(
      'ISO date the pay relates to. Drives the age milestones and picks the rate table; a ' +
      'date outside the published period returns 422 rather than the current table.'),
  },
}, async (a) => {
  // 介護保険法第9条は40歳以上65歳未満を第2号被保険者と定める。年齢が無いと
  // 徴収するかどうかが決まらないので、APIは400を返す。ここで先に止めるのは、
  // HTTPエラーより「何を聞けばよいか」が伝わるため。
  if (a.age === undefined && a.birth_date === undefined)
    return fail('This needs the age of the employee. Long-term care insurance is charged only from ' +
                '40 to 64 (介護保険法第9条), so without it the premium would be understated by ' +
                'about 2,430 yen a month on a 300,000 yen salary in Tokyo. Ask for the date of ' +
                'birth and pass birth_date — 年齢計算ニ関スル法律 puts the attainment of an age on ' +
                'the day before the birthday, so a 1st-of-the-month birth changes the premium a ' +
                'month earlier than age alone would suggest.', 'missing_parameter');
  return call('/v1/payroll' + qs(a));
});

server.registerTool('list_workers_compensation_rates', {
  title: '労災保険率 — 事業の種類別',
  description:
    'Workers compensation (労災保険) rates by business type, and the employer premium on a ' +
    'given 賃金総額.\n\n' +
    'The whole premium falls on the employer — nothing is deducted from the employee, unlike ' +
    'every other statutory premium. Rates run from 2.5/1000 to 88/1000 depending on the ' +
    'industry, a 35-fold spread, so this cannot be estimated. Pass the 事業の種類の番号 from ' +
    'the 労働保険関係成立届; omit it to get the whole table.',
  inputSchema: {
    business_type: z.string().optional().describe(
      '事業の種類の番号 (02-99), e.g. "35" for 建築事業 or "98" for wholesale and retail.'),
    wage_total: z.number().optional().describe(
      '賃金総額 for the period, in yen — the same wage base employment insurance uses, so a ' +
      'commuting allowance counts and a reimbursement does not.'),
    as_of: z.string().optional().describe('ISO date the wages relate to.'),
  },
}, async (a) => call('/v1/workers-compensation' + qs(a)));

server.registerTool('calculate_bonus', {
  title: '賞与の社会保険料と源泉所得税',
  description:
    'Premiums and income tax on a 賞与. Both work differently from monthly pay and are ' +
    'routinely got wrong.\n\n' +
    'Premiums are charged on 標準賞与額 (the bonus truncated to the thousand yen) under two ' +
    'caps that behave differently: health, long-term care and child support cap at 5,730,000 ' +
    'yen CUMULATIVELY across the fiscal year from 1 April, while pension caps at 1,500,000 yen ' +
    'PER PAYMENT. The annual cap cannot be applied without fiscal_year_to_date, so pass it ' +
    'whenever an earlier bonus was paid in the same fiscal year.\n\n' +
    'Withholding tax on a bonus is derived from the PREVIOUS month\'s pay, not from the bonus ' +
    'itself. Set include_tax to also compute it.',
  inputSchema: {
    prefecture,
    bonus: z.number().describe('Gross bonus in yen.'),
    fiscal_year_to_date: z.number().optional().describe(
      '標準賞与額 already paid since 1 April this fiscal year. Needed for the annual health cap.'),
    age: z.number().optional().describe(
      'Age in years. Either this or birth_date is required. Prefer birth_date.'),
    birth_date: birthDate,
    include_tax: z.boolean().optional().describe(
      'Also compute withholding tax. Requires previous_month_pay.'),
    previous_month_pay: z.number().optional().describe(
      'Gross pay in the month before the bonus. The tax rate is derived from this.'),
    previous_month_insurance: z.number().optional().describe(
      'Social insurance deducted from that previous month\'s pay.'),
    dependants: z.number().optional(),
  },
}, async (a) => {
  // 介護保険法第9条は40歳以上65歳未満を第2号被保険者と定める。年齢が無いと
  // 徴収するかどうかが決まらないので、APIは400を返す。ここで先に止めるのは、
  // HTTPエラーより「何を聞けばよいか」が伝わるため。
  if (a.age === undefined && a.birth_date === undefined)
    return fail('This needs the age of the employee. Long-term care insurance is charged only from ' +
                '40 to 64 (介護保険法第9条), so without it the premium would be understated by ' +
                'about 2,430 yen a month on a 300,000 yen salary in Tokyo. Ask for the date of ' +
                'birth and pass birth_date — 年齢計算ニ関スル法律 puts the attainment of an age on ' +
                'the day before the birthday, so a 1st-of-the-month birth changes the premium a ' +
                'month earlier than age alone would suggest.', 'missing_parameter');
  const insurance = await call('/v1/bonus-insurance' + qs({
    prefecture: a.prefecture, bonus: a.bonus, fiscal_year_to_date: a.fiscal_year_to_date,
    age: a.age, birth_date: a.birth_date,
  }));
  if (insurance.isError || !a.include_tax) return insurance;
  if (a.previous_month_pay === undefined)
    return fail('include_tax needs previous_month_pay: the rate comes from the previous ' +
                'month\'s pay, not from the bonus.');
  // 賞与の源泉税は、その賞与自身の社会保険料を引いたあとの額にかかる
  // (所得税法第186条第2項)。その社会保険料は直前の呼び出しで出ているので、
  // ここで渡す。渡さないと400になり、include_tax がまるごと使えない。
  // 既定0で通していた頃は、500,000円の賞与で 3,063円 の過大な税額が出ていた。
  const insuranceBody = JSON.parse(insurance.content[0].text);
  const tax = await call('/v1/bonus-tax' + qs({
    bonus: a.bonus, bonus_insurance: insuranceBody.totals?.employee ?? 0,
    previous_month_pay: a.previous_month_pay,
    previous_month_insurance: a.previous_month_insurance, dependants: a.dependants,
  }));
  if (tax.isError) return tax;
  return ok({
    insurance: insuranceBody,
    withholding_tax: JSON.parse(tax.content[0].text),
  });
});

server.registerTool('calculate_withholding_tax', {
  title: '源泉徴収税額(月額表・日額表・電算機計算の特例)',
  description:
    'Income tax to withhold from a payment, from the National Tax Agency tables. ' +
    'The taxable amount is pay AFTER social insurance has been deducted, not gross.\n\n' +
    'Pick the table with `period`: "monthly" for 月額表, "daily" for 日額表. The daily table ' +
    'has a third column, 丙, which applies to work engaged by the day and takes no dependant ' +
    'adjustment at all. Use `method: "computer"` for the 電算機計算の特例 formula, which payroll ' +
    'software may use instead of the table and can differ by a few yen.',
  inputSchema: {
    taxable_amount: z.number().describe('Pay after social insurance, in yen.'),
    period: z.enum(['monthly', 'daily']).optional().describe('Defaults to monthly.'),
    column: z.enum(['kou', 'otsu', 'hei']).optional().describe(
      '甲/乙, plus 丙 for the daily table only. Defaults to 甲.'),
    dependants: z.number().optional(),
    method: z.enum(['table', 'computer']).optional().describe(
      '"computer" selects the statutory formula method. Monthly only. Defaults to table.'),
  },
}, async (a) => {
  if (a.method === 'computer' && a.period === 'daily')
    return fail('電算機計算の特例 applies to monthly pay only; there is no daily formula method.');
  if (a.column === 'hei' && a.period !== 'daily')
    return fail('The 丙 column exists only in the daily table. Set period to "daily".');
  const path = a.method === 'computer' ? '/v1/withholding-tax/computer'
    : a.period === 'daily' ? '/v1/withholding-tax/daily'
    : '/v1/withholding-tax';
  return call(path + qs({
    taxable_amount: a.taxable_amount, column: a.column, dependants: a.dependants,
  }));
});

// ---------------------------------------------------------------------------
// Standard remuneration decisions and revisions
// ---------------------------------------------------------------------------

server.registerTool('judge_monthly_revision', {
  title: '随時改定(月額変更届)の要否判定',
  description:
    'Decides whether a pay change forces the standard remuneration to be revised, and answers ' +
    'SEPARATELY for health insurance and pension — the tables differ, so a change routinely ' +
    'moves one and not the other. Above roughly 665,000 yen the pension table is exhausted, so ' +
    'a large raise for a well-paid employee moves several health grades and no pension grade.\n\n' +
    'Do not try to reason this out unaided. Neither the "two grades or more" test nor the ' +
    'requirement that FIXED pay changed appears anywhere in 健康保険法 or its regulations — both ' +
    'come from 昭和36年 保発第4号, a ministerial notice, along with four exceptions near the top ' +
    'and bottom of each table where a single grade is enough. Overtime alone never triggers a ' +
    'revision, and a rise in fixed pay whose three-month average comes out LOWER is excluded ' +
    'even at a wide grade gap.\n\n' +
    'When the answer is no, the response says which requirement failed rather than just false. ' +
    'If the three-month average is distorted by a seasonal peak, see judge_annual_average.',
  inputSchema: {
    current_remuneration: z.number().describe(
      'The 報酬月額 the CURRENT grade was based on — the actual pay figure, not the 標準報酬月額. ' +
      'The upper and lower exceptions turn on actual pay, so substituting the grade\'s standard ' +
      'value gives a wrong answer at the extremes.'),
    months: monthsArg,
    fixed_pay_change: z.enum(['increase', 'decrease', 'none']).describe(
      'Whether FIXED pay changed: base pay, rate changes, a new or altered fixed allowance, a ' +
      'change of pay basis. Overtime and other variable pay are not fixed pay — use "none" and ' +
      'the tool will explain why no revision follows.'),
    worker_type: workerType,
  },
}, async (a) => call('/v1/standard-remuneration/revision' + qs(a)));

server.registerTool('decide_regular_remuneration', {
  title: '定時決定(算定基礎届) — 4〜6月の報酬から',
  description:
    'The yearly redetermination of standard remuneration, effective each September through the ' +
    'following August.\n\n' +
    'Months below the payment-basis-day threshold drop OUT of the average entirely — they are ' +
    'not counted as zero, which is the usual mistake. If no month qualifies, the previous grade ' +
    'carries over by 保険者算定, except for 短時間就労者, who have an intermediate step at 15 days ' +
    'that exists nowhere else in the scheme and not in 随時改定.\n\n' +
    'Pass acquired_month to also learn how long a 資格取得時決定 stays in force.',
  inputSchema: {
    months: monthsArg.describe(
      'April, May and June as "remuneration:payment_basis_days" — e.g. "350000:30,352000:31,349000:30".'),
    worker_type: workerType,
    year: z.number().optional().describe(
      'The determination year; its 1 July is the reference date. Defaults to the current year.'),
    acquired_on: z.string().optional().describe(
      'Date cover began, YYYY-MM-DD. Someone insured between 1 June and 1 July is outside the annual determination (健康保険法第41条).'),
    left_on: z.string().optional().describe(
      'Last day worked, YYYY-MM-DD. Gone before 1 July means not employed on the reference date.'),
    revision_month: z.number().optional().describe(
      'Month a 随時改定 takes effect. July, August or September displaces the annual determination; any other month does not.'),
    previous_remuneration: z.number().optional().describe(
      'The prior 報酬月額, so the response can name the grade that carries over if no month qualifies.'),
    acquired_month: z.number().optional().describe(
      'Month of enrolment, 1-12. Returns how long the 資格取得時決定 applies.'),
  },
}, async (a) => call('/v1/standard-remuneration/regular' + qs(a)));

server.registerTool('judge_leave_end_revision', {
  title: '産休・育休終了時改定(1等級差で改定)',
  description:
    'A separate route with a lower bar than 随時改定, and the one people forget. ONE grade of ' +
    'movement is enough, and fixed pay need not have changed at all — which matters because ' +
    'returning to shorter hours usually cuts pay without changing any rate, so 随時改定 would ' +
    'not fire and the employee would keep overpaying on their pre-leave grade.\n\n' +
    'Only one of the three months has to reach the day threshold, and months that miss it are ' +
    'excluded from the average. The employee must apply; an employer cannot file it alone. It ' +
    'is unavailable if another leave begins the day after this one ends.',
  inputSchema: {
    kind: z.enum(['maternity', 'childcare']).describe(
      '産前産後休業終了時改定 or 育児休業等終了時改定.'),
    current_remuneration: z.number().describe('報酬月額 before the leave.'),
    months: monthsArg.describe(
      'Three months starting with the one containing the day AFTER the leave ended.'),
    worker_type: workerType,
    next_leave_starts_immediately: z.boolean().optional().describe(
      'True if another leave began the day after this one ended, which bars the application.'),
  },
}, async (a) => call('/v1/standard-remuneration/leave-end' + qs(a)));

server.registerTool('decide_regular_remuneration_batch', {
  title: '定時決定(算定基礎届)をまとめて — 事業所全員分',
  description:
    'Runs the annual 定時決定 for a whole payroll in one call, and reports which employees moved ' +
    'grade.\n\n' +
    '健康保険法第41条 puts every insured employee on the same schedule — the average of April, ' +
    'May and June pay, over the months with at least seventeen payment-basis days, applied from ' +
    'September to the following August. So June is the one month of the year when an office ' +
    'decides its entire payroll at once, and asking about one employee at a time is the wrong ' +
    'shape for the task.\n\n' +
    'Reach for this the moment more than a couple of employees are in play. Each row returns the ' +
    'same judgement as decide_regular_remuneration, plus whether that person changed grade, ' +
    'which is what decides how much filing there is. Pass previous_remuneration to get that ' +
    'comparison; without it the answer is null rather than false, because "no grade to compare" ' +
    'and "did not move" are different facts.\n\n' +
    'Pass acquired_on, left_on or revision_month and each row also says whether that employee is ' +
    'filed at all. 健康保険法第41条 leaves out anyone insured between 1 June and 1 July, anyone gone ' +
    'before the 1 July reference date, and anyone revised from July to September. The run totals ' +
    'to_file and not_required, which is the number of forms rather than the number of employees. ' +
    'A row that cannot be decided is returned in errors with its index and id, and the rest of ' +
    'the run still completes — do not discard a whole run over one bad row.',
  inputSchema: {
    employees: z.array(z.object({
      id: z.string().optional().describe('Echoed back on the result and on any error.'),
      months: z.array(z.object({
        remuneration: z.number().describe('Total pay for that month, in yen.'),
        payment_basis_days: z.number().describe('支払基礎日数 for that month.'),
      })).describe('Exactly three entries: April, May and June, in that order.'),
      worker_type: z.enum(['general', 'part_time_short_hours', 'short_time_insured']).optional(),
      previous_remuneration: z.number().optional().describe(
        'The 標準報酬月額 in force before this determination, so the result can say whether it moved.'),
      acquired_on: z.string().optional().describe(
        'Date cover began, YYYY-MM-DD. Between 1 June and 1 July is outside the determination.'),
      left_on: z.string().optional().describe(
        'Last day worked, YYYY-MM-DD. Gone before 1 July means not filed.'),
      revision_month: z.number().optional().describe(
        'Month a 随時改定 takes effect. July to September displaces the determination.'),
    })).describe('One entry per employee.'),
    defaults: z.object({
      year: z.number().optional().describe('The determination year. Defaults to the current year.'),
      worker_type: z.enum(['general', 'part_time_short_hours', 'short_time_insured']).optional(),
      previous_remuneration: z.number().optional(),
    }).optional().describe('Applied to any row that omits the field.'),
  },
}, async (a) => call('/v1/standard-remuneration/regular/batch', { method: 'POST', body: a }));

server.registerTool('judge_annual_average', {
  title: '年間平均による保険者算定(季節変動がある場合)',
  description:
    'For work whose April-June happens to be its busiest or quietest quarter, where the ordinary ' +
    'calculation would fix a grade that is wrong for eleven months of the year. Available for ' +
    '定時決定 (since April 2011) and 随時改定 (since October 2018).\n\n' +
    'The 随時改定 figure is NOT a plain twelve-month average: it is the three-month average of ' +
    'FIXED pay plus the twelve-month average of NON-FIXED pay, so the two are supplied ' +
    'separately, and three distinct grade tests must all pass.\n\n' +
    'Both routes need the employee\'s consent and require that the swing recurs every year for ' +
    'reasons inherent to the work — a one-off busy period does not qualify. Neither is something ' +
    'this tool can verify, so both are declared inputs and are echoed back in the response.',
  inputSchema: {
    type: z.enum(['regular', 'revision']).describe(
      'regular = 定時決定の年間平均, revision = 随時改定の年間平均.'),
    months: z.array(z.object({
      month: z.string().optional().describe('YYYY-MM, for readability.'),
      remuneration: z.number().optional().describe('regular only: total pay that month.'),
      fixed: z.number().optional().describe('revision only: fixed pay that month.'),
      non_fixed: z.number().optional().describe('revision only: overtime and other variable pay.'),
      payment_basis_days: z.number(),
    })).describe(
      'Exactly 12 entries. For regular: 前年7月 through 当年6月 in order. ' +
      'For revision: the 9 months BEFORE the pay change, then the 3 months after it.'),
    current_remuneration: z.number().optional().describe('revision only.'),
    fixed_pay_change: z.enum(['increase', 'decrease']).optional().describe('revision only.'),
    worker_type: workerType,
    recurring_annually: z.boolean().describe(
      'The swing recurs every year for reasons inherent to the work. Mandatory condition.'),
    employee_consent: z.boolean().describe('The employee has consented. Mandatory condition.'),
  },
}, async (a) => call('/v1/standard-remuneration/annual-average', { method: 'POST', body: a }));

server.registerTool('lookup_standard_remuneration', {
  title: '標準報酬月額の等級照会',
  description:
    'Maps a monthly amount to its health grade (1-50) and pension grade (1-32), with the ' +
    'standard remuneration each resolves to and whether the pension grade was clamped. Use it ' +
    'to check a grade, not to compute premiums — calculate_payslip does that.',
  inputSchema: {
    remuneration: z.number().describe('Monthly remuneration in yen.'),
  },
}, async (a) => call('/v1/standard-remuneration' + qs(a)));

// ---------------------------------------------------------------------------
// Eligibility, leave and age
// ---------------------------------------------------------------------------

server.registerTool('national_insurance', {
  title: '国民年金・国民健康保険 — 被用者保険に入らない人の側',
  description:
    'For anyone outside employee cover: the self-employed, freelancers, people between jobs.\n\n' +
    'Use this instead of calculate_payslip when the person is not an employee. Running a ' +
    'freelancer through the payslip returns a figure computed under a different scheme ' +
    'entirely, with nothing in the answer to say so. If you are unsure which side someone is ' +
    'on, judge_worker_type decides it.\n\n' +
    'The two schemes differ in how far they can be answered, and the difference matters. ' +
    '国民年金法第87条 makes the pension contribution a statutory amount times a revision rate ' +
    'set each year by cabinet order — the same figure everywhere in the country, flat ' +
    'regardless of income. That comes back as a number.\n\n' +
    '国民健康保険法第76条 leaves the health contribution to each municipality, collected from ' +
    'the head of the household, and states no figure at all. Around 1,700 municipalities each ' +
    'set their own income-based, per-person and per-household components and their own ' +
    'ceilings. There is no national number to give. Do not estimate one, and do not present a ' +
    'figure from one city as though it were general — tell the person to ask their own ' +
    'municipality, which is what the response says.\n\n' +
    'Exemptions, deferrals and the student special case all change what is actually paid, and ' +
    'whether they apply turns on income and household. Those are not judged here.',
  inputSchema: {
    as_of: z.string().optional().describe(
      'Date to judge, YYYY-MM-DD. Outside the year carried it refuses rather than quoting a stale figure.'),
    months: z.number().optional().describe(
      'Months to total. The contribution is flat, so this multiplies.'),
    supplementary: z.boolean().optional().describe(
      'Add the optional 付加保険料 of 400 a month, which raises the basic old-age pension later.'),
  },
}, async (a) => call('/v1/national-insurance' + qs({
  as_of: a.as_of, months: a.months, supplementary: a.supplementary,
})));

server.registerTool('calculate_annual_cost', {
  title: '年間の労務コスト — 賞与の上限を年度で通した額',
  description:
    'What one employee costs an employer over a year, bonuses included.\n\n' +
    'Reach for this rather than multiplying a payslip by twelve, because the two do not ' +
    'agree once a bonus is paid. 健康保険法第45条 caps the standard bonus cumulatively across ' +
    'the year — 5,730,000 from 1 April to 31 March — so the same bonus costs a different ' +
    'amount depending on where it falls, and once the year is used up later bonuses carry no ' +
    'health premium. 厚生年金保険法第24条の4 caps at 1,500,000 per payment with no yearly ' +
    'total, so pension keeps charging where health has stopped.\n\n' +
    'Pass bonuses in the order they are paid: the health allowance fills from the first one. ' +
    'Each row comes back with what was counted, whether it was cut, and how much of the year ' +
    'remains, so the answer can be explained rather than just quoted.\n\n' +
    'Income tax here is the monthly figure times twelve. Bonus withholding is a separate ' +
    'calculation (calculate_bonus with include_tax) and the year-end adjustment is not ' +
    'covered at all — say so rather than presenting this as take-home pay for the year.',
  inputSchema: {
    prefecture,
    monthly_salary: z.number().describe('Gross monthly pay in yen.'),
    age: z.number().optional().describe('Either this or birth_date is required.'),
    birth_date: birthDate,
    bonuses: z.array(z.number()).optional().describe(
      'Each bonus in yen, in the order paid. The health cap fills from the first.'),
    fiscal_year: z.number().optional().describe(
      'Year the 1 April to 31 March window starts. Defaults from the current date.'),
    standard_remuneration: z.number().optional().describe(
      'The 標準報酬月額 fixed by 算定基礎届, if known. Without it the grade is derived from the pay given.'),
    workers_comp_type: z.string().optional().describe(
      '事業の種類の番号. Charged on bonuses as well, being levied on total wages.'),
    business_type: z.enum(['general', 'agriculture_forestry_fishery_sake', 'construction']).optional(),
    dependants: z.number().optional(),
    resident_tax: z.number().optional().describe(
      'Monthly resident tax, multiplied by twelve as given. It is never derived here.'),
  },
}, async (a) => {
  if (a.age === undefined && a.birth_date === undefined)
    return fail('This needs the age of the employee. Long-term care insurance is charged only ' +
                'from 40 to 64 (介護保険法第9条), so an annual figure without it would be ' +
                'understated for anyone in that band. Ask for the date of birth and pass ' +
                'birth_date.', 'missing_parameter');
  return call('/v1/annual-cost' + qs({
    prefecture: a.prefecture, monthly_salary: a.monthly_salary,
    age: a.age, birth_date: a.birth_date,
    bonuses: a.bonuses === undefined ? undefined : a.bonuses.join(','),
    fiscal_year: a.fiscal_year, standard_remuneration: a.standard_remuneration,
    workers_comp_type: a.workers_comp_type, business_type: a.business_type,
    dependants: a.dependants, resident_tax: a.resident_tax,
  }));
});

server.registerTool('judge_annual_leave', {
  title: '年次有給休暇 — 付与日数と年5日の時季指定義務',
  description:
    'Works out how many days of paid leave someone has been granted, and whether the employer ' +
    'still owes the five days it must direct.\n\n' +
    '労働基準法第39条 grants ten working days once six months of service are complete and ' +
    'attendance reaches eighty per cent of all working days, then adds one, two, four, six, ' +
    'eight and ten days in the years that follow. The ceiling everyone quotes as twenty is not ' +
    'in the article: it is the ten of the first grant plus the ten added from the sixth year.\n\n' +
    'Someone under thirty hours a week working four days or fewer takes a smaller table from ' +
    '施行規則第24条の3. Thirty hours is where it turns — at or above it the ordinary grant ' +
    'applies no matter how few days are worked, and treating such a person as part-time ' +
    'under-grants them. Ask for both the weekly days and the weekly hours; one without the ' +
    'other cannot settle it.\n\n' +
    'Where ten or more days are granted, 第39条第7項 requires the employer to fix the timing of ' +
    'five of them within the year, and days the employee took of their own accord count toward ' +
    'it. A grant lapses two years after it is made (第115条), so one year carries over.\n\n' +
    'The attendance figure is a question about the workplace: leave for a work injury, ' +
    'maternity, childcare and paid leave already taken all count as attendance. Ask for a rate ' +
    'that has been worked out rather than dividing days present by days in the year. Without ' +
    'one the tool reports the eighty per cent test as not judged rather than assuming it passed.',
  inputSchema: {
    hired_on: z.string().describe('Date of hire, YYYY-MM-DD. Grants fall six months later, then annually.'),
    as_of: z.string().optional().describe('Date to judge against, YYYY-MM-DD. Defaults to today.'),
    attendance_rate: z.number().optional().describe(
      'Attendance as a fraction of all working days, 0 to 1. Eighty per cent or more grants.'),
    weekly_days: z.number().optional().describe('週所定労働日数.'),
    weekly_hours: z.number().optional().describe(
      '週所定労働時間. Thirty or more takes the ordinary grant whatever the day count.'),
    annual_days: z.number().optional().describe('一年間の所定労働日数, in place of weekly_days.'),
    days_taken: z.number().optional().describe(
      'Days already taken in the current year, counted against the five the employer must direct.'),
  },
}, async (a) => call('/v1/annual-leave' + qs({
  hired_on: a.hired_on, as_of: a.as_of, attendance_rate: a.attendance_rate,
  weekly_days: a.weekly_days, weekly_hours: a.weekly_hours,
  annual_days: a.annual_days, days_taken: a.days_taken,
})));

server.registerTool('judge_worker_type', {
  title: '被保険者区分の判定 — 四分の三基準と20時間・88,000円・学生・51人',
  description:
    'Decides whether someone is covered by health and pension insurance, and on which ' +
    'payment-basis day count their annual determination runs.\n\n' +
    'Call this before decide_regular_remuneration or judge_monthly_revision whenever the ' +
    'person is anything other than plainly full-time. Those tools take a worker_type, and ' +
    'guessing it changes a real number: the determination counts months of seventeen ' +
    'payment-basis days for an ordinary employee and eleven for a 短時間労働者. Get the ' +
    'classification wrong and the answer is wrong with no sign of it.\n\n' +
    '健康保険法第3条第1項第9号 covers anyone whose weekly hours and monthly days reach ' +
    'three-quarters of a comparable full-time worker. Below that, four further tests decide ' +
    'it: twenty hours a week, 88,000 yen a month, not a student, and a workplace of at least ' +
    'fifty-one insured people. The engagement must also be expected to run past two months.\n\n' +
    'The 88,000 figure leaves out overtime, bonuses, commuting and family allowances. Folding ' +
    'those in is the usual route to a wrong answer, so ask for 所定内賃金 specifically rather ' +
    'than total pay.\n\n' +
    'What counts as a comparable full-time worker, and whether someone is a student for this ' +
    'purpose, are facts about the workplace and the person. Ask rather than assume; the tool ' +
    'applies the tests to what you pass and names any it could not evaluate.',
  inputSchema: {
    weekly_hours: z.number().describe('1週間の所定労働時間.'),
    normal_weekly_hours: z.number().optional().describe(
      'The same figure for a comparable full-time worker at that workplace. Defaults to 40.'),
    monthly_days: z.number().optional().describe(
      '1月間の所定労働日数. The article tests days as well as hours, so pass both where known.'),
    normal_monthly_days: z.number().optional().describe(
      'The same figure for a comparable full-time worker.'),
    monthly_wage: z.number().optional().describe(
      '所定内賃金の月額 — excluding overtime, bonuses, commuting and family allowances.'),
    is_student: z.boolean().optional().describe(
      'A student under 学校教育法. Night courses and those with a graduation certificate are exceptions.'),
    workplace_insured_count: z.number().optional().describe(
      'Pension-insured headcount at the employer, not counting short-time workers.'),
    employment_months: z.number().optional().describe(
      'How long the engagement is expected to run, in months.'),
  },
}, async (a) => call('/v1/worker-type' + qs({
  weekly_hours: a.weekly_hours,
  normal_weekly_hours: a.normal_weekly_hours,
  monthly_days: a.monthly_days,
  normal_monthly_days: a.normal_monthly_days,
  monthly_wage: a.monthly_wage,
  is_student: a.is_student,
  workplace_insured_count: a.workplace_insured_count,
  employment_months: a.employment_months,
})));

server.registerTool('check_insurance_eligibility', {
  title: '入社月・退社月の保険料の要否',
  description:
    'The single most expensive month-end mistake in Japanese payroll, and one an assistant will ' +
    'get wrong from memory.\n\n' +
    'Coverage ends the day AFTER the last day worked, not on it. So an employee leaving on the ' +
    'LAST day of a month loses coverage on the 1st of the next month, and still owes that ' +
    'month\'s premium — while leaving one day earlier means no premium for the month at all. ' +
    'A full month of both employee and employer premium turns on a single day. Always check ' +
    'here rather than reasoning it out.',
  inputSchema: {
    month: z.string().optional().describe('Month to judge, YYYY-MM or a full date. Defaults to today.'),
    joined_on: z.string().optional().describe('First day of employment, YYYY-MM-DD.'),
    left_on: z.string().optional().describe('Last day actually worked, YYYY-MM-DD — not the day after.'),
  },
}, async (a) => call('/v1/eligibility' + qs(a)));

server.registerTool('check_leave_exemption', {
  title: '産休・育休の保険料免除月',
  description:
    'Maternity and childcare leave look alike and behave differently. Maternity leave has no ' +
    'day-count test and exempts bonus premiums unconditionally; childcare leave gained a 14-day ' +
    'rule in October 2022 and exempts bonus premiums only when the leave exceeds one month.\n\n' +
    'Two results catch people out and are worth checking rather than assuming: a leave that ' +
    'starts and ends inside one month exempts nothing by itself under the main rule, while a ' +
    'SINGLE day of leave on the last day of a month is exempt. Employment insurance is never ' +
    'exempt — it is charged on wages actually paid.',
  inputSchema: {
    kind: z.enum(['maternity', 'childcare']).describe('産前産後休業 or 育児休業等.'),
    start: z.string().describe('First day of leave, YYYY-MM-DD.'),
    end: z.string().describe('Last day of leave, YYYY-MM-DD.'),
    worked_days: z.number().optional().describe(
      '出生時育児休業 only: days worked during the leave, which come off the 14-day count.'),
  },
}, async (a) => call('/v1/leave-exemption' + qs(a)));

server.registerTool('get_age_milestones', {
  title: '年齢到達日(40/65/70/75)と保険料の変化',
  description:
    'Returns the exact date each threshold is crossed and which premium starts or stops: ' +
    'long-term care begins at 40 and ends at 65, pension ends at 70, health insurance ends at ' +
    '75 (transfer to 後期高齢者医療).\n\n' +
    'Compute this here rather than by subtracting years. Under 年齢計算ニ関スル法律 an age is ' +
    'reached the day BEFORE the birthday, so someone born on the 1st of a month attains it in ' +
    'the previous month and their premium changes a month earlier than expected.',
  inputSchema: {
    birth_date: z.string().describe('Date of birth, YYYY-MM-DD.'),
    as_of: z.string().optional().describe('Date to judge against. Defaults to today.'),
  },
}, async (a) => call('/v1/age-milestones' + qs(a)));

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

server.registerTool('get_insurance_rates', {
  title: '社会保険料率・雇用保険料率',
  description:
    'Health insurance, long-term care, pension and child-support rates for a prefecture, plus ' +
    'the bonus caps and the employer-only child-care contribution. Health rates differ by ' +
    'prefecture and change each March; pension is national. Add business_type for the ' +
    'employment insurance rates, which change each April.',
  inputSchema: {
    prefecture,
    business_type: z.enum(['general', 'agriculture_forestry_fishery_sake', 'construction']).optional()
      .describe('Include employment insurance rates for this band.'),
  },
}, async (a) => {
  const rates = await call('/v1/insurance-rates' + qs({ prefecture: a.prefecture }));
  if (rates.isError || !a.business_type) return rates;
  const emp = await call('/v1/employment-insurance' + qs({ business_type: a.business_type }));
  if (emp.isError) return emp;
  return ok({
    social_insurance: JSON.parse(rates.content[0].text),
    employment_insurance: JSON.parse(emp.content[0].text),
  });
});

server.registerTool('get_minimum_wage', {
  title: '最低賃金(指定日時点)',
  description:
    'Hourly 地域別最低賃金 for a prefecture. Revisions take effect prefecture by prefecture from ' +
    'October, on different days, so a date matters — pass one when checking a past payroll ' +
    'rather than assuming the current rate applied. History runs back to FY2002.',
  inputSchema: {
    prefecture,
    date: z.string().optional().describe('YYYY-MM-DD. Defaults to the rate currently in force.'),
    history: z.boolean().optional().describe('Return the full history instead of one date.'),
  },
}, async (a) => a.history
  ? call('/v1/minimum-wage/history' + qs({ prefecture: a.prefecture }))
  : call('/v1/minimum-wage' + qs({ prefecture: a.prefecture, date: a.date })));

server.registerTool('business_days', {
  title: '祝日・営業日計算(銀行カレンダー対応)',
  description:
    'Count business days in a range, shift a date by N business days, or check one date. ' +
    'Covers 1955-2027 including substitute holidays, 国民の休日 (a weekday that is a holiday ' +
    'only because it sits between two others) and one-off imperial events, so the awkward years ' +
    'are right and not only the tidy ones.\n\n' +
    'Set calendar to "bank" for the statutory banking calendar (銀行法施行令第5条), which is also ' +
    'closed 31 December to 3 January — relevant for payment due dates.',
  inputSchema: {
    operation: z.enum(['count', 'shift', 'check', 'list']).describe(
      'count = business days between two dates; shift = move a date by N business days; ' +
      'check = classify one date; list = holidays in a year or range.'),
    from: z.string().optional().describe('Start date, YYYY-MM-DD. For count and list.'),
    to: z.string().optional().describe('End date, YYYY-MM-DD. For count and list.'),
    date: z.string().optional().describe('The date, YYYY-MM-DD. For shift and check.'),
    days: z.number().optional().describe('Business days to move; negative goes back. For shift.'),
    year: z.number().optional().describe('Year. For list.'),
    calendar: z.enum(['standard', 'bank']).optional().describe('Defaults to standard.'),
  },
}, async (a) => {
  const cal = { calendar: a.calendar };
  switch (a.operation) {
    case 'count':
      if (!a.from || !a.to) return fail('count needs both from and to.');
      return call('/v1/business-days' + qs({ from: a.from, to: a.to, ...cal }));
    case 'shift':
      if (!a.date || a.days === undefined) return fail('shift needs both date and days.');
      return call('/v1/business-days/shift' + qs({ date: a.date, days: a.days, ...cal }));
    case 'check':
      if (!a.date) return fail('check needs a date.');
      return call('/v1/holidays/check' + qs({ date: a.date, ...cal }));
    case 'list':
      if (!a.year && !(a.from && a.to)) return fail('list needs either year, or both from and to.');
      return call('/v1/holidays' + qs({ year: a.year, from: a.from, to: a.to }));
  }
});

server.registerTool('validate_invoice_numbers_batch', {
  title: 'インボイス登録番号をまとめて形式検査',
  description:
    'Checks the National Tax Agency check digit on many qualified-invoice registration numbers ' +
    'in one call.\n\n' +
    'Be careful how you report the result. A passing check digit means the shape of the number ' +
    'is right and nothing more. 消費税法第57条の2 provides both for the Commissioner to revoke a ' +
    'registration and for one to lapse, so a well-formed number can be unregistered, revoked or ' +
    'expired. Never tell someone a number is valid, verified or confirmed on the strength of ' +
    'this — say the format checks out, and that the register itself was not consulted.\n\n' +
    'What it does earn is elimination. Anything failing on shape needs no lookup at all, so the ' +
    'list taken to 国税庁「適格請求書発行事業者公表サイト」 gets shorter. That site publishes the ' +
    'revocation and lapse dates, and offers a bulk download and a Web-API for large lists.\n\n' +
    'Duplicates come back as given rather than folded together, and each result carries the ' +
    'index of its input, so rows line up with the caller list they came from.',
  inputSchema: {
    numbers: z.array(z.string()).describe(
      'Registration numbers as written, including the leading T. Up to 1000 per call.'),
  },
}, async (a) => call('/v1/invoice-number/validate/batch', { method: 'POST', body: a }));

server.registerTool('validate_corporate_number', {
  title: '法人番号・インボイス登録番号の検証',
  description:
    'Checks the National Tax Agency check digit on a 13-digit 法人番号, or on a qualified ' +
    'invoice registration number (the same 13 digits prefixed with T).\n\n' +
    'This proves the number is well formed. It does NOT prove the number is registered, and it ' +
    'does not identify the holder: sole proprietors receive invoice numbers that satisfy exactly ' +
    'the same rule, so a passing check digit must not be reported as evidence of a corporation. ' +
    'To confirm registration, use the National Tax Agency\'s own lookup.',
  inputSchema: {
    number: z.string().describe('13 digits, or T followed by 13 digits.'),
  },
}, async (a) => {
  const n = a.number.trim();
  return call((/^[Tt]/.test(n) ? '/v1/invoice-number/validate' : '/v1/corporate-number/validate')
    + qs({ number: n }));
});

server.registerTool('get_statute_text', {
  title: '条文の本文を取得',
  description:
    'Returns the full text of a Japanese statutory provision, as published by e-Gov.\n\n' +
    'The judgement tools name the statute or notice their answer rests on, but not its words. ' +
    'Use this to quote the provision itself — a citation the reader can check beats a citation ' +
    'they have to take on trust, and Japanese payroll advice is routinely wrong in ways that ' +
    'only reading the article reveals.\n\n' +
    'Only the provisions this API cites are bundled (about 28 across 8 laws); call it with no ' +
    'ref to list them. Abbreviations as practitioners write them (健保法43条, 厚年法81条の2, ' +
    '徴収法11条), a missing 第, and paragraph-level references all resolve to the article. ' +
    'For anything outside this set, say so rather than reciting it from memory.',
  inputSchema: {
    ref: z.string().optional().describe(
      'A citation such as "健康保険法第43条". Omit to list every provision available.'),
  },
}, async (a) => a.ref
  ? call('/v1/statute' + qs({ ref: a.ref }))
  : call('/v1/statute/index'));

server.registerTool('calculate_overtime_pay', {
  title: '割増賃金(時間外・深夜・休日)の計算',
  description:
    'Works out statutory premium pay under 労働基準法第37条 — overtime, night work and work on ' +
    'a statutory holiday.\n\n' +
    'The rates do not simply add up, and getting this wrong under-pays wages. A night premium ' +
    'stacks on top: overtime at night is 1.25 + 0.25 = 1.5, holiday work at night is ' +
    '1.35 + 0.25 = 1.6. But a statutory holiday carries no overtime premium at all — a day with ' +
    'no duty to work has nothing to exceed — so holiday hours are 1.35, never 1.6 by adding ' +
    'overtime. Overtime beyond sixty hours in a month is 50%, and the deferral that exempted ' +
    'small employers ended on 1 April 2023, so headcount no longer matters.\n\n' +
    'Rounding follows 昭和63年基発第150号, which rounds each category separately rather than once ' +
    'at the end, so the total will not always match a single multiplication. Rounding the hours ' +
    'themselves down is a breach of 労基法第24条 and this tool will not do it.\n\n' +
    'base_monthly_pay must exclude the seven allowances that 労基法37条5項 and 施行規則21条 ' +
    'enumerate exhaustively, and only those. Exclusion turns on substance, not the name: a ' +
    '「家族手当」 paid at a flat rate regardless of dependants cannot be excluded. The response ' +
    'lists all seven. Do not guess at whether an allowance qualifies — ask which way it is paid.',
  inputSchema: {
    base_monthly_pay: z.number().describe(
      'Monthly pay forming the premium base, after removing any of the seven excludable allowances.'),
    monthly_scheduled_hours: z.number().describe(
      '月平均所定労働時間 — annual scheduled working days times daily hours, divided by twelve.'),
    overtime_hours: z.number().optional().describe(
      'Statutory overtime hours, excluding work on a statutory holiday.'),
    night_hours: z.number().optional().describe(
      'How many of those hours fell between 22:00 and 05:00.'),
    holiday_hours: z.number().optional().describe('Hours worked on a statutory holiday.'),
    holiday_night_hours: z.number().optional().describe(
      'How many of those fell between 22:00 and 05:00.'),
  },
}, async (a) => call('/v1/overtime-pay' + qs({
  base_monthly_pay: a.base_monthly_pay,
  monthly_scheduled_hours: a.monthly_scheduled_hours,
  overtime_hours: a.overtime_hours,
  night_hours: a.night_hours,
  holiday_hours: a.holiday_hours,
  holiday_night_hours: a.holiday_night_hours,
})));

server.registerTool('commuting_allowance_exemption', {
  title: '通勤手当の非課税限度額',
  description:
    'Works out how much of a commuting allowance escapes income tax, and states the amount ' +
    'that still counts as remuneration for social insurance.\n\n' +
    'These are two different bases, and that asymmetry is the part people get wrong. Social ' +
    'insurance counts a commuting allowance in full — it is 報酬 under 健康保険法第3条第5項 ' +
    'regardless of the tax treatment — while income tax is charged only on what exceeds the ' +
    'ceiling. So a 15,000 yen allowance on a 300,000 yen salary makes the standard-remuneration ' +
    'basis 315,000 and the taxable pay 300,000. Never answer with a single figure that is meant ' +
    'to serve both.\n\n' +
    'The ceiling is 150,000 a month for public transport. For a car or bicycle it is set by ' +
    'one-way distance, with nothing exempt under two kilometres, and up to 5,000 more a month ' +
    'when the employee pays for parking. Using both adds them together, still capped at 150,000.\n\n' +
    'Do not answer this from memory. The table moved twice in twelve months: a cabinet order ' +
    'promulgated 19 November 2025 raised every band over ten kilometres and applied ' +
    'retroactively to allowances payable from 1 April 2025, and 1 April 2026 added four bands ' +
    'above 65km along with the parking addition. Figures learnt before those dates are wrong, ' +
    'and wrong in a direction that under-states the exempt amount. Call with no arguments to ' +
    'read the current table and both revisions.',
  inputSchema: {
    amount: z.number().optional().describe(
      'The commuting allowance actually paid, yen per month. Omit to get the whole table.'),
    distance_km: z.number().optional().describe(
      'One-way distance for a commute by car or bicycle. Under 2km nothing is exempt.'),
    fare: z.number().optional().describe(
      'Reasonable fare or toll paid alongside a vehicle commute.'),
    parking: z.number().optional().describe(
      'Monthly parking cost the employee bears. Added to the distance band, up to 5,000. Needs distance_km.'),
  },
}, async (a) => call('/v1/commuting-allowance' + qs({
  amount: a.amount, distance_km: a.distance_km, fare: a.fare, parking: a.parking,
})));

server.registerTool('check_data_freshness', {
  title: 'データ鮮度 — 各データの対象期間と次回改定',
  description:
    'Japanese statutory figures change on fixed dates — insurance rates each March, employment ' +
    'insurance each April, minimum wage each October — and a stale table produces numbers that ' +
    'look plausible and are wrong. This reports what every dataset currently covers and when ' +
    'its next revision is due.\n\n' +
    'Worth calling before relying on a figure for a filing, and whenever a result is being ' +
    'checked against a date near one of those boundaries.',
  inputSchema: {},
}, async () => call('/v1/data-freshness'));

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// stderr, not stdout: stdout is the MCP transport and anything written there
// corrupts the protocol stream.
console.error(
  `jp-payroll-mcp ${VERSION} — ${BASE}
` +
  '返す金額は公表された料率表・税額表からの計算結果です。実際の届出や重要な判断の前に、' +
  '社会保険労務士等の専門家と出典元の資料で確認してください。');
