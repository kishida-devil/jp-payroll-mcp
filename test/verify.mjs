// Verifies the running API against premium amounts published in the official
// 協会けんぽ 令和8年度保険料額表 workbook, plus boundary and rule checks.
import fixture from './official-fixture.json' with { type: 'json' };
import freshness from '../src/data/freshness.json' with { type: 'json' };

const BASE = process.env.BASE ?? 'http://127.0.0.1:8799';

// Fail with an instruction rather than an ECONNREFUSED stack. This suite is the
// thing you run after updating statutory data, when what you need is a clear
// answer about whether the figures are right — not a puzzle about your setup.
try {
  const probe = await fetch(BASE + '/', { signal: AbortSignal.timeout(5000) });
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (e) {
  console.error([
    '',
    `  Cannot reach the API at ${BASE} (${e?.message ?? e}).`,
    '',
    '  Start it first:      npx wrangler dev --port 8799',
    '  Or test production:  BASE=https://japan-payroll-api.tsumugi.workers.dev node test/verify.mjs',
    '  (production applies the free-tier rate limit, so a full run may trip it)',
    '',
  ].join('\n'));
  process.exit(1);
}

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json() };
};

let pass = 0, fail = 0;
const failures = [];
// The suite is I/O bound at roughly 90ms per request against a local wrangler,
// so a full run takes minutes. Without a heartbeat it is indistinguishable from
// a hang, which has cost real debugging time — print one line per 250 checks.
const started = Date.now();
const PROGRESS_EVERY = 250;
const ok = (cond, label, detail) => {
  if (cond) pass++;
  else { fail++; if (failures.length < 15) failures.push(`${label} — ${detail ?? ''}`); }
  const n = pass + fail;
  if (n % PROGRESS_EVERY === 0)
    process.stdout.write(
      `  ${String(n).padStart(5)} checks  ${String(fail).padStart(3)} failed  ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s
`);
};
const near = (a, b, tol = 0.51) => Math.abs(a - b) <= tol;

// ---- 1. rates match the official table for every fixture row ----
const rateCache = {};
for (const pref of [...new Set(fixture.map((f) => f.prefecture))]) {
  rateCache[pref] = (await get(`/v1/insurance-rates?prefecture=${pref}`)).body.rates;
}

for (const f of fixture) {
  const R = rateCache[f.prefecture];
  const expHealth = (f.smr * R.health_insurance) / 2;
  ok(near(expHealth, f.health_half, 0.01),
    `health half ${f.prefecture} g${f.health_grade}`, `got ${expHealth} want ${f.health_half}`);

  const expLtc = (f.smr * (R.health_insurance + R.long_term_care)) / 2;
  ok(near(expLtc, f.health_ltc_half, 0.01),
    `health+ltc half ${f.prefecture} g${f.health_grade}`, `got ${expLtc} want ${f.health_ltc_half}`);
}

// ---- 2. grade lookup resolves to the published SMR ----
for (const f of fixture.filter((x) => x.prefecture === 'Tokyo')) {
  const { body } = await get(`/v1/standard-remuneration?remuneration=${f.smr}`);
  ok(body.health.standard_monthly_remuneration === f.smr,
    `grade lookup smr ${f.smr}`, `got ${body.health.standard_monthly_remuneration}`);
  ok(body.health.grade === f.health_grade,
    `grade lookup no ${f.smr}`, `got ${body.health.grade} want ${f.health_grade}`);
}

// ---- 3. pension half matches, incl. the 32-grade clamp ----
for (const f of fixture.filter((x) => x.pension_half !== null)) {
  const R = rateCache[f.prefecture];
  const { body } = await get(`/v1/standard-remuneration?remuneration=${f.smr}`);
  const expPension = (body.pension.standard_monthly_remuneration * R.pension) / 2;
  ok(near(expPension, f.pension_half, 0.01),
    `pension half ${f.prefecture} g${f.health_grade}`, `got ${expPension} want ${f.pension_half}`);
}

// ---- 4. grade boundaries: `to` belongs to the NEXT grade ----
{
  const { body } = await get('/v1/standard-remuneration/table');
  const g = body.grades;
  for (let i = 0; i < g.length - 1; i++) {
    ok(g[i].remuneration_to === g[i + 1].remuneration_from, `boundary contiguity @${i}`);
    const edge = await get(`/v1/standard-remuneration?remuneration=${g[i].remuneration_to}`);
    ok(edge.body.health.grade === g[i + 1].health_grade,
      `boundary belongs upward @${g[i].remuneration_to}`,
      `got ${edge.body.health.grade} want ${g[i + 1].health_grade}`);
  }
  ok(g.length === 50, 'grade count is 50', `got ${g.length}`);
  ok(g.filter((x) => x.pension_grade !== null).length === 32, 'pension grades is 32');
}

// ---- 5. pension clamp above/below the band ----
{
  const hi = await get('/v1/standard-remuneration?remuneration=2000000');
  ok(hi.body.pension.standard_monthly_remuneration === 650000, 'pension clamps high at 650000',
    `got ${hi.body.pension.standard_monthly_remuneration}`);
  ok(hi.body.pension.clamped === true, 'pension clamped flag high');
  const lo = await get('/v1/standard-remuneration?remuneration=50000');
  ok(lo.body.pension.standard_monthly_remuneration === 88000, 'pension clamps low at 88000',
    `got ${lo.body.pension.standard_monthly_remuneration}`);
}

// ---- 6. long-term care applies only to ages 40-64 ----
for (const [age, want] of [[39, false], [40, true], [64, true], [65, false]]) {
  const { body } = await get(`/v1/payroll?prefecture=Tokyo&monthly_salary=350000&age=${age}`);
  ok(body.long_term_care_applicable === want, `ltc at age ${age}`, `got ${body.long_term_care_applicable}`);
  ok(want ? body.deductions.long_term_care.employee > 0 : body.deductions.long_term_care.employee === 0,
    `ltc amount at age ${age}`);
}

// ---- 7. payroll totals are internally consistent ----
{
  const { body } = await get('/v1/payroll?prefecture=Tokyo&monthly_salary=350000&age=40');
  const d = body.deductions;
  const empSum = d.health_insurance.employee + d.long_term_care.employee + d.pension.employee +
    d.child_support.employee + d.employment_insurance.employee;
  ok(near(empSum, body.totals.employee, 0.01), 'employee total = sum of parts',
    `${empSum} vs ${body.totals.employee}`);
  ok(near(body.totals.take_home_before_tax, 350000 - body.totals.employee, 0.01), 'take home math');
  ok(near(body.totals.combined, body.totals.employee + body.totals.employer, 0.01), 'combined total');
  // employment insurance is charged on ACTUAL salary, not the standard remuneration
  ok(near(d.employment_insurance.employee, 350000 * 0.005, 0.51), 'EI on actual salary',
    `got ${d.employment_insurance.employee}`);
  ok(d.child_care_contribution.employee === 0, 'child care contribution is employer-only');
}

// ---- 8. employment insurance business types ----
for (const [t, emp, er] of [['general', 0.005, 0.0085],
                            ['construction', 0.006, 0.0105],
                            ['agriculture_forestry_fishery_sake', 0.006, 0.0095]]) {
  const { body } = await get(`/v1/employment-insurance?business_type=${t}`);
  ok(body.rates.employee === emp && body.rates.employer === er, `EI rates ${t}`,
    `got ${body.rates.employee}/${body.rates.employer}`);
  ok(near(body.rates.total, emp + er, 1e-9), `EI total ${t}`);
}

// ---- 9. minimum wage point-in-time lookups ----
{
  const latest = await get('/v1/minimum-wage?prefecture=Tokyo');
  ok(latest.body.hourly_wage === 1226 && latest.body.fiscal_year === 2025,
    'Tokyo latest minimum wage', JSON.stringify(latest.body.hourly_wage));
  const old = await get('/v1/minimum-wage?prefecture=Tokyo&date=2002-12-01');
  ok(old.body.hourly_wage === 708, 'Tokyo FY2002 minimum wage', `got ${old.body.hourly_wage}`);
  // the day BEFORE an effective date must return the previous rate
  const eff = latest.body.effective_from;
  const dayBefore = new Date(new Date(eff).getTime() - 86400000).toISOString().slice(0, 10);
  const prev = await get(`/v1/minimum-wage?prefecture=Tokyo&date=${dayBefore}`);
  ok(prev.body.hourly_wage < 1226, 'day before effective returns previous rate',
    `got ${prev.body.hourly_wage} on ${dayBefore}`);
  const hist = await get('/v1/minimum-wage/history?prefecture=Tokyo');
  ok(hist.body.count === 24, 'Tokyo history has 24 years', `got ${hist.body.count}`);
  const tooOld = await get('/v1/minimum-wage?prefecture=Tokyo&date=1990-01-01');
  ok(tooOld.status === 404, 'pre-2002 date returns 404', `got ${tooOld.status}`);
}

// ---- 10. prefecture resolution accepts en / ja / ja+suffix / code ----
for (const q of ['Tokyo', 'tokyo', '%E6%9D%B1%E4%BA%AC', '%E6%9D%B1%E4%BA%AC%E9%83%BD', '13']) {
  const { body } = await get(`/v1/insurance-rates?prefecture=${q}`);
  ok(body.prefecture === 'Tokyo', `prefecture resolves "${decodeURIComponent(q)}"`, JSON.stringify(body.prefecture));
}

// ---- 11. error handling ----
for (const [p, want] of [['/v1/insurance-rates', 400], ['/v1/insurance-rates?prefecture=Atlantis', 400],
                         ['/v1/payroll?prefecture=Tokyo', 400],
                         ['/v1/payroll?prefecture=Tokyo&monthly_salary=abc', 400],
                         ['/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=999', 400],
                         ['/v1/employment-insurance?business_type=nope', 400],
                         ['/v1/minimum-wage?prefecture=Tokyo&date=13/05/2020', 400],
                         ['/v1/nope', 404]]) {
  const r = await get(p);
  ok(r.status === want, `error ${want} for ${p}`, `got ${r.status}`);
}

// ---- 12. all 47 prefectures respond ----
{
  const { body } = await get('/v1/prefectures');
  ok(body.count === 47 && body.prefectures.length === 47, 'prefecture list is 47');
  for (const p of body.prefectures) {
    const r = await get(`/v1/payroll?prefecture=${p.name}&monthly_salary=300000&age=45`);
    ok(r.status === 200 && r.body.totals.employee > 0, `payroll works for ${p.name}`, `status ${r.status}`);
  }
}

// ---- 13. holidays: known facts from the Cabinet Office data ----
{
  const y = await get('/v1/holidays?year=2026');
  ok(y.body.count === 18, '2026 has 18 holidays', `got ${y.body.count}`);
  const byDate = Object.fromEntries(y.body.holidays.map((h) => [h.date, h]));
  ok(byDate['2026-01-01']?.name === '元日', '2026-01-01 is 元日');
  // 憲法記念日 falls on a Sunday in 2026, so 5/6 is a substitute holiday
  ok(byDate['2026-05-06']?.substitute === true, '2026-05-06 is a substitute holiday');
  // 国民の休日: sandwiched between 敬老の日 (9/21) and 秋分の日 (9/23)
  ok(byDate['2026-09-22']?.substitute === true, '2026-09-22 is a citizens holiday (sandwich case)');
  ok(!!byDate['2026-09-21'] && !!byDate['2026-09-23'], 'the sandwich case is bounded by two holidays');

  for (const [d, name] of [['1989-02-24', '大喪の礼'], ['1990-11-12', '即位礼正殿の儀'],
                           ['2019-05-01', '休日（祝日扱い）'], ['1959-04-10', '結婚の儀']]) {
    const r = await get(`/v1/holidays/check?date=${d}`);
    ok(r.body.holiday?.name === name, `one-off holiday ${d}`, JSON.stringify(r.body.holiday?.name));
  }
  ok(y.body.holidays.every((h) => h.name_en && h.name_en !== h.name), 'every holiday has an English name');
}

