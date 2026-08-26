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

await client.close();
console.log(`  passed ${pass} / ${pass + fail}`);
if (fail) { console.log('\n  FAILURES:'); failures.forEach((f) => console.log('   - ' + f)); process.exit(1); }
console.log('  all checks green\n');
