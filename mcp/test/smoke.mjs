/**
 * Drives the server over a real stdio transport with the real MCP client, so this
 * exercises the same path an assistant uses. Checking the tool list is not enough:
 * a tool whose handler builds a bad query string still lists perfectly, and the
 * failure only shows up when someone calls it.
 *
 * Runs against production by default. Point JP_PAYROLL_API_URL at a local
 * `wrangler dev` to test unreleased changes.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(here, '..', 'src', 'index.mjs')],
  env: { ...process.env },
}));

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label, detail) => {
  if (cond) pass++;
  else { fail++; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); }
};

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`  ${tools.length} tools: ${names.join(', ')}\n`);

// Every tool needs a description an assistant can route on. A bare title is how
// tools end up unused, or used for the wrong question.
for (const t of tools) {
  ok((t.description ?? '').length > 120, `${t.name} has a substantive description`,
     `${(t.description ?? '').length} chars`);
  ok(!!t.inputSchema, `${t.name} declares an input schema`);
}

const callTool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let json = null;
  try { json = JSON.parse(text); } catch { /* error strings are not JSON */ }
  return { isError: !!r.isError, text, json };
};

// --- the tools that carry the domain traps ---------------------------------

{
  const r = await callTool('calculate_payslip',
    { prefecture: 'Tokyo', monthly_salary: 350000, age: 40, dependants: 2 });
  ok(!r.isError, 'calculate_payslip succeeds', r.text.slice(0, 200));
  ok(r.json?.deductions?.health_insurance?.employee > 0, 'payslip deducts health insurance');
  ok(r.json?.totals?.net_pay > 0 && r.json.totals.net_pay < 350000,
     'payslip net pay is plausible', `${r.json?.totals?.net_pay}`);
}

{
  // Coverage ends the day after the last day worked, so the last day of a month
  // still owes a premium and the day before does not. This is the tool's whole point.
  const last = await callTool('check_insurance_eligibility',
    { month: '2026-03', left_on: '2026-03-31' });
  const dayBefore = await callTool('check_insurance_eligibility',
    { month: '2026-03', left_on: '2026-03-30' });
  ok(!last.isError && !dayBefore.isError, 'eligibility succeeds');
  ok(JSON.stringify(last.json) !== JSON.stringify(dayBefore.json),
     'leaving on the last day differs from the day before');
}

{
  const r = await callTool('judge_monthly_revision', {
    current_remuneration: 1300000,
    months: '1420000:31,1420000:30,1420000:31',
    fixed_pay_change: 'increase',
  });
  ok(!r.isError, 'judge_monthly_revision succeeds', r.text.slice(0, 200));
  ok(r.json?.schemes?.health?.applies === true, 'the boundary case applies');
  ok(r.json?.schemes?.health?.new_standard_remuneration === 1390000,
     'and lands on the published standard remuneration',
     `${r.json?.schemes?.health?.new_standard_remuneration}`);

  // Overtime alone is not a revision, and the response must say why.
  const none = await callTool('judge_monthly_revision', {
    current_remuneration: 300000, months: '400000:31,400000:30,400000:31',
    fixed_pay_change: 'none',
  });
  ok(none.json?.applies === false, 'overtime alone is not a revision');
  ok((none.json?.blocking_reasons ?? []).length > 0, 'and a reason is given');
}

{
  const r = await callTool('decide_regular_remuneration', { months: '300000:30,302000:31,298000:30' });
  ok(!r.isError && r.json?.decided === true, 'decide_regular_remuneration succeeds',
     r.text.slice(0, 200));
  ok(r.json?.average_remuneration === 300000, 'and averages correctly', `${r.json?.average_remuneration}`);
}

{
  const r = await callTool('judge_leave_end_revision', {
    kind: 'childcare', current_remuneration: 300000, months: '280000:30,282000:31,281000:30',
  });
  ok(!r.isError && r.json?.applies === true, 'judge_leave_end_revision succeeds',
     r.text.slice(0, 200));
  ok(r.json?.grade_difference_required === 1, 'one grade is enough');
}

{
  const months = [];
  for (let i = 0; i < 9; i++) months.push({ remuneration: 250000, payment_basis_days: 30 });
  for (let i = 0; i < 3; i++) months.push({ remuneration: 500000, payment_basis_days: 30 });
  const r = await callTool('judge_annual_average', {
    type: 'regular', months, recurring_annually: true, employee_consent: true,
  });
  ok(!r.isError && r.json?.applies === true, 'judge_annual_average (regular) succeeds',
     r.text.slice(0, 250));
  ok(r.json?.annual_average_remuneration === 312500, 'annual figure spans twelve months',
     `${r.json?.annual_average_remuneration}`);

  // Consent is mandatory and cannot be inferred.
  const noConsent = await callTool('judge_annual_average', {
    type: 'regular', months, recurring_annually: true, employee_consent: false,
  });
  ok(noConsent.json?.applies === false, 'without consent it does not apply');
}

{
  const r = await callTool('check_leave_exemption',
    { kind: 'childcare', start: '2026-03-15', end: '2026-03-28' });
  ok(!r.isError, 'check_leave_exemption succeeds', r.text.slice(0, 200));
  ok(Array.isArray(r.json?.exempt_months), 'and returns exempt months');
}

{
  const r = await callTool('get_age_milestones', { birth_date: '1986-04-01', as_of: '2026-08-25' });
  ok(!r.isError, 'get_age_milestones succeeds', r.text.slice(0, 200));
  // Born on the 1st: the age is attained on the last day of the previous month.
  ok(JSON.stringify(r.json).includes('-03-31'), 'a 1st-of-month birth attains age on the 31st',
     JSON.stringify(r.json).slice(0, 200));
}