// ---- 14. holidays/check flags ----
{
  const ny = await get('/v1/holidays/check?date=2026-01-01');
  ok(ny.body.is_holiday === true && ny.body.is_business_day === false, 'New Year is not a business day');
  ok(ny.body.weekday === 'Thursday', '2026-01-01 is a Thursday', ny.body.weekday);
  const sat = await get('/v1/holidays/check?date=2026-01-03');
  ok(sat.body.is_weekend === true && sat.body.is_holiday === false, '2026-01-03 is a plain weekend');
  const wd = await get('/v1/holidays/check?date=2026-01-02');
  ok(wd.body.is_business_day === true, '2026-01-02 is a business day');
}

// ---- 15. business-day counts match an independent calculation ----
for (const [from, to, total, business, weekend, holiday] of [
  ['2026-01-01', '2026-01-31', 31, 20, 9, 2],
  ['2026-04-01', '2026-06-30', 91, 61, 26, 5],
  ['2026-01-01', '2026-12-31', 365, 244, 104, 18],
]) {
  const { body } = await get(`/v1/business-days?from=${from}&to=${to}`);
  ok(body.total === total && body.business === business &&
     body.weekend === weekend && body.holiday === holiday,
     `business days ${from}..${to}`,
     `got t=${body.total} b=${body.business} w=${body.weekend} h=${body.holiday}`);
}

// ---- 16. business-day shift ----
{
  const next = await get('/v1/business-days/shift?date=2026-01-01&days=1');
  ok(next.body.result === '2026-01-02', 'next business day after New Year', next.body.result);
  const back = await get('/v1/business-days/shift?date=2026-01-02&days=-1');
  ok(back.body.result === '2025-12-31', 'previous business day before 2026-01-02', back.body.result);
  const zero = await get('/v1/business-days/shift?date=2026-01-05&days=0');
  ok(zero.body.result === '2026-01-05', 'shifting by 0 returns the same date');
  const fwd = await get('/v1/business-days/shift?date=2026-03-02&days=10');
  const rev = await get(`/v1/business-days/shift?date=${fwd.body.result}&days=-10`);
  ok(rev.body.result === '2026-03-02', 'shift is reversible', `${fwd.body.result} -> ${rev.body.result}`);
}

// ---- 17. holiday error handling and coverage bounds ----
for (const [p, want, label] of [
  ['/v1/holidays', 400, 'year is required'],
  ['/v1/holidays?year=1900', 422, 'year before coverage'],
  ['/v1/holidays?year=2999', 422, 'year after coverage'],
  ['/v1/holidays?from=2026-01-01', 400, 'range needs both ends'],
  ['/v1/holidays?from=2026-12-31&to=2026-01-01', 400, 'reversed range'],
  ['/v1/holidays/check', 400, 'date is required'],
  ['/v1/holidays/check?date=2026-02-30', 400, 'rejects 2026-02-30'],
  ['/v1/holidays/check?date=2026-1-1', 400, 'rejects non-padded date'],
  ['/v1/holidays/check?date=1900-01-01', 422, 'date before coverage'],
  ['/v1/business-days?from=2026-01-01', 400, 'business-days needs both ends'],
  ['/v1/business-days/shift?date=2026-01-01&days=abc', 400, 'days must be an integer'],
  ['/v1/business-days/shift?date=2026-01-01&days=99999', 400, 'days is bounded'],
]) {
  const r = await get(p);
  ok(r.status === want, `${label} -> ${want}`, `got ${r.status}`);
}

// ---- 18. consumption tax: every rate change since 1989 ----
{
  const h = await get('/v1/consumption-tax/history');
  ok(h.body.count === 4, 'four consumption tax periods', `got ${h.body.count}`);
  // periods must tile the timeline with no gap and no overlap
  const hist = h.body.history;
  for (let i = 0; i < hist.length - 1; i++) {
    const nextDay = new Date(new Date(hist[i].effective_to + 'T00:00:00Z').getTime() + 86400000)
      .toISOString().slice(0, 10);
    ok(nextDay === hist[i + 1].effective_from, `period ${i} abuts period ${i + 1}`,
       `${hist[i].effective_to} -> ${hist[i + 1].effective_from}`);
  }
  ok(hist[hist.length - 1].effective_to === null, 'the current period is open-ended');

  for (const [date, total, national, local] of [
    ['1990-01-01', 0.03, 0.03, 0],
    ['2000-01-01', 0.05, 0.04, 0.01],
    ['2015-01-01', 0.08, 0.063, 0.017],
    ['2020-01-01', 0.10, 0.078, 0.022],
  ]) {
    const { body } = await get(`/v1/consumption-tax?date=${date}`);
    ok(body.rate === total, `standard rate on ${date} is ${total}`, `got ${body.rate}`);
    ok(near(body.breakdown.national, national, 1e-9) && near(body.breakdown.local, local, 1e-9),
       `national/local split on ${date}`, JSON.stringify(body.breakdown));
    ok(near(body.breakdown.national + body.breakdown.local, body.rate, 1e-9),
       `split sums to the headline rate on ${date}`);
  }

  const current = await get('/v1/consumption-tax');
  ok(current.body.rate === 0.10 && current.body.effective_to === null, 'current standard rate is 10%');
  const red = await get('/v1/consumption-tax?reduced=true');
  ok(red.body.rate === 0.08 && red.body.rate_type === 'reduced', 'current reduced rate is 8%');
}

// ---- 19. consumption tax calculation ----
{
  const a = await get('/v1/consumption-tax?amount=1000');
  ok(a.body.calculation.tax === 100 && a.body.calculation.amount_including_tax === 1100,
     '1000 yen at 10% = 100 tax', JSON.stringify(a.body.calculation));
  const b = await get('/v1/consumption-tax?amount=1000&reduced=true');
  ok(b.body.calculation.tax === 80 && b.body.calculation.amount_including_tax === 1080,
     '1000 yen at reduced 8% = 80 tax', JSON.stringify(b.body.calculation));
  // tax is truncated to the yen, not rounded
  const c2 = await get('/v1/consumption-tax?amount=199');
  ok(c2.body.calculation.tax === 19, '199 yen at 10% truncates to 19', JSON.stringify(c2.body.calculation));
  const d = await get('/v1/consumption-tax?date=2015-01-01&amount=1000');
  ok(d.body.calculation.tax === 80, '1000 yen at the 2015 rate of 8% = 80', JSON.stringify(d.body.calculation));
}

// ---- 20. consumption tax edge cases ----
for (const [p, want, label] of [
  ['/v1/consumption-tax?date=1989-03-31', 422, 'before consumption tax existed'],
  ['/v1/consumption-tax?date=2015-01-01&reduced=true', 422, 'no reduced rate in 2015'],
  ['/v1/consumption-tax?date=not-a-date', 400, 'invalid date'],
  ['/v1/consumption-tax?amount=-5', 400, 'negative amount'],
  ['/v1/consumption-tax?amount=abc', 400, 'non-numeric amount'],
]) {
  const r = await get(p);
  ok(r.status === want, `${label} -> ${want}`, `got ${r.status}`);
}
// the day tax was introduced must resolve
{
  const first = await get('/v1/consumption-tax?date=1989-04-01');
  ok(first.status === 200 && first.body.rate === 0.03, 'introduction day resolves to 3%');
}

// ---- 21. corporate number: the worked example from the NTA PDF ----
{
  const cd = await get('/v1/corporate-number/check-digit?base=700110005901');
  ok(cd.body.check_digit === 8, 'NTA worked example: check digit is 8', `got ${cd.body.check_digit}`);
  ok(cd.body.corporate_number === '8700110005901', 'NTA worked example: full number',
     cd.body.corporate_number);

  const v = await get('/v1/corporate-number/validate?number=8700110005901');
  ok(v.body.valid === true, 'the worked example validates');
  ok(v.body.base_number === '700110005901' && v.body.check_digit === 8, 'validate splits the number');

  // every other check digit must be rejected for the same base
  for (let d = 0; d <= 9; d++) {
    if (d === 8) continue;
    const r = await get(`/v1/corporate-number/validate?number=${d}700110005901`);
    ok(r.body.valid === false, `check digit ${d} is rejected for that base`);
    ok(r.body.expected_check_digit === 8, `rejection reports the expected digit for ${d}`);
  }
}

// ---- 22. corporate number: round-trip property over many bases ----
{
  let roundTrips = 0;
  let digitsSeen = new Set();
  const bases = ['000000000000', '999999999999', '123456789012', '100000000001',
                 '018000000001', '700110005901', '555555555555', '246813579024'];
  for (const base of bases) {
    const cd = await get(`/v1/corporate-number/check-digit?base=${base}`);
    const d = cd.body.check_digit;
    digitsSeen.add(d);
    ok(Number.isInteger(d) && d >= 1 && d <= 9,
       `check digit for ${base} is in 1-9`, `got ${d}`);
    const v = await get(`/v1/corporate-number/validate?number=${cd.body.corporate_number}`);
    if (v.body.valid) roundTrips++;
  }
  ok(roundTrips === bases.length, 'every computed number validates (round-trip)',
     `${roundTrips}/${bases.length}`);
  // 9 - (x mod 9) can never be 0; a leading zero is always invalid
  ok(!digitsSeen.has(0), 'check digit is never 0');
  const zero = await get('/v1/corporate-number/validate?number=0700110005901');
  ok(zero.body.valid === false, 'a number with leading zero is invalid');
}

// ---- 23. corporate number: formatting tolerance and errors ----
{
  const hy = await get('/v1/corporate-number/validate?number=8700-1100-05901');
  ok(hy.body.valid === true, 'hyphens are tolerated');
  const sp = await get('/v1/corporate-number/validate?number=8700%201100%2005901');
  ok(sp.body.valid === true, 'spaces are tolerated');

  for (const [q, label] of [
    ['number=870011000590', 'twelve digits is not a corporate number'],
    ['number=87001100059012', 'fourteen digits is not a corporate number'],
    ['number=87001100059AB', 'letters are rejected'],
  ]) {
    const r = await get(`/v1/corporate-number/validate?${q}`);
    ok(r.status === 200 && r.body.valid === false, label, `status ${r.status} valid ${r.body.valid}`);
  }
  for (const [p, want, label] of [
    ['/v1/corporate-number/validate', 400, 'number is required'],
    ['/v1/corporate-number/check-digit', 400, 'base is required'],
    ['/v1/corporate-number/check-digit?base=12345', 400, 'base must be 12 digits'],
    ['/v1/corporate-number/check-digit?base=70011000590X', 400, 'base must be digits'],
  ]) {
    const r = await get(p);
    ok(r.status === want, `${label} -> ${want}`, `got ${r.status}`);
  }
}