{
  const r = await callTool('calculate_bonus',
    { prefecture: 'Tokyo', bonus: 800000, age: 40, fiscal_year_to_date: 0 });
  ok(!r.isError && r.json?.standard_bonus === 800000, 'calculate_bonus succeeds',
     r.text.slice(0, 200));

  const withTax = await callTool('calculate_bonus', {
    prefecture: 'Tokyo', bonus: 500000, age: 40, include_tax: true,
    previous_month_pay: 350000, previous_month_insurance: 55750, dependants: 2,
  });
  ok(!withTax.isError && withTax.json?.withholding_tax, 'and can include withholding tax',
     withTax.text.slice(0, 200));

  // include_tax without the previous month must be refused, not silently ignored.
  const missing = await callTool('calculate_bonus',
    { prefecture: 'Tokyo', bonus: 500000, include_tax: true });
  ok(missing.isError, 'include_tax without previous_month_pay is refused');
}

// --- reference tools --------------------------------------------------------

for (const [name, args, check] of [
  ['calculate_withholding_tax', { taxable_amount: 300000, dependants: 2 }, (j) => j?.tax >= 0],
  ['calculate_withholding_tax', { taxable_amount: 12000, period: 'daily', column: 'hei' }, (j) => j?.tax >= 0],
  ['lookup_standard_remuneration', { remuneration: 350000 }, (j) => j?.health?.grade > 0],
  ['get_insurance_rates', { prefecture: 'Osaka', business_type: 'general' },
   (j) => j?.social_insurance && j?.employment_insurance],
  ['get_minimum_wage', { prefecture: 'Tokyo' }, (j) => j?.minimum_wage > 0 || j?.hourly_wage > 0],
  ['business_days', { operation: 'count', from: '2026-01-01', to: '2026-03-31' }, (j) => j?.business > 0],
  ['business_days', { operation: 'shift', date: '2026-01-01', days: 1 }, (j) => !!j],
  ['validate_corporate_number', { number: '8700110005901' }, (j) => j?.valid === true],
  // The invoice endpoint reports format and check digit separately, because a
  // well-formed number that fails the digit is a different problem from a
  // malformed one, and the caller usually needs to tell them apart.
  ['validate_corporate_number', { number: 'T8700110005901' },
   (j) => j?.format_valid === true && j?.check_digit_valid === true],
  ['check_data_freshness', {}, (j) => j?.counts?.total > 0],
]) {
  const r = await callTool(name, args);
  const label = `${name}(${Object.values(args).join(',') || 'no args'})`;
  ok(!r.isError, `${label} succeeds`, r.text.slice(0, 160));
  ok(!r.isError && check(r.json), `${label} returns the expected shape`, r.text.slice(0, 160));
}

// --- every remaining handler branch -----------------------------------------
// Several tools route internally: business_days has a four-way switch, while
// get_minimum_wage and calculate_withholding_tax pick an endpoint from their
// arguments. A branch nothing exercises is a branch nobody knows is broken.

{
  const check = await callTool('business_days', { operation: 'check', date: '2026-01-01' });
  ok(!check.isError && check.json?.date === '2026-01-01', 'business_days check branch',
     check.text.slice(0, 160));

  const list = await callTool('business_days', { operation: 'list', year: 2026 });
  ok(!list.isError && Array.isArray(list.json?.holidays) && list.json.holidays.length > 10,
     'business_days list branch', list.text.slice(0, 160));

  const range = await callTool('business_days',
    { operation: 'list', from: '2026-01-01', to: '2026-03-31' });
  ok(!range.isError, 'business_days list accepts a range instead of a year', range.text.slice(0, 160));

  // The banking calendar is also closed 31 Dec - 3 Jan, so it must differ.
  const std = await callTool('business_days',
    { operation: 'count', from: '2025-12-29', to: '2026-01-05', calendar: 'standard' });
  const bank = await callTool('business_days',
    { operation: 'count', from: '2025-12-29', to: '2026-01-05', calendar: 'bank' });
  ok(!std.isError && !bank.isError, 'both calendars respond');
  ok(bank.json?.business < std.json?.business, 'the bank calendar closes more days',
     `bank ${bank.json?.business} vs standard ${std.json?.business}`);
}

{
  const hist = await callTool('get_minimum_wage', { prefecture: 'Tokyo', history: true });
  ok(!hist.isError, 'get_minimum_wage history branch', hist.text.slice(0, 160));
  ok(JSON.stringify(hist.json).length > 500, 'and returns more than a single rate');

  const dated = await callTool('get_minimum_wage', { prefecture: 'Tokyo', date: '2015-06-01' });
  ok(!dated.isError, 'get_minimum_wage honours a past date', dated.text.slice(0, 160));
  const now = await callTool('get_minimum_wage', { prefecture: 'Tokyo' });
  ok(JSON.stringify(dated.json) !== JSON.stringify(now.json),
     'and a 2015 rate differs from the current one');
}

{
  const table = await callTool('calculate_withholding_tax', { taxable_amount: 400000, dependants: 1 });
  const formula = await callTool('calculate_withholding_tax',
    { taxable_amount: 400000, dependants: 1, method: 'computer' });
  ok(!formula.isError, 'calculate_withholding_tax computer branch', formula.text.slice(0, 160));
  ok(typeof formula.json?.tax === 'number', 'and returns a figure');
  // The two methods are permitted to differ slightly; both must be sane.
  ok(Math.abs(formula.json.tax - table.json.tax) < 2000,
     'table and formula methods agree to within a plausible margin',
     `table ${table.json?.tax} vs formula ${formula.json?.tax}`);
}

{
  // birth_date must be honoured. Born 1 April 1986: turns 40 on 31 March 2026
  // under 年齢計算ニ関スル法律, so long-term care applies by August 2026.
  const byDate = await callTool('calculate_payslip',
    { prefecture: 'Tokyo', monthly_salary: 350000, birth_date: '1986-04-01' });
  ok(!byDate.isError, 'calculate_payslip accepts birth_date', byDate.text.slice(0, 160));
  ok(byDate.json?.coverage?.long_term_care === true,
     'and a 1-April-1986 birth is in long-term care by 2026',
     JSON.stringify(byDate.json?.coverage));
}

{
  const monthsRev = [];
  for (let i = 0; i < 9; i++) monthsRev.push({ fixed: 250000, non_fixed: 20000, payment_basis_days: 30 });
  for (let i = 0; i < 3; i++) monthsRev.push({ fixed: 280000, non_fixed: 200000, payment_basis_days: 30 });
  const r = await callTool('judge_annual_average', {
    type: 'revision', months: monthsRev, current_remuneration: 270000,
    fixed_pay_change: 'increase', recurring_annually: true, employee_consent: true,
  });
  ok(!r.isError, 'judge_annual_average revision branch', r.text.slice(0, 250));
  // 3-month fixed average (280,000) + 12-month non-fixed average (65,000).
  ok(r.json?.annual_average_remuneration === 345000,
     'and combines 3-month fixed with 12-month non-fixed',
     `${r.json?.annual_average_remuneration}`);
  ok(!!r.json?.schemes?.health?.test_3_current_vs_annual, 'reporting all three grade tests');
}

{
  const short = await callTool('decide_regular_remuneration',
    { months: '120000:12,120000:11,120000:10', worker_type: 'short_time_insured' });
  ok(!short.isError && short.json?.payment_basis_threshold === 11,
     'decide_regular_remuneration honours the 11-day worker type', short.text.slice(0, 160));

  const pt = await callTool('decide_regular_remuneration',
    { months: '300000:16,300000:15,300000:10', worker_type: 'part_time_short_hours' });
  ok(!!pt.json?.fallback_applied, 'and the 15-day fallback for 短時間就労者',
     `${pt.json?.fallback_applied}`);

  const acq = await callTool('decide_regular_remuneration',
    { months: '300000:30,300000:31,300000:30', acquired_month: 3 });
  ok(!!acq.json?.acquisition_decision, 'and reports the 資格取得時決定 period when asked');
}

{
  const blocked = await callTool('judge_leave_end_revision', {
    kind: 'maternity', current_remuneration: 300000, months: '280000:30,282000:31,281000:30',
    next_leave_starts_immediately: true,
  });
  ok(blocked.json?.applies === false, 'a leave beginning the next day bars the application');
  ok((blocked.json?.blocking_reasons ?? []).length > 0, 'and says so');
}

{
  const bare = await callTool('get_insurance_rates', { prefecture: 'Tokyo' });
  ok(!bare.isError && !bare.json?.employment_insurance,
     'get_insurance_rates without business_type returns social insurance only',
     bare.text.slice(0, 160));
  const other = await callTool('get_insurance_rates', { prefecture: 'Niigata' });
  ok(JSON.stringify(bare.json) !== JSON.stringify(other.json),
     'and health rates differ between prefectures');

  // Japanese and JIS-code forms must resolve identically to the English name.
  const ja = await callTool('get_insurance_rates', { prefecture: '東京都' });
  const code = await callTool('get_insurance_rates', { prefecture: '13' });
  ok(!ja.isError && !code.isError, 'Japanese and JIS-code prefectures resolve');
  ok(bare.json?.rates?.health_insurance === ja.json?.rates?.health_insurance
     && bare.json?.rates?.health_insurance === code.json?.rates?.health_insurance,
     'and all three forms give the same rates');
}

{
  // A wrong check digit must be reported invalid, not waved through.
  const bad = await callTool('validate_corporate_number', { number: '8700110005900' });
  ok(!bad.isError, 'a wrong check digit still returns a result');
  ok(bad.json?.valid === false, 'and reports it invalid', bad.text.slice(0, 160));
}

// --- 条文本文 ---
{
  const r = await callTool('get_statute_text', { ref: '健康保険法第43条' });
  ok(!r.isError, 'get_statute_text succeeds', r.text.slice(0, 160));
  ok(r.json?.caption === '（改定）', 'and returns the article caption', r.json?.caption);
  ok((r.json?.text ?? '').includes('著しく高低を生じた場合'),
     'with the actual provision text', (r.json?.text ?? '').slice(0, 60));

  // 実務の略記で引ける必要がある。社労士が書くのは「厚年法81条の2」であって
  // 正式名称ではない。
  const abbrev = await callTool('get_statute_text', { ref: '厚年法81条の2' });
  ok(abbrev.json?.ref === '厚生年金保険法第81条の2',
     'a practitioner abbreviation resolves', abbrev.json?.ref);

  const index = await callTool('get_statute_text', {});
  ok(!index.isError && index.json?.count >= 28, 'omitting ref lists everything available',
     `${index.json?.count}`);

  // 収録外は、それらしい条文を返すのではなく断ること。
  const missing = await callTool('get_statute_text', { ref: '所得税法第28条' });
  ok(missing.isError, 'a provision outside the bundle is refused, not invented');
}

// --- guard rails ------------------------------------------------------------

{
  // The 丙 column exists only in the daily table; the server should catch this
  // before spending a request on it.
  const r = await callTool('calculate_withholding_tax',
    { taxable_amount: 12000, column: 'hei', period: 'monthly' });
  ok(r.isError, 'the 丙 column is refused for the monthly table');

  const c = await callTool('calculate_withholding_tax',
    { taxable_amount: 12000, period: 'daily', method: 'computer' });
  ok(c.isError, 'the formula method is refused for the daily table');

  const b = await callTool('business_days', { operation: 'count', from: '2026-01-01' });
  ok(b.isError, 'count without an end date is refused');
}