// ---- 24. invoice registration number ----
{
  // Corporations use their 法人番号 directly.
  const corp = await get('/v1/invoice-number/validate?number=T8700110005901');
  ok(corp.body.format_valid === true, 'T + 13 digits is a valid format');
  ok(corp.body.check_digit_valid === true, 'the check digit passes');
  ok(corp.body.could_be_corporate_number === true, 'could be a corporate number');
  // A passing check digit does NOT prove it is a corporation: sole-proprietor
  // numbers satisfy the same rule (614,413 confirmed, zero counterexamples).
  ok(/sole proprietor/i.test(corp.body.reason), 'the response refuses to attribute the holder');
  ok(/614,413/.test(corp.body.reason), 'the empirical basis is stated');

  // A wrong check digit is reported as almost certainly a typo.
  const typo = await get('/v1/invoice-number/validate?number=T1234567890123');
  ok(typo.body.format_valid === true, 'format is still valid');
  ok(typo.body.check_digit_valid === false, 'check digit fails');
  ok(typo.body.expected_check_digit !== typo.body.check_digit, 'expected digit is reported');
  ok(/typo/i.test(typo.body.reason), 'a mismatch is called out as a likely typo');

  // Every other leading digit must fail for the same 12-digit tail.
  let failures = 0;
  for (let d = 0; d <= 9; d++) {
    const r = await get(`/v1/invoice-number/validate?number=T${d}700110005901`);
    if (r.body.check_digit_valid === false) failures++;
  }
  ok(failures === 9, 'exactly one leading digit passes for a given tail', `got ${9 - failures} passing`);

  const lower = await get('/v1/invoice-number/validate?number=t8700-1100-05901');
  ok(lower.body.registration_number === 'T8700110005901', 'lowercase t and hyphens normalise',
     lower.body.registration_number);

  for (const [q, label] of [
    ['number=8700110005901', 'missing the T prefix'],
    ['number=T870011000590', 'twelve digits after T'],
    ['number=T87001100059012', 'fourteen digits after T'],
    ['number=TABCDEFGHIJKLM', 'letters after T'],
  ]) {
    const r = await get(`/v1/invoice-number/validate?${q}`);
    ok(r.status === 200 && r.body.format_valid === false, label,
       `status ${r.status} format_valid ${r.body.format_valid}`);
  }
  const missing = await get('/v1/invoice-number/validate');
  ok(missing.status === 400, 'number is required -> 400', `got ${missing.status}`);
}

// ---- 25. banking calendar (銀行法第15条 / 銀行法施行令第5条) ----
{
  // 12/31-1/3 are ordinary weekdays but banks are closed
  for (const d of ['2026-12-31', '2026-01-02']) {
    const std = await get(`/v1/holidays/check?date=${d}`);
    const bank = await get(`/v1/holidays/check?date=${d}&calendar=bank`);
    ok(std.body.is_business_day === true, `${d} is an ordinary business day`);
    ok(bank.body.is_open === false, `${d} is NOT a banking day`, `got ${bank.body.is_open}`);
    ok(/year-end/.test((bank.body.closed_because ?? []).join(',')),
       `${d} closure reason names the year-end rule`, JSON.stringify(bank.body.closed_because));
  }
  // 1/1 is both a public holiday and inside the closure window
  const ny = await get('/v1/holidays/check?date=2026-01-01&calendar=bank');
  ok(ny.body.is_open === false, 'New Year is not a banking day');
  ok(ny.body.closed_because.length >= 2, 'New Year has both holiday and year-end reasons',
     JSON.stringify(ny.body.closed_because));

  // an ordinary weekday is open on both calendars
  const wd = await get('/v1/holidays/check?date=2026-01-05&calendar=bank');
  ok(wd.body.is_open === true && wd.body.closed_because.length === 0, '2026-01-05 is a banking day');

  // the bank calendar must close strictly more days than the standard one
  const s = await get('/v1/business-days?from=2026-01-01&to=2026-12-31');
  const b = await get('/v1/business-days?from=2026-01-01&to=2026-12-31&calendar=bank');
  ok(b.body.business < s.body.business, 'bank calendar has fewer business days',
     `standard ${s.body.business} vs bank ${b.body.business}`);
  // 2026: 1/1 is a holiday already counted; 1/2, 1/3(Sat), 12/31 are the extra closures.
  // Only 1/2 and 12/31 are weekdays that were previously counted as business days.
  ok(s.body.business - b.body.business === 2,
     'exactly two extra weekdays are closed for banks in 2026',
     `difference ${s.body.business - b.body.business}`);
  ok(b.body.year_end_closure === 2, 'year_end_closure counts the two extra weekdays',
     `got ${b.body.year_end_closure}`);
  ok(s.body.year_end_closure === undefined, 'standard calendar omits the bank-only field');

  // shifting respects the calendar
  const shift = await get('/v1/business-days/shift?date=2026-12-30&days=1&calendar=bank');
  ok(shift.body.result === '2027-01-04', 'next banking day after 2026-12-30 is 2027-01-04',
     shift.body.result);
  const shiftStd = await get('/v1/business-days/shift?date=2026-12-30&days=1');
  ok(shiftStd.body.result === '2026-12-31', 'next ordinary business day is 2026-12-31',
     shiftStd.body.result);

  // statute is cited in the response
  ok(/銀行法/.test(JSON.stringify(bankAttribution(b.body))), 'bank responses cite the statute');
  function bankAttribution(body) { return body.attribution?.bank_calendar ?? {}; }

  const badCal = await get('/v1/business-days?from=2026-01-01&to=2026-01-31&calendar=nope');
  ok(badCal.status === 400, 'unknown calendar -> 400', `got ${badCal.status}`);
}

// ---- 26. data freshness ----
{
  const { body } = await get('/v1/data-freshness');
  // Assert against the source of truth rather than a magic number: a hard count
  // fails on every legitimate addition, which trains you to edit the test instead
  // of reading it. What actually matters is that the report covers what the data
  // file declares, and that nothing is silently dropped on the way out.
  ok(body.counts.total === Object.keys(freshness.datasets).length,
     'the report covers every declared dataset',
     `report ${body.counts.total} vs data ${Object.keys(freshness.datasets).length}`);
  ok(body.datasets.length === body.counts.total, 'and the count matches the list',
     `${body.datasets.length} vs ${body.counts.total}`);
  ok(['current', 'revision_due_soon', 'overdue'].includes(body.overall),
     'overall status is a known value', body.overall);

  const byKey = Object.fromEntries(body.datasets.map((d) => [d.key, d]));
  for (const k of Object.keys(freshness.datasets)) {
    ok(!!byKey[k], `dataset ${k} is tracked`);
    ok(!!byKey[k].source_url, `dataset ${k} cites a source`);
  }

  // Datasets with a known revision date must classify against it, not be silent.
  for (const d of body.datasets) {
    if (d.next_revision_expected === null) {
      ok(d.status === 'not_applicable', `${d.key} with no revision date is not_applicable`, d.status);
    } else {
      ok(d.status !== 'not_applicable', `${d.key} with a revision date is classified`, d.status);
      ok(typeof d.days_until_revision === 'number' || d.status === 'current',
         `${d.key} reports days when it matters`);
    }
  }

  // The minimum wage is the one that actually bites: it changes every October.
  const mw = byKey.minimum_wage;
  ok(mw.next_revision_expected === '2026-10-01', 'minimum wage revision date is October 2026',
     mw.next_revision_expected);
  ok(!!mw.note && /October 2026/.test(mw.note), 'minimum wage carries an explicit warning note');

  // Data responses must surface their own freshness, not only the dedicated endpoint.
  const wage = await get('/v1/minimum-wage?prefecture=Tokyo');
  ok(!!wage.body.freshness, 'minimum wage response carries a freshness marker');
  ok(wage.body.freshness.status === mw.status, 'marker agrees with the freshness report',
     `${wage.body.freshness.status} vs ${mw.status}`);
  const rates = await get('/v1/insurance-rates?prefecture=Tokyo');
  ok(!!rates.body.freshness, 'insurance rates response carries a freshness marker');
  const ei = await get('/v1/employment-insurance');
  ok(!!ei.body.freshness, 'employment insurance response carries a freshness marker');
}

// ---- 27. withholding tax against the official Excel, cell by cell ----
{
  const wh = (await import('./withholding-fixture.json', { with: { type: 'json' } })).default;
  ok(wh.length === 231, 'fixture covers all 231 table rows', `got ${wh.length}`);

  // Sample the midpoint of every bracket: 231 rows x (8 kou columns + otsu).
  let checked = 0, mismatched = 0;
  for (const row of wh) {
    const mid = Math.floor((row.from + row.to) / 2);
    for (let d = 0; d <= 7; d++) {
      const r = await get(`/v1/withholding-tax?taxable_amount=${mid}&column=kou&dependants=${d}`);
      checked++;
      if (r.body.tax !== row.kou[d]) {
        mismatched++;
        if (mismatched <= 3) failures.push(`kou ${mid} dep${d}: got ${r.body.tax} want ${row.kou[d]}`);
      }
    }
    const o = await get(`/v1/withholding-tax?taxable_amount=${mid}&column=otsu`);
    checked++;
    if (o.body.tax !== row.otsu) {
      mismatched++;
      if (mismatched <= 3) failures.push(`otsu ${mid}: got ${o.body.tax} want ${row.otsu}`);
    }
  }
  ok(mismatched === 0, `every published cell matches (${checked} checked)`, `${mismatched} mismatched`);
  pass += checked - 1; // each cell is its own assertion

  // Boundaries: `to` belongs to the next bracket, `from` to this one.
  for (const row of wh.slice(0, 40)) {
    const atFrom = await get(`/v1/withholding-tax?taxable_amount=${row.from}&column=kou&dependants=0`);
    ok(atFrom.body.tax === row.kou[0], `lower bound ${row.from} is inside its bracket`,
       `got ${atFrom.body.tax} want ${row.kou[0]}`);
  }
}

// ---- 28. withholding tax: rules outside the table ----
{
  // Below 105,000: kou is zero, otsu is 3.063% of the amount.
  const lowKou = await get('/v1/withholding-tax?taxable_amount=104999&column=kou');
  ok(lowKou.body.tax === 0, 'below 105,000 the kou column is zero', `got ${lowKou.body.tax}`);
  const lowOtsu = await get('/v1/withholding-tax?taxable_amount=100000&column=otsu');
  ok(lowOtsu.body.tax === Math.floor(100000 * 0.03063), 'below 105,000 otsu is 3.063%',
     `got ${lowOtsu.body.tax} want ${Math.floor(100000 * 0.03063)}`);
  ok(lowOtsu.body.basis.kind === 'below_minimum', 'basis names the below-minimum rule');

  // The statutory rate includes the reconstruction surtax: 3% would give 3,000.
  ok(lowOtsu.body.tax !== 3000, 'otsu uses 3.063%, not the statute-only 3%');

  // 105,000-107,000 otsu is 3,800 in practice and 3,700 in 所得税法別表第二.
  const seam = await get('/v1/withholding-tax?taxable_amount=106000&column=otsu');
  ok(seam.body.tax === 3800, 'otsu at 106,000 is the practical 3,800', `got ${seam.body.tax}`);

  // Anchors above 740,000.
  const anchor = await get('/v1/withholding-tax?taxable_amount=740000&column=kou&dependants=0');
  ok(anchor.body.tax === 71680, 'the 740,000 anchor matches the published value', `got ${anchor.body.tax}`);
  const above = await get('/v1/withholding-tax?taxable_amount=760000&column=kou&dependants=0');
  ok(above.body.tax === Math.floor(71680 + 20000 * 0.2042),
     '740,000-790,000 adds 20.42% of the excess', `got ${above.body.tax}`);
  ok(above.body.basis.kind === 'anchor' && near(above.body.basis.rate, 0.2042, 1e-9),
     'the response explains which anchor and rate were used', JSON.stringify(above.body.basis));
  ok(above.body.basis.anchor === 740000, 'the kou anchor is 740,000', `${above.body.basis.anchor}`);

  // 乙欄のアンカーは 740,000 と 1,710,000 だけ。甲欄のアンカー(790,000等)を
  // 使うと超過額が過小になる — 実際にそのバグを踏んだので固定する。
  const otsuHigh = await get('/v1/withholding-tax?taxable_amount=800000&column=otsu');
  ok(otsuHigh.body.tax === Math.floor(259200 + 60000 * 0.4084),
     'otsu above 740,000 measures the excess from 740,000', `got ${otsuHigh.body.tax}`);
  ok(otsuHigh.body.basis.anchor === 740000, 'otsu does not borrow the kou anchor',
     `anchor ${otsuHigh.body.basis.anchor}`);
  const otsuTop = await get('/v1/withholding-tax?taxable_amount=2000000&column=otsu');
  ok(otsuTop.body.basis.anchor === 1710000, 'otsu switches to the 1,710,000 anchor',
     `anchor ${otsuTop.body.basis.anchor}`);
  ok(otsuTop.body.tax === Math.floor(655400 + 290000 * 0.45945),
     'otsu above 1,710,000 uses 45.945%', `got ${otsuTop.body.tax}`);

  // More than seven dependants: 1,610 yen off per extra person.
  const seven = await get('/v1/withholding-tax?taxable_amount=300000&column=kou&dependants=7');
  const nine = await get('/v1/withholding-tax?taxable_amount=300000&column=kou&dependants=9');
  ok(nine.body.tax === Math.max(0, seven.body.tax - 2 * 1610),
     'two extra dependants deduct 3,220 yen', `${seven.body.tax} -> ${nine.body.tax}`);
  ok(nine.body.dependants_over_seven?.deducted === 3220, 'the deduction is reported');
  const many = await get('/v1/withholding-tax?taxable_amount=110000&column=kou&dependants=50');
  ok(many.body.tax === 0, 'the deduction never drives tax negative', `got ${many.body.tax}`);

  // Tax must not increase as dependants increase.
  let prev = Infinity;
  for (let d = 0; d <= 7; d++) {
    const r = await get(`/v1/withholding-tax?taxable_amount=400000&column=kou&dependants=${d}`);
    ok(r.body.tax <= prev, `tax is non-increasing in dependants at d=${d}`, `${prev} -> ${r.body.tax}`);
    prev = r.body.tax;
  }

  for (const [p, want] of [
    ['/v1/withholding-tax', 400],
    ['/v1/withholding-tax?taxable_amount=-1', 400],
    ['/v1/withholding-tax?taxable_amount=abc', 400],
    ['/v1/withholding-tax?taxable_amount=300000&column=nope', 400],
    ['/v1/withholding-tax?taxable_amount=300000&dependants=-1', 400],
    ['/v1/withholding-tax?taxable_amount=300000&dependants=1.5', 400],
  ]) {
    const r = await get(p);
    ok(r.status === want, `withholding error ${want} for ${p}`, `got ${r.status}`);
  }
}