{
  // A 400 from the API must reach the model intact so it can fix its arguments.
  const r = await callTool('judge_monthly_revision',
    { current_remuneration: 300000, months: '300000:31,300000:30', fixed_pay_change: 'increase' });
  ok(r.isError, 'a malformed months argument is rejected');
  ok(/3 entries|hint/i.test(r.text), 'and the reason reaches the caller', r.text.slice(0, 160));
}
{
  // 通勤手当: 非課税は限度額まで、社会保険は全額。この2つが分かれることが肝。
  const car = await callTool('commuting_allowance_exemption',
    { amount: 12000, distance_km: 12, parking: 3000 });
  ok(!car.isError, 'commuting_allowance_exemption answers', car.text.slice(0, 160));
  ok(car.json?.non_taxable === 10300,
     'a 12km commute with 3,000 parking exempts 7,300 + 3,000',
     `${car.json?.non_taxable}`);
  ok(car.json?.social_insurance?.remuneration === 12000,
     'while social insurance still counts the whole 12,000 as remuneration',
     `${car.json?.social_insurance?.remuneration}`);

  const table = await callTool('commuting_allowance_exemption', {});
  ok(table.json?.reference?.parking?.cap === 5000,
     'the parking cap is 5,000 — 五千円, not 五万円',
     `${table.json?.reference?.parking?.cap}`);
  ok(table.json?.reference?.vehicle?.bands?.some((b) => b.limit === 7300),
     'and the table carries the post-revision 7,300 band, not the old 7,100');
  ok(table.json?.revisions?.length === 2,
     'both revisions of the last twelve months are reported',
     `${table.json?.revisions?.length}`);

  const bad = await callTool('commuting_allowance_exemption', { amount: 10000, parking: 3000 });
  ok(bad.isError || bad.json?.error,
     'parking without a distance is refused rather than silently ignored',
     bad.text.slice(0, 160));
}
{
  // 深夜は加算。時間外10h(うち深夜5h)。時給1,875 = 300,000 / 160。
  // 基発150号は区分ごとに端数処理するので 1875*10*1.25 と 1875*5*0.25 を別々に丸める。
  const r = await callTool('calculate_overtime_pay',
    { base_monthly_pay: 300000, monthly_scheduled_hours: 160, overtime_hours: 10, night_hours: 5 });
  ok(!r.isError, 'calculate_overtime_pay answers', r.text.slice(0, 160));
  ok(r.json?.hourly_rate?.value === 1875, 'the hourly rate is 300,000 / 160 = 1,875',
     `${r.json?.hourly_rate?.value}`);
  ok(r.json?.lines?.overtime?.amount === Math.floor(1875 * 10 * 1.25 + 0.5),
     'overtime at 1.25 is rounded on its own', `${r.json?.lines?.overtime?.amount}`);
  ok(r.json?.lines?.night_premium?.amount === Math.floor(1875 * 5 * 0.25 + 0.5),
     'and the night premium is a separate 0.25 on top, not a whole extra hour',
     `${r.json?.lines?.night_premium?.amount}`);

  // 60時間超は50%。70時間なら60時間分が1.25、10時間分が1.5。
  const long = await callTool('calculate_overtime_pay',
    { base_monthly_pay: 300000, monthly_scheduled_hours: 160, overtime_hours: 70 });
  ok(long.json?.lines?.overtime?.hours === 60 && long.json?.lines?.overtime_over_60h?.hours === 10,
     '70 hours splits into 60 at 1.25 and 10 at 1.5',
     `${long.json?.lines?.overtime?.hours} / ${long.json?.lines?.overtime_over_60h?.hours}`);

  // 法定休日に時間外割増は付かない。1.35であって1.6ではない。
  const hol = await callTool('calculate_overtime_pay',
    { base_monthly_pay: 300000, monthly_scheduled_hours: 160, holiday_hours: 8 });
  ok(hol.json?.lines?.holiday?.rate === 1.35,
     'holiday work is 1.35, with no overtime premium added',
     `${hol.json?.lines?.holiday?.rate}`);

  ok(r.json?.excludable_allowances?.length === 7,
     'and the seven excludable allowances are returned with the answer',
     `${r.json?.excludable_allowances?.length}`);
}
{
  // MCP は課金への入口なので、API に足した機能が MCP に出ていないと、
  // 作ったこと自体が導線に届かない。第2反復で割増賃金がまさにそうだった。
  // API にあって MCP から呼べない経路は、ここに理由を書いた分だけ許す。
  const NOT_A_TOOL = {
    '/v1/payroll/batch':
      'Batch is the paid HTTP path. MCP is one person at a time by nature, and putting ' +
      'batch here would blur the boundary the free tier is drawn on.',
    '/v1/enums': 'Build-time reference for developers writing a client, not a question anyone asks.',
    '/v1/prefectures': 'A list of the 47 prefectures. get_insurance_rates takes the name directly.',
    '/v1/standard-remuneration/table':
      'Bulk data. lookup_standard_remuneration answers the question a person actually has.',
    '/v1/corporate-number/check-digit':
      'Computing a check digit is for generating test numbers. validate_corporate_number covers the real use.',
    '/v1/consumption-tax':
      'Scores nothing on the three conditions in LOOP.md — one number, trivially copied, rarely changes. ' +
      'Every extra tool makes the others harder to choose between.',
    '/v1/consumption-tax/history': 'Same as /v1/consumption-tax.',
  };

  const src = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const reached = new Set(src.match(/'\/v1\/[a-z0-9/-]+'/g)?.map((m) => m.slice(1, -1)) ?? []);
  // 既定URLは MCP 本体から読む。ここに書き写すと、公開済みパッケージが指す先と
  // テストが見る先が静かにずれる。
  const fallback = /\?\?\s*'([^']+)'/.exec(src.slice(src.indexOf('const BASE')))?.[1];
  ok(typeof fallback === 'string' && fallback.startsWith('https://'),
     'the MCP server carries a default API URL', String(fallback));
  const api = (process.env.JP_PAYROLL_API_URL ?? fallback).replace(/\/+$/, '');
  const spec = await (await fetch(`${api}/openapi.json`)).json();
  const documented = Object.keys(spec.paths ?? {}).filter((p) => p.startsWith('/v1'));

  const missing = documented.filter((p) => !reached.has(p) && !(p in NOT_A_TOOL));
  ok(missing.length === 0,
     'every API endpoint either has an MCP tool or a written reason it does not',
     missing.join(', ') || 'none');

  // 除外理由が実在しない経路を指したまま残らないこと。
  const stale = Object.keys(NOT_A_TOOL).filter((p) => !documented.includes(p));
  ok(stale.length === 0, 'and no exclusion points at an endpoint that no longer exists',
     stale.join(', ') || 'none');
}
{
  // 年齢は「あると精度が上がる」ものではなく徴収の要件そのもの(介護保険法第9条)。
  // 省略されたらHTTP 400を素通しするのではなく、何を聞けばよいかを返す。
  const noAge = await callTool('calculate_payslip', { prefecture: 'Tokyo', monthly_salary: 300000 });
  ok(noAge.isError, 'calculate_payslip refuses a payslip with no age', noAge.text.slice(0, 120));
  ok(/介護保険法第9条/.test(noAge.text ?? ''),
     'and cites the article that makes age the test', noAge.text.slice(0, 200));
  ok(/birth_date/.test(noAge.text ?? ''),
     'and tells the agent to ask for a date of birth rather than an age',
     noAge.text.slice(0, 200));

  const withAge = await callTool('calculate_payslip',
    { prefecture: 'Tokyo', monthly_salary: 300000, age: 45 });
  ok(!withAge.isError && withAge.json?.coverage?.long_term_care === true,
     'and answers once the age is there', withAge.text.slice(0, 120));

  const bonusNoAge = await callTool('calculate_bonus', { prefecture: 'Tokyo', bonus: 500000 });
  ok(bonusNoAge.isError, 'calculate_bonus refuses one too', bonusNoAge.text.slice(0, 120));

  // 生年月日で通ることも確かめる。1日生まれは誕生日の前日に年齢に達するので、
  // age だけでは1か月ずれる (年齢計算ニ関スル法律)。
  const byBirth = await callTool('calculate_payslip',
    { prefecture: 'Tokyo', monthly_salary: 300000, birth_date: '1981-05-01' });
  ok(!byBirth.isError && byBirth.json?.coverage?.long_term_care === true,
     'birth_date alone is accepted', byBirth.text.slice(0, 120));
}
{
  // ツールを増やすこと自体が、選択精度を下げる。
  //
  // 公開されている調査では、絞ったツールセットで95%だった選択精度が、大きなMCPを
  // 丸ごと読み込むと71%まで落ちている。24ポイントの差がコンテキスト肥大だけで生じた。
  // 劣化が始まるのは概ね30〜50本という指摘が複数ある。
  //
  // この周回で6本増やした。同じペースで2周すれば30を超える。**7本目・8本目のほうが、
  // 案内文の千数百トークンより危ない。**上限を決めて、超えたら気づく形にしておく。
  //
  // 30を超えたときにすべきは、ここを緩めることではない。近いツールを統合するか、
  // 使われていないものを落とすか。緩めるのは、劣化を測ってからにする。
  const TOOL_BUDGET = 30;
  ok(tools.length <= TOOL_BUDGET,
     `the server stays inside its tool budget of ${TOOL_BUDGET}`,
     `${tools.length} tools`);

  // 説明は削らない。選択を決めているのはここで、短すぎるほうが誤選択を招く。
  // 名前だけで隣のツールと区別がつかないなら、説明が要る。
  const thin = tools.filter((t) => (t.description ?? '').length < 200);
  ok(thin.length === 0,
     'and every tool carries enough description to be told apart from its neighbours',
     thin.map((t) => t.name).join(', ') || 'none');

  // 案内文は選択のためではなく、答えの正しさのために置く。
  // 口語→ツールの対応表を足して44問で測ったところ、routing あり/なしで
  // 回答が1問も変わらなかったので外した。ここに戻すなら、また測ってからにする。
  const instructions = client.getInstructions() ?? '';
  ok(instructions.length > 0, 'the server still ships instructions', `${instructions.length} chars`);
  ok(/Do not answer a Japanese payroll question from memory/.test(instructions),
     'telling the assistant not to answer from memory');
  ok(/coverage ends the day \*\*after\*\*/.test(instructions)
       || /day \*\*after\*\* the last day worked/.test(instructions),
     'and carrying the traps that make a remembered answer wrong');
  ok(!/## What people actually ask/.test(instructions),
     'without the routing table, which measured as making no difference across 44 questions');
  // 実測 3,372字。routing の2,671字が戻れば6,043字になるので、その間に置く。
  // 案内文そのものを禁じるのではなく、効果を測らずに膨らむのを止めるための線。
  ok(instructions.length < 4500,
     'and short enough that it is not paying for itself in tokens alone',
     `${instructions.length} chars`);
}
{
  // 断るときの言葉が、どちらの層で捕まえたかで変わらないこと。
  //
  // API は F-35 で和文に揃えたが、MCP が手前で弾く分は英語のままだった。
  // 「年齢が無い」という同じ条件で、MCP が先に気づけば英語、API まで届けば和文。
  // 一つの製品の中で、捕まえた場所によって言語が変わっていた。
  //
  // ソースを走査するのではなく、実際にツールを呼んで失敗させて確かめる。
  // 走査は今周回だけで四度すり抜けたので、出てきた文そのものを見る。
  const JA = /[ぁ-んァ-ヶ一-龥]/;
  const refusals = [];
  for (const [name, args] of [
    ['calculate_payslip', { prefecture: 'Tokyo', monthly_salary: 300000 }],
    ['calculate_bonus', { prefecture: 'Tokyo', bonus: 500000 }],
    ['calculate_annual_cost', { prefecture: 'Tokyo', monthly_salary: 300000 }],
    ['calculate_withholding_tax', { taxable_amount: 300000, period: 'daily', method: 'computer' }],
    ['calculate_withholding_tax', { taxable_amount: 300000, period: 'monthly', column: 'hei' }],
    ['business_days', { operation: 'nonsense' }],
    ['business_days', { operation: 'count' }],
    ['business_days', { operation: 'shift' }],
    ['business_days', { operation: 'check' }],
    ['business_days', { operation: 'list' }],
    ['calculate_payslip', { prefecture: '大阪県', monthly_salary: 300000, age: 40 }],
    ['calculate_payslip', { prefecture: 'Tokyo', monthly_salary: 300000, age: 40, dependants: -1 }],
    ['get_minimum_wage', { prefecture: 'Tokyo', date: '2026-10-01' }],
    ['get_statute_text', { ref: '宇宙法第1条' }],
  ]) {
    const r = await client.callTool({ name, arguments: args });
    if (!r.isError) continue;
    const text = r.content.map((x) => x.text).join('');
    refusals.push([name, text]);
  }
  ok(refusals.length >= 10, 'the probes actually produced refusals to read', `${refusals.length}`);
  const english = refusals.filter(([, t]) => !JA.test(t)).map(([n, t]) => `${n}: ${t.slice(0, 40)}`);
  ok(english.length === 0,
     'and every one of them speaks Japanese, whichever layer caught it',
     english.slice(0, 4).join(' | ') || 'none');

  // 機械可読な code は英字のまま。第18反復の線引きを MCP でも守る。
  const withCode = refusals.filter(([, t]) => /\[[a-z_]+\]$/.test(t.trim())
    || /"code":\s*"[a-z_]+"/.test(t));
  ok(withCode.length >= 5, 'while the code stays machine-readable', `${withCode.length} carry one`);

  // 空の値は API 側で拒否される。MCP がそれを握り潰さず伝えること。
  const empty = await client.callTool({
    name: 'judge_worker_type', arguments: { weekly_hours: 0, normal_weekly_hours: 40 } });
  ok(!empty.isError, '0 は明示された値なので通る(空文字とは別)',
     empty.content.map((x) => x.text).join('').slice(0, 60));
}
{
  // MCPから届かないエンドポイントを、意図した3本だけに固定する。
  //
  // 44本のAPIに対し、MCPが叩いていたのは36本だった。届かない7本は誰も気づかない —
  // ツール一覧を見ても「無いもの」は見えないため。ここで数える。
  //
  // 足さないと決めたものには理由がある。enums と prefectures は列挙をスキーマが
  // 持っているので、MCP経由では意味がない。残る5本は塞いだ。うち2本は既存ツールの
  // 引数で塞いでおり、ツール枠(上限30)を使っていない。
  const src = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const reached = new Set([...src.matchAll(/['"`](\/v1\/[\w/-]+)/g)].map((m) => m[1]));
  const DELIBERATELY_OUT = {
    '/v1/enums': '受け付ける値の集合。MCPではスキーマが同じことを伝えている',
    '/v1/prefectures': '都道府県の一覧。prefecture の説明に書いてある',
  };
  // サーバ本体と同じ決め方で向き先を出す。ここを固定値にすると、本番を見に行く。
  const base = process.env.JP_PAYROLL_API_URL
    ?? /\?\?\s*'([^']+)'/.exec(src.slice(src.indexOf('const BASE')))?.[1];
  const spec = JSON.parse(await (await fetch(`${base}/openapi.json`)).text());
  const api = Object.keys(spec.paths).filter((p) => p.startsWith('/v1/'));
  const unreached = api.filter((p) => !reached.has(p));
  const unexplained = unreached.filter((p) => !(p in DELIBERATELY_OUT));
  ok(api.length >= 40, 'the API has that many endpoints to cover', `${api.length}`);
  ok(unexplained.length === 0,
     'and every one of them is reachable from a tool, or listed here with a reason',
     unexplained.join(', ') || 'none');
  ok(Object.keys(DELIBERATELY_OUT).every((p) => api.includes(p)),
     'while the reasons still refer to endpoints that exist');

  // 引数で塞いだ2本 — ツールを増やさずに届くこと。
  const table = await client.callTool({ name: 'lookup_standard_remuneration', arguments: {} });
  const tableText = table.content.map((x) => x.text).join('');
  ok(!table.isError && /"health_grades":\s*50/.test(tableText),
     'omitting the amount returns the whole grade table rather than an error',
     tableText.slice(0, 60));
  const one = await client.callTool({
    name: 'lookup_standard_remuneration', arguments: { remuneration: 305000 } });
  ok(/"grade":\s*22/.test(one.content.map((x) => x.text).join('')),
     'while passing one still looks that one up');

  const cd = await client.callTool({
    name: 'validate_corporate_number', arguments: { base: '700110005901' } });
  ok(/"corporate_number":\s*"8700110005901"/.test(cd.content.map((x) => x.text).join('')),
     'the 12-digit base yields its 13-digit number through the same tool');
  const neither = await client.callTool({ name: 'validate_corporate_number', arguments: {} });
  ok(neither.isError && /number か base/.test(neither.content.map((x) => x.text).join('')),
     'and asking for neither says which one to send');

  // 消費税。過去の日付でその時点の率が返ること — ここを黙って現行率にすると、
  // 遡って発行する請求書の税額が静かに間違う。
  const ct = await client.callTool({
    name: 'consumption_tax', arguments: { date: '2015-06-01', amount: 10000 } });
  const ctText = ct.content.map((x) => x.text).join('');
  ok(/"rate":\s*0\.08/.test(ctText), 'a 2015 date is charged at 8%, not at today’s rate',
     ctText.slice(0, 80));
  const hist = await client.callTool({ name: 'consumption_tax', arguments: { history: true } });
  ok(/"count":\s*4/.test(hist.content.map((x) => x.text).join('')),
     'and the history carries all four changes since 1989');

  // 給与バッチ。1人ずつ呼ぶと合計も run_id も得られない。
  const batch = await client.callTool({
    name: 'calculate_payroll_batch',
    arguments: {
      employees: [{ monthly_salary: 300000 }, { monthly_salary: 420000, age: 45 }],
      defaults: { prefecture: 'Tokyo', age: 30 }, compact: true,
    },
  });
  const bText = batch.content.map((x) => x.text).join('');
  ok(!batch.isError && /"succeeded":\s*2/.test(bText), 'the batch runs both rows', bText.slice(0, 70));
  ok(/"run_id"/.test(bText), 'and carries the run id a retry can be checked against');
}
{
  // READMEは商品棚。載っていない機能は、無いのと同じ。
  //
  // 公開判断のために数えたら、READMEは「17 tools」のままで11本が未掲載だった。
  // 未掲載だったのは割増賃金・有給・被保険者区分・国保国年・労災・バッチ・消費税で、
  // **いちばん人が探しているもの**が並んで抜けていた。ツールを足すたびに書き足す、
  // という運用は3回続けて守られていない。だから数える。
  const source = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const names = [...source.matchAll(/registerTool\('([\w_]+)'/g)].map((m) => m[1]);
  for (const f of ['README.md', 'README.ja.md']) {
    const txt = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    const missing = names.filter((n) => !txt.includes(n));
    ok(missing.length === 0, `${f} lists every tool that exists`, missing.join(', ') || 'none');
    // 逆向きも見る。消したツールの説明が残ると、動かないものを宣伝することになる。
    const advertised = [...txt.matchAll(/`([a-z][a-z0-9_]{6,})`/g)].map((m) => m[1])
      .filter((w) => /_/.test(w) && !names.includes(w));
    const ghosts = [...new Set(advertised)].filter((w) => /^(calculate|judge|decide|check|get|list|lookup|validate|business|national|commuting|consumption)_/.test(w));
    ok(ghosts.length === 0, `${f} advertises nothing that was removed`, ghosts.join(', ') || 'none');
    const claimed = /(\d+) tools|ツール一覧\((\d+)\)/.exec(txt);
    ok(claimed && Number(claimed[1] ?? claimed[2]) === names.length,
       `${f} states the right count`, `says ${claimed?.[1] ?? claimed?.[2]}, has ${names.length}`);
  }
}
{
  // ツールのスキーマに無い引数は、MCP利用者にとって存在しない。
  //
  // エンドポイントの網羅は第21反復で数えたが、**引数の粒度では見ていなかった。**
  // 数えたら4件あった — 通勤の駐車場代、賞与の as_of と乙欄、電算の配偶者控除。
  // どれも REST では使えて MCP では使えない、という状態だった。
  const toolSrc = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const specBase = process.env.JP_PAYROLL_API_URL
    ?? /\?\?\s*'([^']+)'/.exec(toolSrc.slice(toolSrc.indexOf('const BASE')))?.[1];
  const apiSpec = JSON.parse(await (await fetch(`${specBase}/openapi.json`)).text());

  // 露出しないと決めたものは理由つきで挙げる。書いていない例外は例外でない。
  const NOT_EXPOSED = {
    'calculate_bonus:/v1/bonus-tax:bonus_insurance':
      'ツールが賞与の社会保険料を先に計算して渡す。呼び手に渡させると、既定0で'
      + '50万円の賞与に3,063円の過大な税額が出た事故に戻る',
  };
  const CROSS = new Set(['detail', 'include', 'pref', 'amount', 'start', 'end']);
  const blocks = toolSrc.split("server.registerTool('").slice(1);
  const gaps = [], staleReasons = [];
  const { tools: liveTools } = await client.listTools();
  for (const b of blocks) {
    const name = b.slice(0, b.indexOf("'"));
    const tool = liveTools.find((x) => x.name === name);
    if (!tool) continue;
    const props = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
    for (const path of new Set([...b.matchAll(/['"`](\/v1\/[\w/-]+)/g)].map((m) => m[1]))) {
      const op = apiSpec.paths[path]?.get;
      if (!op) continue;
      for (const p of (op.parameters ?? []).map((x) => x.name)) {
        if (CROSS.has(p) || props.has(p)) continue;
        const key = `${name}:${path}:${p}`;
        if (!(key in NOT_EXPOSED)) gaps.push(key);
      }
    }
  }
  for (const key of Object.keys(NOT_EXPOSED)) {
    const [n, path, p] = key.split(':');
    const op = apiSpec.paths[path]?.get;
    if (!op || !(op.parameters ?? []).some((x) => x.name === p)) staleReasons.push(key);
  }
  ok(blocks.length >= 25, 'every tool is compared against the endpoint behind it', `${blocks.length}`);

  // 版番号は1箇所から。2つ持てばずれる — 実際 package.json が 0.4.0 の間、
  // サーバは 0.3.0 と名乗っていた。利用者が版を確かめる唯一の手段がこれなのに。
  const pkgJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  // 公式MCPレジストリへの登録票。版を上げるたびに置き去りになるので固定する。
  // 食い違ったまま出すと、レジストリ側の所有権検証で落ちる。
  // (第28反復と同じ話 — 事実を2箇所に持てばいつか必ずずれる)
  const serverJson = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));
  ok(serverJson.name === pkgJson.mcpName,
     'server.json の名前が package.json の mcpName と一致する',
     `${serverJson.name} / ${pkgJson.mcpName}`);
  ok(serverJson.version === pkgJson.version
     && serverJson.packages?.[0]?.version === pkgJson.version,
     'and both versions in it track the package',
     `${serverJson.version} / ${serverJson.packages?.[0]?.version} / ${pkgJson.version}`);
  ok(serverJson.packages?.[0]?.identifier === pkgJson.name,
     'and it points at this npm package', serverJson.packages?.[0]?.identifier);
  // レジストリは description を100文字までしか受け付けない。超えると 422 で弾かれ、
  // **登録できない=誰にも見つからない。**手元で気づけるようにする。
  ok((serverJson.description ?? '').length <= 100,
     'and the description fits the 100 characters the registry allows',
     `${(serverJson.description ?? '').length} 文字`);
  ok((serverJson.description ?? '').length >= 30,
     'while still saying what it does', `${(serverJson.description ?? '').length} 文字`);

  // npm の検索順位はテキスト一致で決まり、description の一致は keywords より強い。
  // 実測: `社労士`(descriptionにある・競合2,787件) は1位でスコア163.9、
  // `給与計算`(keywords止まり・競合43,720件) は圏外だった。首位のスコアは99.6なので、
  // **同じ強さで一致できれば上位に入る。**いちばん検索される語を description に置く。
  for (const term of ['給与計算', '社会保険', '標準報酬月額', '社労士']) {
    ok((pkgJson.description ?? '').includes(term),
       `npm の description が「${term}」を含む(検索の入口)`);
  }
  ok((pkgJson.keywords ?? []).length >= 20,
     'and the keywords still back it up', `${(pkgJson.keywords ?? []).length} 語`);

  // 依頼リストのコマンドは、**どのシェルでも**動くこと。
  //
  // `./mcp-publisher.exe` を渡して cmd.exe に「'.' は認識されていません」と言わせ、
  // 次に `cd /d ... && ...` を渡して PowerShell 5.1 に構文エラーを出させた。
  // 相手は cmd と PowerShell を行き来している。**片方でしか動かない手順は手順ではない。**
  // 連結をやめ、1コマンド1行にする。
  const todo = await readFile(new URL('../../docs/TODO-owner.md', import.meta.url), 'utf8');
  const broken = [];
  let inBlock = false;
  for (const [i, line] of todo.split(String.fromCharCode(10)).entries()) {
    if (line.startsWith('```')) { inBlock = !inBlock; continue; }
    if (!inBlock || !line.trim()) continue;
    if (line.includes('&&')) broken.push(`${i + 1}: && は PowerShell 5.1 で落ちる`);
    if (/(?<![A-Za-z])cd \/d/.test(line)) broken.push(`${i + 1}: cd /d は PowerShell で不正`);
    if (line.trim().startsWith('./')) broken.push(`${i + 1}: ./ は cmd.exe で不正`);
    if (/(?<![A-Za-z])\/d\/[A-Za-z]/.test(line)) broken.push(`${i + 1}: /d/ 形式は Windows で不正`);
    if (line.includes(String.fromCharCode(9))) broken.push(`${i + 1}: タブ混入`);
  }
  ok(broken.length === 0,
     'every command in the owner checklist runs in cmd.exe and PowerShell alike',
     broken.slice(0, 4).join(' | ') || 'none');
  ok(client.getServerVersion?.()?.version === pkgJson.version,
     'the server announces the version the package declares',
     `${client.getServerVersion?.()?.version} vs ${pkgJson.version}`);
  ok(!/const VERSION = '\d/.test(toolSrc),
     'and does not keep a second copy of it in the source');
  ok(gaps.length === 0,
     'and exposes every parameter that endpoint takes, or says why not',
     gaps.slice(0, 5).join(' | ') || 'none');
  ok(staleReasons.length === 0,
     'while the exemptions still name parameters that exist',
     staleReasons.join(' | ') || 'none');

  // 足した4つが実際に効くこと。スキーマにあって届かない、が最悪。
  const text = async (n, a) => {
    const r = await client.callTool({ name: n, arguments: a });
    return r.content.map((x) => x.text).join('');
  };
  const commute = { prefecture: 'Tokyo', monthly_salary: 300000, age: 40,
                    commuting_allowance: 12000, commuting_distance_km: 12 };
  ok(await text('calculate_payslip', commute)
     !== await text('calculate_payslip', { ...commute, commuting_parking: 3000 }),
     '駐車場代が非課税限度額を動かす');

  const comp = { taxable_amount: 300000, method: 'computer', dependants: 0 };
  const noSpouse = JSON.parse(await text('calculate_withholding_tax', comp));
  const withSpouse = JSON.parse(await text('calculate_withholding_tax', { ...comp, spouse: true }));
  ok(withSpouse.tax < noSpouse.tax,
     '配偶者控除が電算機計算の特例で効く(月31,667円の控除)',
     `${noSpouse.tax} → ${withSpouse.tax}`);

  const bonus = { prefecture: 'Tokyo', bonus: 500000, age: 40, include_tax: true,
                  previous_month_pay: 350000, previous_month_insurance: 55750, dependants: 2 };
  ok(await text('calculate_bonus', bonus) !== await text('calculate_bonus', { ...bonus, column: 'otsu' }),
     '乙欄は賞与の税率表が別');
}










await client.close();
console.log(`  passed ${pass} / ${pass + fail}`);
if (fail) { console.log('\n  FAILURES:'); failures.forEach((f) => console.log('   - ' + f)); process.exit(1); }
console.log('  all checks green\n');