// ---- 30. payroll runs the whole payslip, so the caller cannot mis-derive the tax base ----
{
  const p = (q) => get(`/v1/payroll?prefecture=Tokyo&monthly_salary=350000&age=40&${q}`);

  const full = (await p('dependants=2')).body;
  ok(!!full.income_tax, 'payroll includes income tax by default');
  ok(full.totals.after_social_insurance === 350000 - full.totals.social_insurance_employee,
     'after_social_insurance is gross minus employee social insurance',
     `${full.totals.after_social_insurance}`);

  // The tax base must be pay AFTER social insurance — using gross is the classic bug.
  const standalone = (await get(
    `/v1/withholding-tax?taxable_amount=${Math.floor(full.totals.after_social_insurance)}&column=kou&dependants=2`)).body;
  ok(full.income_tax.tax === standalone.tax,
     'payroll income tax equals the standalone lookup on the same base',
     `${full.income_tax.tax} vs ${standalone.tax}`);
  const onGross = (await get('/v1/withholding-tax?taxable_amount=350000&column=kou&dependants=2')).body;
  ok(full.income_tax.tax !== onGross.tax,
     'and is NOT what you would get from gross pay', `${full.income_tax.tax} vs ${onGross.tax}`);

  // net_pay must reconcile exactly.
  ok(full.totals.net_pay === full.totals.after_social_insurance - full.totals.income_tax - full.totals.resident_tax,
     'net_pay reconciles', JSON.stringify(full.totals));

  const withResident = (await p('dependants=2&resident_tax=15000')).body;
  ok(withResident.totals.resident_tax === 15000, 'supplied resident tax is carried');
  ok(withResident.totals.net_pay === full.totals.net_pay - 15000,
     'resident tax reduces net pay', `${withResident.totals.net_pay}`);

  const noTax = (await p('income_tax=false')).body;
  ok(noTax.income_tax === undefined, 'income_tax=false omits the block');
  ok(noTax.totals.income_tax === 0 && noTax.totals.net_pay === noTax.totals.after_social_insurance,
     'without income tax, net pay is the after-insurance figure');

  const otsu = (await p('column=otsu')).body;
  ok(otsu.income_tax.column === 'otsu', 'the 乙 column is honoured');
  ok(otsu.income_tax.tax > full.income_tax.tax, '乙 withholds more than 甲 with dependants',
     `${otsu.income_tax.tax} vs ${full.income_tax.tax}`);

  // Old field names must keep working for anyone already integrated.
  ok(noTax.totals.employee === noTax.totals.social_insurance_employee, 'legacy totals.employee kept');
  ok(noTax.totals.take_home_before_tax === noTax.totals.after_social_insurance,
     'legacy totals.take_home_before_tax kept');

  for (const [q, want] of [
    ['income_tax=maybe', 400], ['column=hei', 400], ['dependants=-1', 400], ['resident_tax=-5', 400],
  ]) {
    const r = await p(q);
    ok(r.status === want, `payroll rejects ${q}`, `got ${r.status}`);
  }
}

// ---- 31. errors are machine-readable, enums are readable ahead of time ----
{
  for (const [p, code] of [
    ['/v1/insurance-rates', 'missing_parameter'],
    ['/v1/insurance-rates?prefecture=Atlantis', 'unknown_prefecture'],
    ['/v1/holidays?year=1900', 'out_of_coverage'],
    ['/v1/holidays/check?date=1900-01-01', 'out_of_coverage'],
    ['/v1/consumption-tax?date=1989-03-31', 'out_of_coverage'],
    ['/v1/minimum-wage?prefecture=Tokyo&date=1990-01-01', 'out_of_coverage'],
    ['/v1/employment-insurance?business_type=nope', 'invalid_request'],
    ['/v1/nope', 'not_found'],
  ]) {
    const r = await get(p);
    ok(r.body.code === code, `${p} reports code "${code}"`, `got "${r.body.code}"`);
  }

  const { body } = await get('/v1/enums');
  ok(body.business_type.length === 3, 'enums list all business types', `${body.business_type.length}`);
  ok(body.column.length === 2 && body.calendar.length === 2, 'enums list column and calendar values');
  ok(body.error_codes.length >= 6, 'enums document the error codes');
  // Every documented enum value must actually be accepted.
  for (const b of body.business_type) {
    const r = await get(`/v1/employment-insurance?business_type=${b.value}`);
    ok(r.status === 200, `documented business_type "${b.value}" is accepted`, `got ${r.status}`);
  }
  for (const cal of body.calendar) {
    const r = await get(`/v1/business-days?from=2026-01-01&to=2026-01-31&calendar=${cal.value}`);
    ok(r.status === 200, `documented calendar "${cal.value}" is accepted`, `got ${r.status}`);
  }
  for (const col of body.column) {
    const r = await get(`/v1/withholding-tax?taxable_amount=300000&column=${col.value}`);
    ok(r.status === 200, `documented column "${col.value}" is accepted`, `got ${r.status}`);
  }
}

// ---- 32. batch payroll ----
{
  const post = async (body) => {
    const r = await fetch(BASE + '/v1/payroll/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  const defaults = { prefecture: 'Tokyo', business_type: 'general', column: 'kou' };
  const employees = [
    { id: 'a', monthly_salary: 350000, age: 40, dependants: 2 },
    { id: 'b', monthly_salary: 280000, age: 28 },
    { id: 'c', monthly_salary: 520000, age: 45, dependants: 3, prefecture: 'Osaka' },
    { id: 'd', monthly_salary: 190000, age: 22, column: 'otsu' },
  ];
  const { status, body } = await post({ defaults, employees });
  ok(status === 200, 'batch returns 200', `got ${status}`);
  ok(body.succeeded === 4 && body.failed === 0, 'all four rows succeed',
     `${body.succeeded}/${body.failed}`);

  // Batch must agree exactly with the single-employee endpoint — same code path.
  for (const row of employees) {
    const q = new URLSearchParams({
      prefecture: row.prefecture ?? defaults.prefecture,
      monthly_salary: String(row.monthly_salary),
      business_type: defaults.business_type,
      column: row.column ?? defaults.column,
      dependants: String(row.dependants ?? 0),
    });
    if (row.age !== undefined) q.set('age', String(row.age));
    const single = (await get(`/v1/payroll?${q}`)).body;
    const batched = body.results.find((r) => r.id === row.id);
    ok(batched.totals.net_pay === single.totals.net_pay,
       `batch matches single for ${row.id} (net pay)`,
       `${batched.totals.net_pay} vs ${single.totals.net_pay}`);
    ok(batched.totals.income_tax === single.totals.income_tax,
       `batch matches single for ${row.id} (income tax)`,
       `${batched.totals.income_tax} vs ${single.totals.income_tax}`);
    ok(batched.totals.social_insurance_employee === single.totals.social_insurance_employee,
       `batch matches single for ${row.id} (social insurance)`);
  }

  // Row-level defaults must be overridable.
  const osaka = body.results.find((r) => r.id === 'c');
  ok(osaka.input.prefecture === 'Osaka', 'a row overrides the default prefecture');
  const otsu = body.results.find((r) => r.id === 'd');
  ok(otsu.input.column === 'otsu', 'a row overrides the default column');

  // Summary must equal the sum of the rows.
  const sum = (f) => Math.round(body.results.reduce((a, r) => a + f(r), 0) * 100) / 100;
  ok(body.summary.gross === sum((r) => r.totals.gross), 'summary gross reconciles');
  ok(body.summary.net_pay === sum((r) => r.totals.net_pay), 'summary net pay reconciles');
  ok(body.summary.income_tax === sum((r) => r.totals.income_tax), 'summary income tax reconciles');
  ok(body.summary.social_insurance.employer === sum((r) => r.totals.social_insurance_employer),
     'summary employer share reconciles');
  ok(body.summary.employer_cost ===
     Math.round(sum((r) => r.totals.gross + r.totals.social_insurance_employer) * 100) / 100,
     'employer_cost is gross plus the employer share', `${body.summary.employer_cost}`);
  ok(body.summary.employees === 4, 'summary counts only successful rows');

  // A bad row is reported and skipped, not fatal to the run.
  const mixed = await post({
    defaults,
    employees: [
      { id: 'ok', monthly_salary: 300000, age: 30 },
      { id: 'neg', monthly_salary: -5 },
      { id: 'nowhere', monthly_salary: 300000, prefecture: 'Atlantis' },
      { id: 'nosalary' },
      { id: 'baddep', monthly_salary: 300000, dependants: 1.5 },
    ],
  });
  ok(mixed.status === 200, 'a partial failure is still a 200', `got ${mixed.status}`);
  ok(mixed.body.succeeded === 1 && mixed.body.failed === 4, 'one row survives',
     `${mixed.body.succeeded}/${mixed.body.failed}`);
  const codes = mixed.body.errors.map((e) => e.code);
  ok(codes.includes('unknown_prefecture'), 'the bad prefecture is named');
  ok(codes.filter((x) => x === 'invalid_request').length === 3, 'the other three are invalid_request',
     JSON.stringify(codes));
  ok(mixed.body.errors.every((e) => Number.isInteger(e.index)), 'errors carry the input index');
  ok(mixed.body.errors.find((e) => e.id === 'nowhere').index === 2, 'the index points at the right row');
  ok(mixed.body.summary.employees === 1, 'the summary ignores failed rows');

  // Rows without ids still work and are locatable by index.
  const anon = await post({ defaults, employees: [{ monthly_salary: 300000, age: 30 }] });
  ok(anon.body.succeeded === 1 && anon.body.results[0].index === 0,
     'a row without an id is still returned with its index');

  // Guardrails.
  const tooMany = await post({ defaults, employees: Array.from({ length: 501 }, () => ({ monthly_salary: 300000 })) });
  ok(tooMany.status === 400 && tooMany.body.code === 'batch_too_large',
     'over 500 employees is rejected with its own code', `${tooMany.status} ${tooMany.body.code}`);
  const atLimit = await post({ defaults, employees: Array.from({ length: 500 }, () => ({ monthly_salary: 300000 })) });
  ok(atLimit.status === 200 && atLimit.body.succeeded === 500, 'exactly 500 is accepted',
     `${atLimit.status} ${atLimit.body.succeeded}`);

  for (const [payload, label] of [
    [{ defaults, employees: [] }, 'empty employees'],
    [{ defaults, employees: {} }, 'employees is not an array'],
    [{ defaults: [], employees: [{ monthly_salary: 1 }] }, 'defaults is an array'],
    [{ employees: ['nope'] }, 'an element is not an object'],
    ['not json', 'body is not JSON'],
  ]) {
    const r = await post(payload);
    ok(r.status === 400, `batch rejects ${label}`, `got ${r.status}`);
  }
}

// ---- 33. batch detail modes ----
{
  const post = async (q, body) => {
    const r = await fetch(`${BASE}/v1/payroll/batch${q}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const payload = {
    defaults: { prefecture: 'Tokyo' },
    employees: [
      { id: 'x', monthly_salary: 350000, age: 40, dependants: 2 },
      { id: 'y', monthly_salary: 280000, age: 30 },
    ],
  };

  const full = await post('', payload);
  const compact = await post('?detail=compact', payload);
  ok(full.body.detail === 'full' && compact.body.detail === 'compact', 'detail is echoed back');

  // Compact must carry the payout figures and drop the breakdown.
  const cx = compact.body.results.find((r) => r.id === 'x');
  const fx = full.body.results.find((r) => r.id === 'x');
  ok(cx.net_pay === fx.totals.net_pay, 'compact net pay matches full', `${cx.net_pay} vs ${fx.totals.net_pay}`);
  ok(cx.income_tax === fx.totals.income_tax, 'compact income tax matches full');
  ok(cx.social_insurance_employer === fx.totals.social_insurance_employer,
     'compact keeps the employer share (needed to reconcile the run)');
  ok(cx.deductions === undefined && cx.standard_remuneration === undefined,
     'compact drops the per-premium breakdown');
  ok(cx.index === fx.index && cx.prefecture === 'Tokyo', 'compact keeps index and prefecture');

  // Summaries must be identical regardless of detail.
  ok(JSON.stringify(compact.body.summary) === JSON.stringify(full.body.summary),
     'the summary is the same in both modes');

  const badDetail = await post('?detail=medium', payload);
  ok(badDetail.status === 400, 'unknown detail is rejected', `got ${badDetail.status}`);
}

// ---- 34. bonus withholding ----
{
  const b = (q) => get(`/v1/bonus-tax?${q}`);

  // Rate comes from LAST month's pay after insurance, applied to the bonus.
  const r = (await b('bonus=700000&previous_month_pay=350000&previous_month_insurance=55750&dependants=2')).body;
  ok(r.applicable === true, 'the ordinary case uses the table');
  ok(r.previous_month_after_insurance === 294250, 'the lookup key is last month after insurance',
     `${r.previous_month_after_insurance}`);
  ok(r.rate_band.from <= 294250 && r.rate_band.to > 294250, 'the band contains the lookup key',
     JSON.stringify(r.rate_band));
  ok(r.tax === Math.floor(700000 * r.rate), 'tax is bonus x rate, truncated',
     `${r.tax} vs ${Math.floor(700000 * r.rate)}`);

  // The bonus's own social insurance comes off before the rate is applied.
  const withIns = (await b('bonus=700000&bonus_insurance=100000&previous_month_pay=350000&previous_month_insurance=55750&dependants=2')).body;
  ok(withIns.bonus_after_insurance === 600000, 'bonus insurance is deducted first');
  ok(withIns.tax === Math.floor(600000 * withIns.rate), 'tax uses the after-insurance bonus');
  ok(withIns.rate === r.rate, 'the rate is unchanged by the bonus insurance');

  // More dependants means a lower rate at the same previous pay.
  let prevRate = Infinity;
  for (let d = 0; d <= 7; d++) {
    const x = (await b(`bonus=500000&previous_month_pay=400000&previous_month_insurance=60000&dependants=${d}`)).body;
    ok(x.rate <= prevRate, `bonus rate is non-increasing in dependants at d=${d}`, `${prevRate} -> ${x.rate}`);
    prevRate = x.rate;
  }
  const otsu = (await b('bonus=500000&previous_month_pay=400000&previous_month_insurance=60000&column=otsu')).body;
  ok(otsu.dependants === null, '乙 ignores dependants');
  ok(otsu.rate > 0, '乙 has a rate');

  // The three cases where the table must NOT be used.
  const noPrev = (await b('bonus=500000&previous_month_pay=0')).body;
  ok(noPrev.applicable === false && noPrev.reason_code === 'no_previous_month_pay',
     'no pay last month falls outside the table', noPrev.reason_code);
  const swallowed = (await b('bonus=500000&previous_month_pay=50000&previous_month_insurance=50000')).body;
  ok(swallowed.applicable === false && swallowed.reason_code === 'previous_pay_at_or_below_insurance',
     'pay at or below insurance falls outside the table', swallowed.reason_code);
  const huge = (await b('bonus=5000000&previous_month_pay=350000&previous_month_insurance=55750')).body;
  ok(huge.applicable === false && huge.reason_code === 'bonus_exceeds_ten_times',
     'a bonus over ten times last month falls outside the table', huge.reason_code);
  ok(huge.ten_times_limit === 294250 * 10, 'the ten-times limit is reported', `${huge.ten_times_limit}`);
  ok(!!huge.instead, 'the response says what to use instead');

  // Exactly ten times is still inside the table; a yen more is not.
  const atLimit = (await b('bonus=2942500&previous_month_pay=350000&previous_month_insurance=55750')).body;
  ok(atLimit.applicable === true, 'exactly ten times is still in the table');
  const overLimit = (await b('bonus=2942501&previous_month_pay=350000&previous_month_insurance=55750')).body;
  ok(overLimit.applicable === false, 'one yen over ten times is out');

  for (const [q, want] of [
    ['bonus=500000', 400], ['previous_month_pay=350000', 400],
    ['bonus=-1&previous_month_pay=350000', 400],
    ['bonus=500000&previous_month_pay=350000&column=hei', 400],
    ['bonus=500000&previous_month_pay=350000&dependants=-1', 400],
  ]) {
    const x = await b(q);
    ok(x.status === want, `bonus rejects "${q}"`, `got ${x.status}`);
  }
}

// ---- 35. age milestones: reached the day BEFORE the birthday ----
{
  const a = (q) => get(`/v1/age-milestones?${q}`);

  // Born on the 1st: the milestone lands in the previous month.
  const first = (await a('birth_date=1986-04-01&as_of=2026-03-15')).body;
  const second = (await a('birth_date=1986-04-02&as_of=2026-03-15')).body;
  const m40 = (b) => b.milestones.find((m) => m.age === 40);
  ok(m40(first).reached_on === '2026-03-31', 'born 04-01 reaches 40 on 03-31', m40(first).reached_on);
  ok(m40(second).reached_on === '2026-04-01', 'born 04-02 reaches 40 on 04-01', m40(second).reached_on);
  ok(first.long_term_care === true && second.long_term_care === false,
     'one day of birth date shifts the LTC start by a month',
     `${first.long_term_care} vs ${second.long_term_care}`);
  ok(first.notes.some((n) => /Born on the 1st/.test(n)), 'the 1st-of-month case is called out');

  // 29 February births resolve in non-leap years.
  const leap = (await a('birth_date=2000-02-29&as_of=2040-03-01')).body;
  ok(leap.milestones.find((m) => m.age === 40).reached_on === '2040-02-28',
     'a 29 Feb birth reaches 40 on 28 Feb in a non-leap year',
     leap.milestones.find((m) => m.age === 40).reached_on);

  // The four milestones and what they switch off.
  for (const [birth, ltc, pension, health, label] of [
    ['1996-06-15', false, true, true, 'under 40'],
    ['1980-06-15', true, true, true, '40-64'],
    ['1956-06-15', false, false, true, 'past 70'],
    ['1951-06-15', false, false, false, 'past 75'],
  ]) {
    const r = (await a(`birth_date=${birth}&as_of=2026-08-25`)).body;
    ok(r.long_term_care === ltc && r.pension === pension && r.health_insurance === health,
       `coverage for ${label}`,
       `ltc=${r.long_term_care} pension=${r.pension} health=${r.health_insurance}`);
  }
  // 65 removes LTC from payroll but keeps pension and health.
  const at65 = (await a('birth_date=1961-06-15&as_of=2026-08-25')).body;
  ok(at65.long_term_care === false && at65.pension === true && at65.health_insurance === true,
     'at 65 only long-term care leaves the payslip');
  ok(at65.notes.some((n) => /municipality/.test(n)), 'the 65 case explains where LTC goes instead');

  ok((await a('birth_date=nope')).status === 400, 'a bad birth date is rejected');
  ok((await a('')).status === 400, 'birth_date is required');
}

// ---- 36. payroll honours the milestones ----
{
  const p = (q) => get(`/v1/payroll?prefecture=Tokyo&monthly_salary=350000&${q}`);
  const under = (await p('birth_date=1996-06-15&as_of=2026-08-25')).body;
  const mid = (await p('birth_date=1980-06-15&as_of=2026-08-25')).body;
  const past70 = (await p('birth_date=1956-06-15&as_of=2026-08-25')).body;
  const past75 = (await p('birth_date=1951-06-15&as_of=2026-08-25')).body;

  ok(under.deductions.long_term_care.employee === 0, 'under 40 pays no long-term care');
  ok(mid.deductions.long_term_care.employee > 0, '40-64 pays long-term care');
  ok(past70.deductions.pension.employee === 0, 'past 70 pays no pension');
  ok(past70.deductions.health_insurance.employee > 0, 'past 70 still pays health insurance');
  ok(past75.deductions.health_insurance.employee === 0, 'past 75 pays no health insurance');
  ok(past75.deductions.employment_insurance.employee > 0, 'employment insurance continues past 75');
  ok(past75.totals.net_pay > past70.totals.net_pay, 'fewer premiums means more net pay',
     `${past75.totals.net_pay} vs ${past70.totals.net_pay}`);

  ok(!!mid.age_status && mid.coverage.health_insurance === true, 'age_status and coverage are reported');
  const noBirth = (await p('age=40')).body;
  ok(noBirth.age_status === undefined, 'without a birth date there is no age_status');
  ok(/birth_date/.test(noBirth.coverage.basis), 'and the response says what is missing');
  ok(noBirth.deductions.long_term_care.employee > 0, 'age alone still drives the 40-64 band');

  ok((await p('birth_date=1980-13-01')).status === 400, 'an impossible birth date is rejected');
  ok((await p('birth_date=1980-06-15&as_of=nope')).status === 400, 'a bad as_of is rejected');
}

// ---- 37. joining and leaving months ----
{
  const e = (q) => get(`/v1/eligibility?${q}`);

  // 月末退職: one day changes whether the month is payable.
  const day30 = (await e('month=2026-03&left_on=2026-03-30')).body;
  const day31 = (await e('month=2026-03&left_on=2026-03-31')).body;
  ok(day30.eligibility_lost_on === '2026-03-31', 'leaving on the 30th loses eligibility on the 31st');
  ok(day31.eligibility_lost_on === '2026-04-01', 'leaving on the 31st loses eligibility on 1 April');
  ok(day30.social_insurance_due === false, 'no March premium when leaving on the 30th');
  ok(day31.social_insurance_due === true, 'March premium is due when leaving on the 31st');

  // February, where the last day is not the 31st.
  const feb27 = (await e('month=2026-02&left_on=2026-02-27')).body;
  const feb28 = (await e('month=2026-02&left_on=2026-02-28')).body;
  ok(feb27.social_insurance_due === false && feb28.social_insurance_due === true,
     'the same rule holds in February', `${feb27.social_insurance_due}/${feb28.social_insurance_due}`);

  // Joining: the whole month is payable no matter which day.
  for (const d of ['2026-03-01', '2026-03-15', '2026-03-31']) {
    const r = (await e(`month=2026-03&joined_on=${d}`)).body;
    ok(r.social_insurance_due === true, `joining on ${d} makes March payable`);
  }
  const before = (await e('month=2026-02&joined_on=2026-03-15')).body;
  ok(before.social_insurance_due === false, 'a month before joining is not payable');
  const after = (await e('month=2026-05&left_on=2026-03-31')).body;
  ok(after.social_insurance_due === false, 'a month after leaving is not payable');

  // Employment insurance follows wages, so the final month still counts.
  ok(day30.employment_insurance_due === true,
     'employment insurance still applies in the final month worked');

  ok((await e('month=2026-03&left_on=2026-03-15&joined_on=2026-03-20')).status === 400,
     'leaving before joining is rejected');
  ok((await e('month=nope')).status === 400, 'a bad month is rejected');
}

// ---- 38. daily withholding table, including the 丙 column ----
{
  const d = (q) => get(`/v1/withholding-tax/daily?${q}`);

  // 甲 falls with dependants; 乙 is much higher; 丙 is its own thing.
  const kou = (await d('taxable_amount=12000&column=kou&dependants=1')).body;
  const otsu = (await d('taxable_amount=12000&column=otsu')).body;
  const hei = (await d('taxable_amount=12000&column=hei')).body;
  ok(otsu.tax > kou.tax, '乙 withholds more than 甲', `${otsu.tax} vs ${kou.tax}`);
  ok(hei.tax > 0 && hei.tax < kou.tax, '丙 is its own column, lower than 甲 here',
     `hei ${hei.tax} kou ${kou.tax}`);
  ok(hei.dependants === null, '丙 does not take dependants');

  // Below the table floor nothing is withheld on 甲.
  const low = (await d('taxable_amount=3499&column=kou')).body;
  ok(low.tax === 0 && low.basis.kind === 'below_minimum', 'below the floor 甲 is zero');

  // 甲 is non-increasing in dependants.
  let prev = Infinity;
  for (let n = 0; n <= 7; n++) {
    const r = (await d(`taxable_amount=15000&column=kou&dependants=${n}`)).body;
    ok(r.tax <= prev, `daily 甲 non-increasing at d=${n}`, `${prev} -> ${r.tax}`);
    prev = r.tax;
  }
  // Beyond seven it is 50 yen each, not the monthly table's 1,610.
  const seven = (await d('taxable_amount=15000&column=kou&dependants=7')).body;
  const nine = (await d('taxable_amount=15000&column=kou&dependants=9')).body;
  ok(nine.tax === Math.max(0, seven.tax - 2 * 50), 'daily deducts 50 yen per extra dependant',
     `${seven.tax} -> ${nine.tax}`);
  ok(nine.dependants_over_seven?.deduction_per_person === 50, 'the daily rate is reported as 50');

  // Above the table each column measures its excess from its own anchor.
  const hiKou = (await d('taxable_amount=25000&column=kou&dependants=0')).body;
  ok(hiKou.basis.kind === 'anchor' && hiKou.basis.anchor === 24000,
     '甲 uses the 24,000 anchor', JSON.stringify(hiKou.basis));
  const hiHei = (await d('taxable_amount=30000&column=hei')).body;
  ok(hiHei.basis.kind === 'anchor' && hiHei.basis.anchor === 26500,
     '丙 has its own anchor at 26,500, not 甲’s', JSON.stringify(hiHei.basis));
  ok(hiHei.tax === Math.floor(1001 + (30000 - 26500) * 0.2042),
     '丙 above 26,500 adds 20.42% of the excess', `${hiHei.tax}`);

  for (const [q, want] of [
    ['', 400], ['taxable_amount=-1', 400], ['taxable_amount=12000&column=tei', 400],
    ['taxable_amount=12000&dependants=1.5', 400],
  ]) {
    const r = await d(q);
    ok(r.status === want, `daily rejects "${q}"`, `got ${r.status}`);
  }
}

// ---- 39. social insurance on a bonus, with both caps ----
{
  const b = (q) => get(`/v1/bonus-insurance?prefecture=Tokyo&${q}`);

  // 標準賞与額 truncates to the thousand.
  const odd = (await b('bonus=800999&age=40')).body;
  ok(odd.standard_bonus === 800000, 'the base truncates to the thousand yen', `${odd.standard_bonus}`);

  // Under both caps nothing is clipped.
  const plain = (await b('bonus=800000&age=40')).body;
  ok(plain.bases.health === 800000 && plain.bases.pension === 800000, 'under the caps nothing is clipped');
  ok(plain.bases.health_capped === false && plain.bases.pension_capped === false, 'no cap flags');
  ok(plain.deductions.long_term_care.employee > 0, 'a 40-year-old pays long-term care on a bonus');

  // The pension cap is per payment.
  const big = (await b('bonus=2000000&age=40')).body;
  ok(big.bases.pension === 1500000 && big.bases.pension_capped === true,
     'pension is capped at 1,500,000 per payment', `${big.bases.pension}`);
  ok(big.bases.health === 2000000, 'the health base is not capped per payment');

  // The health cap is annual and depends on what has already been paid.
  const nearLimit = (await b('bonus=800000&age=40&fiscal_year_to_date=5500000')).body;
  ok(nearLimit.bases.health === 230000 && nearLimit.bases.health_capped === true,
     'only the annual headroom is chargeable', `${nearLimit.bases.health}`);
  ok(nearLimit.caps.health_annual_remaining_after === 0, 'the remaining headroom is reported');
  const exhausted = (await b('bonus=800000&age=40&fiscal_year_to_date=5730000')).body;
  ok(exhausted.bases.health === 0 && exhausted.deductions.health_insurance.employee === 0,
     'once the annual cap is used up no health premium is due');
  ok(exhausted.deductions.pension.employee > 0, 'pension is unaffected by the health cap');

  // Age milestones apply to bonuses too.
  const past70 = (await b('bonus=800000&birth_date=1956-06-15&as_of=2026-08-25')).body;
  ok(past70.deductions.pension.employee === 0, 'past 70 pays no pension on a bonus');
  ok(past70.deductions.health_insurance.employee > 0, 'past 70 still pays health on a bonus');
  const past75 = (await b('bonus=800000&birth_date=1951-06-15&as_of=2026-08-25')).body;
  ok(past75.totals.employee === 0, 'past 75 pays no social insurance on a bonus',
     `${past75.totals.employee}`);

  // Employee and employer shares must reconcile.
  ok(plain.totals.combined === Math.round((plain.totals.employee + plain.totals.employer) * 100) / 100,
     'bonus insurance totals reconcile');

  for (const [q, want] of [
    ['', 400], ['bonus=-1', 400], ['bonus=800000&fiscal_year_to_date=-1', 400],
    ['bonus=800000&birth_date=nope', 400],
  ]) {
    const r = await b(q);
    ok(r.status === want, `bonus insurance rejects "${q}"`, `got ${r.status}`);
  }
}


// ---- 40. 標準報酬月額の改定 — 随時改定, 定時決定, 休業終了時改定, 年間平均 ----
{
  const rev = (q) => get(`/v1/standard-remuneration/revision?${q}`);
  const reg = (q) => get(`/v1/standard-remuneration/regular?${q}`);
  const le = (q) => get(`/v1/standard-remuneration/leave-end?${q}`);
  const M = (a, d = 31) => `${a}:${d}`;
  const three = (a, b, c, d = 31) => `${M(a, d)},${M(b, d)},${M(c, d)}`;

  // --- The eight single-grade cases 日本年金機構 publishes verbatim. Each must
  // come out eligible at exactly one real grade of movement, landing on the
  // standard remuneration the table names. 保発第4号 記2(1) イ〜オ.
  const boundary = [
    // scheme, current 報酬月額, 3-month average, direction, new grade, new SMR, tag
    ['health', 1_300_000, 1_420_000, 'increase', 50, 1_390_000, 'イ'],
    ['health', 50_000, 65_000, 'increase', 2, 68_000, 'ウ'],
    ['health', 1_420_000, 1_340_000, 'decrease', 49, 1_330_000, 'エ'],
    ['health', 70_000, 52_000, 'decrease', 1, 58_000, 'オ'],
    ['pension', 620_000, 670_000, 'increase', 32, 650_000, 'イ'],
    ['pension', 80_000, 95_000, 'increase', 2, 98_000, 'ウ'],
    ['pension', 670_000, 630_000, 'decrease', 31, 620_000, 'エ'],
    ['pension', 98_000, 80_000, 'decrease', 1, 88_000, 'オ'],
  ];
  for (const [scheme, cur, avgPay, dir, grade, smr, tag] of boundary) {
    const { body } = await rev(
      `current_remuneration=${cur}&months=${three(avgPay, avgPay, avgPay)}&fixed_pay_change=${dir}`);
    const s = body.schemes[scheme];
    ok(s.applies, `boundary ${tag} ${scheme} ${cur}->${avgPay} applies`,
       JSON.stringify(body.blocking_reasons));
    ok(s.real_grade_gap === 1, `boundary ${tag} ${scheme} is a one-grade move`,
       `gap ${s.real_grade_gap}`);
    ok(s.extended_grade_gap === 2, `boundary ${tag} ${scheme} extended gap is 2`,
       `gap ${s.extended_grade_gap}`);
    ok(s.new_grade === grade, `boundary ${tag} ${scheme} new grade`,
       `got ${s.new_grade} want ${grade}`);
    ok(s.new_standard_remuneration === smr, `boundary ${tag} ${scheme} new SMR`,
       `got ${s.new_standard_remuneration} want ${smr}`);
    ok(typeof s.boundary_exception === 'string' && s.boundary_exception.startsWith(tag),
       `boundary ${tag} ${scheme} names the notice clause`, `${s.boundary_exception}`);
  }

  // The pension table stops at 650,000 while health runs to 1,390,000, so a raise
  // well above the pension ceiling moves the health grade six places and the
  // pension grade not at all. If a rewrite ever collapses the two schemes into a
  // single judgement, this is the case that breaks — and it is the common one,
  // because it covers every well-paid employee.
  {
    const { body } = await rev(
      `current_remuneration=700000&months=${three(1000000, 1000000, 1000000)}&fixed_pay_change=increase`);
    ok(body.schemes.health.applies, 'scheme independence: health revises',
       JSON.stringify(body.blocking_reasons));
    ok(body.schemes.health.new_grade === 43, 'health lands on grade 43',
       `${body.schemes.health.new_grade}`);
    ok(!body.schemes.pension.applies, 'scheme independence: pension does not move',
       `pension gap ${body.schemes.pension.extended_grade_gap}`);
    ok(body.schemes.pension.extended_grade_gap === 0,
       'because both figures sit above the pension ceiling');
    ok(body.applies, 'a revision on either scheme means a filing is due');
  }

  // One grade short of the boundary rule is not enough. 健保第50級 has no grade
  // above it, so a rise from 1,360,000 (already 50級) can never qualify.
  {
    const { body } = await rev(
      `current_remuneration=1360000&months=${three(1420000, 1420000, 1420000)}&fixed_pay_change=increase`);
    ok(!body.schemes.health.applies, 'already at the top grade: no revision',
       JSON.stringify(body.schemes.health));
    ok(!body.applies && body.blocking_reasons.length > 0, 'and the response says why');
  }

  // 保発第4号 記2(2) and 日本年金機構's own exclusions.
  {
    const none = await rev(`current_remuneration=300000&months=${three(400000, 400000, 400000)}&fixed_pay_change=none`);
    ok(!none.body.applies, 'overtime alone is not a revision');
    ok(none.body.blocking_reasons.some((r) => r.includes('固定的賃金')),
       'and it cites the fixed-pay requirement');

    // Fixed pay up, average down: excluded even at a large gap.
    const flip = await rev(`current_remuneration=500000&months=${three(300000, 300000, 300000)}&fixed_pay_change=increase`);
    ok(!flip.body.applies, 'fixed pay up but average down is not a revision');
    ok(flip.body.schemes.health.extended_grade_gap >= 2, 'even though the gap is wide',
       `${flip.body.schemes.health.extended_grade_gap}`);
    ok(!flip.body.schemes.health.direction_consistent, 'direction flag reports it');
  }

  // 支払基礎日数: all three months must qualify, and the 15-day relaxation is
  // 定時決定-only (平成18年 庁保険発第0512001号 記2(2)).
  {
    const short = await rev(
      `current_remuneration=300000&months=${M(400000, 31)},${M(400000, 16)},${M(400000, 31)}&fixed_pay_change=increase`);
    ok(!short.body.applies, '16 days in one month blocks a revision');

    const pt = await rev(
      `current_remuneration=300000&months=${M(400000, 16)},${M(400000, 16)},${M(400000, 16)}` +
      `&fixed_pay_change=increase&worker_type=part_time_short_hours`);
    ok(!pt.body.applies, '短時間就労者 still needs 17 days for a revision');
    ok(pt.body.payment_basis_threshold === 17, '短時間就労者 threshold stays 17');
    ok(pt.body.blocking_reasons.some((r) => r.includes('15日')),
       'and the response explains the 15-day rule does not reach here');

    const sti = await rev(
      `current_remuneration=300000&months=${M(400000, 12)},${M(400000, 12)},${M(400000, 12)}` +
      `&fixed_pay_change=increase&worker_type=short_time_insured`);
    ok(sti.body.payment_basis_threshold === 11, '特定適用事業所の短時間労働者 uses 11 days');
    ok(sti.body.applies, 'and 12 days qualifies for them');
  }

  // --- 定時決定 ---
  {
    const plain = (await reg(`months=${three(300000, 302000, 298000, 30)}`)).body;
    ok(plain.decided && plain.months_used === 3, '定時決定 uses all three qualifying months');
    ok(plain.average_remuneration === 300000, '定時決定 average',
       `${plain.average_remuneration}`);
    ok(!plain.insurer_determination, 'an ordinary 定時決定 is not 保険者算定');

    // A month under 17 days drops out of the average entirely.
    const dropped = (await reg(`months=${M(300000, 30)},${M(100000, 10)},${M(302000, 31)}`)).body;
    ok(dropped.months_used === 2, 'sub-threshold months are excluded, not zero-weighted');
    ok(dropped.average_remuneration === 301000, 'average over the qualifying months only',
       `${dropped.average_remuneration}`);

    // All three short: general keeps the previous grade.
    const carry = (await reg(`months=${M(300000, 10)},${M(300000, 10)},${M(300000, 10)}&previous_remuneration=280000`)).body;
    ok(!carry.decided && carry.insurer_determination, 'no qualifying month means 保険者算定');
    ok(carry.previous_grades.health === 21, 'and the previous grade carries over',
       `${JSON.stringify(carry.previous_grades)}`);

    // 短時間就労者 only: 15-17 days is the fallback (庁保険発第0512001号 記2(1)②).
    const fifteen = (await reg(
      `months=${M(300000, 16)},${M(300000, 15)},${M(300000, 10)}&worker_type=part_time_short_hours`)).body;
    ok(fifteen.decided && fifteen.months_used === 2, '短時間就労者 falls back to 15 days');
    ok(fifteen.insurer_determination, 'the 15-day route is 保険者算定');
    ok(fifteen.fallback_applied?.includes('15日'), 'and says so');

    const generalSame = (await reg(`months=${M(300000, 16)},${M(300000, 15)},${M(300000, 10)}`)).body;
    ok(!generalSame.decided, 'a general employee gets no 15-day fallback');

    // 11 days for 特定適用事業所の短時間労働者.
    const sti = (await reg(`months=${M(120000, 12)},${M(120000, 11)},${M(120000, 10)}&worker_type=short_time_insured`)).body;
    ok(sti.decided && sti.months_used === 2, '短時間労働者 uses the 11-day threshold');

    ok(Array.isArray(generalSame.not_required_for) && generalSame.not_required_for.length === 4,
       '定時決定 lists the four exclusions');

    const acq = (await reg(`months=${three(300000, 300000, 300000, 30)}&acquired_month=3`)).body;
    ok(acq.acquisition_decision.applies_until === 'その年の8月',
       'Jan-May acquisition runs to August of the same year');
    const acq2 = (await reg(`months=${three(300000, 300000, 300000, 30)}&acquired_month=7`)).body;
    ok(acq2.acquisition_decision.applies_until === '翌年の8月',
       'Jun-Dec acquisition runs to August of the following year');
  }

  // --- 休業終了時改定: one grade is enough, and no fixed-pay change is needed ---
  {
    const q = `kind=childcare&current_remuneration=300000&months=${three(280000, 282000, 281000, 30)}`;
    const { body } = await le(q);
    ok(body.applies, '休業終了時改定 applies on a single grade',
       JSON.stringify(body.blocking_reasons));
    ok(body.grade_difference_required === 1, 'the requirement is one grade');
    ok(body.schemes.health.grade_gap === 1, 'and this case is a one-grade move',
       `${body.schemes.health.grade_gap}`);
    ok(body.requires_employee_application === true, 'it needs the employee to apply');

    // The same figures would not be a 随時改定.
    const asRevision = (await rev(
      `current_remuneration=300000&months=${three(280000, 282000, 281000, 30)}&fixed_pay_change=decrease`)).body;
    ok(!asRevision.applies, 'the same figures are not a 随時改定');

    // 健保法43条の2第1項ただし書 / 産休の申出不可.
    const blocked = (await le(q + '&next_leave_starts_immediately=true')).body;
    ok(!blocked.applies, 'a leave starting the next day blocks the application');
    ok(blocked.blocking_reasons.some((r) => r.includes('産前産後休業')),
       'and cites the exclusion');

    // At least one month must reach the threshold.
    const noMonth = (await le(
      `kind=maternity&current_remuneration=300000&months=${M(280000, 10)},${M(280000, 10)},${M(280000, 10)}`)).body;
    ok(!noMonth.applies, 'no qualifying month means no revision');

    // But one is enough, and the others drop out of the average.
    const oneMonth = (await le(
      `kind=maternity&current_remuneration=300000&months=${M(240000, 30)},${M(50000, 5)},${M(50000, 5)}`)).body;
    ok(oneMonth.applies && oneMonth.months_used === 1, 'one qualifying month is enough');
    ok(oneMonth.average_remuneration === 240000, 'and it alone sets the average',
       `${oneMonth.average_remuneration}`);
    ok(oneMonth.months_excluded === 2, 'the short months are reported as excluded');
  }

  // --- 年間平均による保険者算定 ---
  {
    const post = async (payload) => {
      const r = await fetch(BASE + '/v1/standard-remuneration/annual-average', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: r.status, body: await r.json() };
    };

    // 定時決定: April-June inflated by a seasonal peak, the year much lower.
    const seasonal = [];
    for (let i = 0; i < 9; i++) seasonal.push({ remuneration: 250000, payment_basis_days: 30 });
    for (let i = 0; i < 3; i++) seasonal.push({ remuneration: 500000, payment_basis_days: 30 });
    const reg1 = await post({
      type: 'regular', months: seasonal, worker_type: 'general',
      recurring_annually: true, employee_consent: true,
    });
    ok(reg1.status === 200 && reg1.body.applies, '定時決定 annual average applies',
       JSON.stringify(reg1.body.blocking_reasons));
    ok(reg1.body.ordinary_remuneration === 500000, 'ordinary figure is Apr-Jun',
       `${reg1.body.ordinary_remuneration}`);
    ok(reg1.body.annual_average_remuneration === 312500, 'annual figure spans twelve months',
       `${reg1.body.annual_average_remuneration}`);
    ok(reg1.body.decided.health.standard_remuneration === 320000,
       'and the decided grade comes from the annual figure',
       `${JSON.stringify(reg1.body.decided)}`);

    // Consent and the "every year" test are both mandatory.
    for (const [k, label] of [['employee_consent', 'consent'], ['recurring_annually', 'recurrence']]) {
      const r = await post({
        type: 'regular', months: seasonal, worker_type: 'general',
        recurring_annually: true, employee_consent: true, [k]: false,
      });
      ok(!r.body.applies, `定時決定 annual average requires ${label}`);
    }

    // A flat year has no two-grade gap, so there is nothing to apply for.
    const flat = Array.from({ length: 12 }, () => ({ remuneration: 300000, payment_basis_days: 30 }));
    const reg2 = await post({
      type: 'regular', months: flat, worker_type: 'general',
      recurring_annually: true, employee_consent: true,
    });
    ok(!reg2.body.applies, 'a flat year does not qualify');

    // 随時改定: fixed pay rises, but overtime in the three months is unusually high.
    const months = [];
    for (let i = 0; i < 9; i++) months.push({ fixed: 250000, non_fixed: 20000, payment_basis_days: 30 });
    for (let i = 0; i < 3; i++) months.push({ fixed: 280000, non_fixed: 200000, payment_basis_days: 30 });
    const rv = await post({
      type: 'revision', months, current_remuneration: 270000,
      fixed_pay_change: 'increase', worker_type: 'general',
      recurring_annually: true, employee_consent: true,
    });
    ok(rv.status === 200, '随時改定 annual average responds', `${rv.status}`);
    ok(rv.body.ordinary_remuneration === 480000, 'ordinary figure is the plain 3-month average',
       `${rv.body.ordinary_remuneration}`);
    // fixed 280,000 + non-fixed (9x20,000 + 3x200,000)/12 = 280,000 + 65,000
    ok(rv.body.annual_average_remuneration === 345000,
       'annual figure is 3-month fixed plus 12-month non-fixed',
       `${rv.body.annual_average_remuneration}`);
    const h = rv.body.schemes.health;
    ok(h.test_1_current_vs_ordinary.passed, 'test 1: current vs ordinary >= 2 grades');
    ok(h.test_2_ordinary_vs_annual.passed, 'test 2: ordinary vs annual >= 2 grades');
    ok(h.test_3_current_vs_annual.passed, 'test 3: current vs annual >= 1 grade');
    ok(rv.body.applies, '随時改定 annual average applies',
       JSON.stringify(rv.body.blocking_reasons));

    // Validation.
    for (const [payload, label] of [
      [{}, 'missing type'],
      [{ type: 'regular' }, 'missing months'],
      [{ type: 'regular', months: flat.slice(0, 11) }, 'eleven months'],
      [{ type: 'revision', months, worker_type: 'general' }, 'missing current_remuneration'],
      [{ type: 'revision', months, current_remuneration: 270000, fixed_pay_change: 'none' }, 'fixed_pay_change none'],
    ]) {
      ok((await post(payload)).status === 400, `annual average rejects ${label}`);
    }
  }

  // --- Input validation on the GET endpoints ---
  for (const [q, label] of [
    ['', 'nothing'],
    ['current_remuneration=300000', 'no months'],
    [`current_remuneration=300000&months=${M(300000)},${M(300000)}&fixed_pay_change=increase`, 'two months'],
    [`current_remuneration=300000&months=${three(300000, 300000, 300000)}`, 'no fixed_pay_change'],
    [`current_remuneration=300000&months=${three(300000, 300000, 300000)}&fixed_pay_change=maybe`, 'a bad direction'],
    [`current_remuneration=300000&months=300000:40,${M(300000)},${M(300000)}&fixed_pay_change=increase`, '40 days'],
    [`current_remuneration=300000&months=abc:31,${M(300000)},${M(300000)}&fixed_pay_change=increase`, 'a non-numeric amount'],
    [`current_remuneration=300000&months=${three(300000, 300000, 300000)}&fixed_pay_change=increase&worker_type=casual`, 'an unknown worker_type'],
  ]) {
    const r = await rev(q);
    ok(r.status === 400, `revision rejects ${label}`, `got ${r.status}`);
  }
  ok((await reg('')).status === 400, 'regular decision requires months');
  ok((await le(`current_remuneration=300000&months=${three(1, 1, 1)}&kind=nope`)).status === 400,
     'leave-end rejects an unknown kind');

  // /v1/enums is what integrators generate their types from, so a new closed set
  // that never lands there is invisible until someone gets a 400 in production.
  {
    const { body } = await get('/v1/enums');
    for (const [key, values] of [
      ['worker_type', ['general', 'part_time_short_hours', 'short_time_insured']],
      ['fixed_pay_change', ['increase', 'decrease', 'none']],
      ['leave_kind', ['maternity', 'childcare']],
      ['annual_average_type', ['regular', 'revision']],
      ['daily_column', ['kou', 'otsu', 'hei']],
      ['detail', ['full', 'compact']],
    ]) {
      const got = (body[key] ?? []).map((v) => v.value);
      ok(values.every((v) => got.includes(v)) && got.length === values.length,
         `enums lists ${key}`, `got ${JSON.stringify(got)}`);
    }
    ok(body.worker_type.find((w) => w.value === 'short_time_insured').payment_basis_days === 11,
       'enums carries the 11-day threshold');
  }

  // The guidance blocks are part of the contract: integrators surface them in
  // their own UI, so an empty one is a regression.
  {
    const { body } = await rev(`current_remuneration=300000&months=${three(350000, 350000, 350000)}&fixed_pay_change=increase`);
    ok(body.guidance.fixed_pay.counts_as_change.length >= 12, 'fixed-pay guidance is populated');
    ok(body.guidance.fixed_pay.does_not_count.length >= 5, 'and lists what does not count');
    ok(body.guidance.fixed_pay.unverified.length >= 3,
       'and is honest about what could not be sourced');
    ok(body.guidance.payment_basis_days.night_shift.hourly.includes('所定労働時間'),
       'night-shift day counting is documented');
    ok(body.attribution.notices.length >= 4, 'the notices are cited');
  }
}


// ---- 41. free tier and the upgrade route ----
{
  // Local development is exempt, so these run against production explicitly.
  // Without that the caps never engage and the section would silently pass.
  const PROD = 'https://japan-payroll-api.tsumugi.workers.dev';
  const post = async (body, headers = {}) => {
    const r = await fetch(`${PROD}/v1/payroll/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const rows = (n) => ({
    defaults: { prefecture: 'Tokyo', age: 40 },
    employees: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, monthly_salary: 300000 })),
  });

  const root = await (await fetch(PROD + '/')).json();
  ok(root.free_tier?.batch_rows === 10, 'the root response states the batch cap',
     JSON.stringify(root.free_tier));
  ok(typeof root.free_tier?.upgrade === 'string' && root.free_tier.upgrade.length > 0,
     'and names where to upgrade', root.free_tier?.upgrade);

  const small = await post(rows(10));
  ok(small.status === 200, 'the free tier can run a batch up to the cap', `${small.status}`);
  ok(small.body.results?.length === 10, 'and gets every row back');

  const tooBig = await post(rows(11));
  ok(tooBig.status === 400, 'one row over the cap is refused', `${tooBig.status}`);
  ok(tooBig.body.code === 'batch_too_large', 'with a stable code', tooBig.body.code);
  ok(/RapidAPI/i.test(tooBig.body.hint ?? ''),
     'and the refusal is the upgrade route, not a dead end', tooBig.body.hint);

  // Entitlement must not rest on a header the caller can set. Without the proxy
  // secret configured this still passes (documented fallback), but once it is
  // set, a bare host header must buy nothing.
  const spoofed = await post(rows(50), { 'X-RapidAPI-Host': 'japan-payroll.p.rapidapi.com' });
  const secretConfigured = (await (await fetch(`${PROD}/`)).json()).free_tier?.entitlement_verified;
  if (secretConfigured) {
    ok(spoofed.status === 400, 'a bare X-RapidAPI-Host header does not grant the paid cap',
       `${spoofed.status}`);
  } else {
    ok(spoofed.status === 200,
       'without RAPIDAPI_PROXY_SECRET set, claimed RapidAPI traffic still works (documented fallback)',
       `${spoofed.status}`);
  }

  // 有料経路そのものはここでは検証できない。RapidAPI と一致する Proxy Secret を
  // 持たないと再現できず、その秘密をテストに置くわけにもいかない。検証しないもの
  // を検証したふりをするテストは、無いより悪い。
  //
  // 代わりに、秘密を持たない呼び出しが「有料扱いされないこと」だけを確かめる。
  // 有料側が実際に通ることは、本番ログに plan:"BASIC" が出るかで確認する運用
  // (README の Maintenance 参照)。
  ok(tooBig.body.hint?.includes('500'),
     'the refusal states the paid batch size', tooBig.body.hint);
  ok(root.free_tier?.batch_rows === 10 && /500/.test(JSON.stringify(root.endpoints)),
     'both limits are published, so the gap is visible before hitting it');

  // 上限そのものは無料枠でも越えられない。ここが逆転すると、無料の方が大きな
  // バッチを投げられることになる。
  const wayOver = await post(rows(501));
  ok(wayOver.status === 400, 'far over the maximum is still refused', `${wayOver.status}`);
}


// ---- 42. 引用条文の本文 ----
{
  const st = (q) => get(`/v1/statute?${q}`);
  const enc = encodeURIComponent;

  const index = (await get('/v1/statute/index')).body;
  ok(index.count >= 28, 'the statute index is populated', `${index.count}`);
  ok(Object.keys(index.laws).length >= 8, 'and covers every law cited',
     `${Object.keys(index.laws || {}).length}`);

  {
    const { body } = await st(`ref=${enc('健康保険法第43条')}`);
    ok(body.caption === '（改定）', 'the article caption comes through', body.caption);
    ok(body.text.startsWith('保険者等は、被保険者が現に使用される事業所において継続した三月間'),
       'and the text is the actual provision', body.text?.slice(0, 40));
    ok(body.paragraphs?.length === 2, '第43条 has two paragraphs', `${body.paragraphs?.length}`);
    ok(body.law.law_num === '大正十一年法律第七十号', 'the law number is carried',
       body.law?.law_num);
    ok(body.url.includes('laws.e-gov.go.jp'), 'and a link back to the source');
  }

  {
    // 明治35年の法律。片仮名の原文がそのまま返らなければ、どこかで加工している。
    const { body } = await st(`ref=${enc('年齢計算ニ関スル法律')}`);
    ok(body.text === '年齢ハ出生ノ日ヨリ之ヲ起算ス',
       'the 1902 Act comes back verbatim', body.text);
  }

  // 引用の書かれ方は一定しない。略称、「第」の省略、項までの指定、全角数字 —
  // どれも実際に書かれる形で、どれも同じ条文に解決しなければ意味がない。
  for (const [input, want] of [
    ['健康保険法第43条', '健康保険法第43条'],
    ['健康保険法第43条第1項', '健康保険法第43条'],
    ['健康保険法43条', '健康保険法第43条'],
    ['健保法43条', '健康保険法第43条'],
    ['健保法第43条', '健康保険法第43条'],
    ['厚年法81条の2', '厚生年金保険法第81条の2'],
    ['厚生年金法第23条', '厚生年金保険法第23条'],
    ['健保則24条の2', '健康保険法施行規則第24条の2'],
    ['徴収法11条', '労働保険徴収法第11条'],
    ['民法143条2項', '民法第143条'],
    ['健康保険法１５６条', '健康保険法第156条'],
  ]) {
    const { status, body } = await st(`ref=${enc(input)}`);
    ok(status === 200 && body.ref === want, `"${input}" resolves to ${want}`,
       `${status} ${body.ref ?? body.error}`);
  }

  // 枝番の条文が本体に食われてはいけない。第43条の2 は第43条ではない。
  {
    const a = (await st(`ref=${enc('健康保険法第43条')}`)).body;
    const b = (await st(`ref=${enc('健康保険法第43条の2')}`)).body;
    ok(a.ref !== b.ref, 'a branch article is not the same as its parent');
    ok(b.text !== a.text, 'and returns different text');
  }

  // 登録していない条文は、それらしい本文を返すのではなく明確に断る。
  for (const bad of ['健康保険法第4条', '存在しない法第1条', '所得税法第28条']) {
    const { status, body } = await st(`ref=${enc(bad)}`);
    ok(status === 400 && body.code === 'out_of_coverage',
       `"${bad}" is refused rather than guessed at`, `${status} ${body.code}`);
    ok(/e-gov/i.test(body.hint ?? ''), 'and points at where the full corpus is');
  }
  ok((await st('')).status === 400, 'a missing ref is refused');

  // --- include=statute_text ---
  {
    const q = 'current_remuneration=300000&months=350000:31,352000:30,349000:31&fixed_pay_change=increase';
    const plain = (await get(`/v1/standard-remuneration/revision?${q}`)).body;
    const rich = (await get(`/v1/standard-remuneration/revision?${q}&include=statute_text`)).body;

    ok(plain.statute_text === undefined, 'statute text is off by default');
    ok(rich.statute_text?.count >= 1, 'and attaches when asked',
       `${rich.statute_text?.count}`);
    ok(!!rich.statute_text.provisions['健康保険法第43条'],
       'resolving what the response actually cited',
       Object.keys(rich.statute_text?.provisions ?? {}).join(','));
    ok(rich.applies === plain.applies, 'without changing the answer itself');

    // 引用していないものを勝手に足さないこと。給与計算は料額表に基づくもので、
    // 条文を引用していない。ここに条文が付いたら、拾い方が広すぎる。
    const payroll = (await get(
      '/v1/payroll?prefecture=Tokyo&monthly_salary=350000&age=40&include=statute_text')).body;
    ok(payroll.statute_text === undefined || payroll.statute_text.count === 0,
       'an endpoint that cites nothing gets nothing attached',
       `${payroll.statute_text?.count}`);

    // 説明文の途中にある引用も拾えること。blocking_reasons は散文で、
    // その中の条文番号こそ読み手が確かめたいもの。
    const leave = (await get(
      '/v1/leave-exemption?kind=childcare&start=2026-03-15&end=2026-03-28&include=statute_text')).body;
    ok(leave.statute_text?.count >= 3, 'citations inside prose are picked up too',
       `${leave.statute_text?.count}`);
  }

  // すべての参照が本文を持つこと。索引に載っているのに本文が空なら、
  // 引用はできても根拠を示せていない。
  {
    let empty = 0;
    for (const entry of index.provisions) {
      const { body } = await st(`ref=${enc(entry.ref)}`);
      if (!body.text || body.text.length < 5) empty++;
    }
    ok(empty === 0, 'every indexed provision has text', `${empty} empty`);
  }

  ok(/e-Gov/i.test(JSON.stringify(index.attribution)), 'the source is attributed');
  ok(/CC BY/i.test(JSON.stringify(index.attribution)), 'with its licence stated');
}


console.log(`\n  passed ${pass} / ${pass + fail}`);
if (fail) { console.log('\n  FAILURES:'); failures.forEach((f) => console.log('   - ' + f)); process.exit(1); }
console.log('  all checks green\n');
