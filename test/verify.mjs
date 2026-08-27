// Verifies the running API against premium amounts published in the official
// 協会けんぽ 令和8年度保険料額表 workbook, plus boundary and rule checks.
import fixture from './official-fixture.json' with { type: 'json' };
import freshness from '../src/data/freshness.json' with { type: 'json' };
import { readFile, readdir } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8799';

// Fail with an instruction rather than an ECONNREFUSED stack. This suite is the
// thing you run after updating statutory data, when what you need is a clear
// answer about whether the figures are right — not a puzzle about your setup.
try {
  // ここは再試行しない。到達しないなら待つより指示を出すほうがよい。
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

/**
 * A request that cannot hang.
 *
 * `wrangler dev` restarts the local worker whenever anything in the project
 * changes, and a request that was in flight at that moment is never answered.
 * A bare `fetch` then waits forever, and the run looks identical to a slow one
 * -- that cost two full suite runs before it was understood. Time out and retry
 * once instead: a genuine failure still fails, a restart no longer wedges the
 * suite.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ATTEMPTS = 5;

const get = async (p, attempt = 0) => {
  try {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: await r.json() };
  } catch (e) {
    if (attempt < ATTEMPTS - 1) {
      // 待たずに retry すると、3回とも再起動中に着弾して同じ失敗になる。
      // workerd はこの負荷で実際にクラッシュし、復帰まで1秒前後かかる。
      await sleep(250 * 2 ** attempt);
      return get(p, attempt + 1);
    }
    throw new Error(`GET ${p} failed after ${ATTEMPTS} attempts: ${e?.message ?? e}`);
  }
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
/**
 * 再試行つきの fetch。
 *
 * workerd は連続負荷でときどき接続を切る。get() にだけバックオフを入れて POST と
 * 掃引を生の fetch にしていたため、呼び出し回数がいちばん多い掃引が ECONNRESET で
 * 落ちた。外に出る口をひとつにして、そこに入れる。
 */
const tryFetch = async (url, init, attempt = 0) => {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(30000), ...init });
  } catch (e) {
    if (attempt < ATTEMPTS - 1) {
      await sleep(250 * 2 ** attempt);
      return tryFetch(url, init, attempt + 1);
    }
    throw new Error(`${init?.method ?? 'GET'} ${url} failed after ${ATTEMPTS} attempts: ${e?.message ?? e}`);
  }
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
                         ['/v1/payroll?prefecture=Tokyo&monthly_salary=abc&age=40', 400],
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
  ok(/個人事業者/.test(corp.body.reason), 'the response refuses to attribute the holder');
  ok(/614,413/.test(corp.body.reason), 'the empirical basis is stated');

  // A wrong check digit is reported as almost certainly a typo.
  const typo = await get('/v1/invoice-number/validate?number=T1234567890123');
  ok(typo.body.format_valid === true, 'format is still valid');
  ok(typo.body.check_digit_valid === false, 'check digit fails');
  ok(typo.body.expected_check_digit !== typo.body.check_digit, 'expected digit is reported');
  // 文言を和文に揃えたので照合も和文にする。見たいのは「入力間違いだと述べているか」。
  ok(/入力間違い/.test(typo.body.reason), 'a mismatch is called out as a likely typo',
     typo.body.reason?.slice(0, 50));

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
  // 文言を和文に揃えたので、照合も和文にする。見たいのは「10月の改定に触れているか」で
  // あって、英語で書かれていることではない。
  ok(!!mw.note && /2026年10月/.test(mw.note), 'minimum wage carries an explicit warning note',
     mw.note?.slice(0, 60));

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
    const r = await tryFetch(BASE + '/v1/payroll/batch', {
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
      { id: 'baddep', monthly_salary: 300000, age: 30, dependants: 1.5 },
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
  const tooMany = await post({ defaults, employees: Array.from({ length: 501 }, () => ({ monthly_salary: 300000, age: 30 })) });
  ok(tooMany.status === 400 && tooMany.body.code === 'batch_too_large',
     'over 500 employees is rejected with its own code', `${tooMany.status} ${tooMany.body.code}`);
  const atLimit = await post({ defaults, employees: Array.from({ length: 500 }, () => ({ monthly_salary: 300000, age: 30 })) });
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
    const r = await tryFetch(`${BASE}/v1/payroll/batch${q}`, {
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
  const r = (await b('bonus=700000&previous_month_pay=350000&previous_month_insurance=55750&dependants=2&bonus_insurance=0')).body;
  ok(r.applicable === true, 'the ordinary case uses the table');
  ok(r.previous_month_after_insurance === 294250, 'the lookup key is last month after insurance',
     `${r.previous_month_after_insurance}`);
  ok(r.rate_band.from <= 294250 && r.rate_band.to > 294250, 'the band contains the lookup key',
     JSON.stringify(r.rate_band));
  ok(r.tax === Math.floor(700000 * r.rate), 'tax is bonus x rate, truncated',
     `${r.tax} vs ${Math.floor(700000 * r.rate)}`);

  // 賞与の社会保険料は必須。既定0にすると課税標準が膨らみ、税額が過大になる。
  // 賞与50万・東京・40歳の例で3,063円の差が出た。渡し忘れた人に黙って
  // 間違った額を返し続けるより、400で止めるほうが安い。
  ok((await b('bonus=700000&previous_month_pay=350000&previous_month_insurance=55750')).status === 400,
     'bonus_insurance is required rather than defaulting to zero');
  {
    const missing = (await b('bonus=700000&previous_month_pay=350000&previous_month_insurance=55750'));
    ok(/186条|after its own social insurance/.test(missing.body.hint ?? ''),
       'and the refusal says why it matters', missing.body.hint);
  }

  // The bonus's own social insurance comes off before the rate is applied.
  const withIns = (await b('bonus=700000&bonus_insurance=100000&previous_month_pay=350000&previous_month_insurance=55750&dependants=2')).body;
  ok(withIns.bonus_after_insurance === 600000, 'bonus insurance is deducted first');
  ok(withIns.tax === Math.floor(600000 * withIns.rate), 'tax uses the after-insurance bonus');
  ok(withIns.rate === r.rate, 'the rate is unchanged by the bonus insurance');

  // More dependants means a lower rate at the same previous pay.
  let prevRate = Infinity;
  for (let d = 0; d <= 7; d++) {
    const x = (await b(`bonus=500000&previous_month_pay=400000&previous_month_insurance=60000&dependants=${d}&bonus_insurance=0`)).body;
    ok(x.rate <= prevRate, `bonus rate is non-increasing in dependants at d=${d}`, `${prevRate} -> ${x.rate}`);
    prevRate = x.rate;
  }
  const otsu = (await b('bonus=500000&previous_month_pay=400000&previous_month_insurance=60000&column=otsu&bonus_insurance=0')).body;
  ok(otsu.dependants === null, '乙 ignores dependants');
  ok(otsu.rate > 0, '乙 has a rate');

  // The three cases where the table must NOT be used.
  const noPrev = (await b('bonus=500000&previous_month_pay=0&bonus_insurance=0')).body;
  ok(noPrev.applicable === false && noPrev.reason_code === 'no_previous_month_pay',
     'no pay last month falls outside the table', noPrev.reason_code);
  const swallowed = (await b('bonus=500000&previous_month_pay=50000&previous_month_insurance=50000&bonus_insurance=0')).body;
  ok(swallowed.applicable === false && swallowed.reason_code === 'previous_pay_at_or_below_insurance',
     'pay at or below insurance falls outside the table', swallowed.reason_code);
  const huge = (await b('bonus=5000000&previous_month_pay=350000&previous_month_insurance=55750&bonus_insurance=0')).body;
  ok(huge.applicable === false && huge.reason_code === 'bonus_exceeds_ten_times',
     'a bonus over ten times last month falls outside the table', huge.reason_code);
  ok(huge.ten_times_limit === 294250 * 10, 'the ten-times limit is reported', `${huge.ten_times_limit}`);
  ok(!!huge.instead, 'the response says what to use instead');

  // Exactly ten times is still inside the table; a yen more is not.
  const atLimit = (await b('bonus=2942500&previous_month_pay=350000&previous_month_insurance=55750&bonus_insurance=0')).body;
  ok(atLimit.applicable === true, 'exactly ten times is still in the table');
  const overLimit = (await b('bonus=2942501&previous_month_pay=350000&previous_month_insurance=55750&bonus_insurance=0')).body;
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
  ok(first.notes.some((n) => /1日生まれ/.test(n)), 'the 1st-of-month case is called out',
     JSON.stringify(first.notes).slice(0, 80));

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
  ok(at65.notes.some((n) => /市区町村/.test(n)), 'the 65 case explains where LTC goes instead',
     JSON.stringify(at65.notes).slice(0, 70));

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
      const r = await tryFetch(BASE + '/v1/standard-remuneration/annual-average', {
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
    const r = await tryFetch(`${PROD}/v1/payroll/batch`, {
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

  const root = await (await tryFetch(PROD + '/')).json();
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
  const secretConfigured = (await (await tryFetch(`${PROD}/`)).json()).free_tier?.entitlement_verified;
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



// ---- 43. 第1反復: 月次給与の臨界経路 ----
//
// 「課金の理由を強くする」ループの第1反復。信頼を壊すもの(間違った数字)を先に、
// 臨界経路の穴をその後に。

// --- F-01 資格喪失月の賞与 ---
{
  const b = (q) => get(`/v1/bonus-insurance?prefecture=Tokyo&bonus=500000&age=40&fiscal_year_to_date=0&${q}`);

  // 3月30日退職なら喪失日は3月31日で3月が喪失月 → 保険料なし。
  // 3月31日退職なら喪失日は4月1日で4月が喪失月 → 3月分は徴収される。
  // 1日違いで結論が逆になるのが要点で、以前はどちらも満額を返していた。
  const on30 = (await b('paid_on=2026-03-25&left_on=2026-03-30')).body;
  ok(on30.exempt === true, '30 March leaver: the bonus month is the loss month', `${on30.exempt}`);
  ok(on30.totals.employee === 0, 'so nothing is deducted', `${on30.totals.employee}`);
  ok(on30.totals.employer === 0, 'and the employer pays nothing either');
  ok(/156条/.test(on30.exempt_reason ?? ''), 'citing the provision it rests on', on30.exempt_reason);

  const on31 = (await b('paid_on=2026-03-25&left_on=2026-03-31')).body;
  ok(on31.exempt === false, '31 March leaver: the loss month is April', `${on31.exempt}`);
  ok(on31.totals.employee > 0, 'so the March bonus is charged', `${on31.totals.employee}`);

  // この差が実際に金額として現れること。真偽値だけ合っていても意味がない。
  ok(on31.totals.employee !== on30.totals.employee,
     'one day apart gives different money', `${on30.totals.employee} vs ${on31.totals.employee}`);

  // 支給月が喪失月より前なら通常どおり課される。
  const earlier = (await b('paid_on=2026-02-25&left_on=2026-03-30')).body;
  ok(earlier.exempt === false, 'a bonus paid before the loss month is charged normally');

  // 退職日を渡さなければ従来どおり。既存の呼び出しを壊さないこと。
  const plain = (await b('')).body;
  ok(plain.exempt === false && plain.totals.employee > 0,
     'omitting the dates keeps the previous behaviour');

  // 退職日だけ渡しても判定できない。どの月に払ったかが要る。
  ok((await b('left_on=2026-03-30')).status === 400,
     'left_on without paid_on is refused rather than guessed at');
}

// --- F-25 休業中の賞与 ---
{
  const l = (await get('/v1/bonus-insurance?prefecture=Tokyo&bonus=400000&age=32&fiscal_year_to_date=0&leave_exempt=true')).body;
  ok(l.exempt === true && l.totals.employee === 0, 'a bonus during leave is exempt',
     `${l.totals.employee}`);
  ok(/159条/.test(l.exempt_reason ?? ''), 'citing the leave provisions', l.exempt_reason);

  const notLeave = (await get('/v1/bonus-insurance?prefecture=Tokyo&bonus=400000&age=32&fiscal_year_to_date=0&leave_exempt=false')).body;
  ok(notLeave.totals.employee > 0, 'and false means charged');
  ok((await get('/v1/bonus-insurance?prefecture=Tokyo&bonus=400000&leave_exempt=maybe')).status === 400,
     'a non-boolean leave_exempt is refused');
}

// --- F-27 役員は雇用保険の被保険者にならない ---
{
  const p = (t) => get(`/v1/payroll?prefecture=Tokyo&monthly_salary=800000&age=55&employment_type=${t}`);
  const emp = (await p('employee')).body;
  const dir = (await p('director')).body;
  const both = (await p('director_employee')).body;

  ok(emp.deductions.employment_insurance.employee > 0, 'an employee pays employment insurance');
  ok(dir.deductions.employment_insurance.employee === 0,
     'a director does not (雇用保険法第4条)', `${dir.deductions.employment_insurance.employee}`);
  ok(dir.deductions.employment_insurance.employer === 0, 'nor does the employer for them');
  ok(dir.coverage.employment_insurance === false, 'and coverage says so rather than staying silent');
  ok(dir.totals.net_pay > emp.totals.net_pay, 'so the director takes home more',
     `${dir.totals.net_pay} vs ${emp.totals.net_pay}`);

  // 兼務役員は労働者性が認められれば被保険者になる。役員と同じ扱いにしてはいけない。
  ok(both.deductions.employment_insurance.employee > 0,
     'a 兼務役員 is covered on the employee side');

  // 社会保険は役員でも被保険者。雇用保険だけを外すこと。
  ok(dir.deductions.health_insurance.employee > 0, 'a director still pays health insurance');
  ok(dir.deductions.pension.employee > 0, 'and pension');

  ok((await p('boss')).status === 400, 'an unknown employment_type is refused');
}

// --- F-06 割増賃金 ---
{
  const o = (q) => get(`/v1/overtime-pay?base_monthly_pay=300000&monthly_scheduled_hours=160&${q}`);

  // 300,000 ÷ 160 = 1,875円/時。以下すべてこの時給から手計算で検算できる。
  const base = (await o('overtime_hours=20')).body;
  ok(base.hourly_rate.value === 1875, 'the hourly rate divides out', `${base.hourly_rate.value}`);
  ok(base.lines.overtime.amount === 1875 * 20 * 1.25, 'overtime is 1.25 (労基法37条1項)',
     `${base.lines.overtime.amount}`);

  // 60時間を境に率が変わる。70時間なら60時間分が1.25、10時間分が1.5。
  const long = (await o('overtime_hours=70')).body;
  ok(long.lines.overtime.hours === 60 && long.lines.overtime_over_60h.hours === 10,
     'hours split at the 60-hour threshold',
     `${long.lines.overtime.hours}/${long.lines.overtime_over_60h.hours}`);
  ok(long.lines.overtime_over_60h.amount === 1875 * 10 * 1.5,
     'and the excess is 1.5 (37条1項ただし書)', `${long.lines.overtime_over_60h.amount}`);

  // 法定休日は1.35。時間外の割増は付かない。
  const hol = (await o('holiday_hours=8')).body;
  ok(hol.lines.holiday.amount === 1875 * 8 * 1.35, 'statutory holiday work is 1.35',
     `${hol.lines.holiday.amount}`);
  ok(hol.lines.overtime.amount === 0, 'and does not also attract the overtime premium');

  // 深夜は加算。別枠で全額払うのではなく 0.25 を足す。
  const night = (await o('overtime_hours=10&night_hours=10')).body;
  ok(night.lines.night_premium.rate === 0.25, 'the night premium is additive, not a full rate',
     `${night.lines.night_premium.rate}`);
  ok(night.total === night.lines.overtime.amount + night.lines.night_premium.amount,
     'so overtime at night comes to 1.25 + 0.25 in total');

  // 端数は区分ごとに処理する。昭和63年基発第150号は「時間外労働、休日労働、
  // 深夜労働の**それぞれの**割増賃金の総額」に対する処理を認めており、
  // 合算してから丸めるのは通達に反する。
  //   時間外 1875 × 10 × 1.25 = 23,437.5 → 23,438
  //   深夜   1875 × 10 × 0.25 =  4,687.5 →  4,688
  // 合計 28,126 であって、1875 × 10 × 1.5 = 28,125 ではない。
  ok(night.lines.overtime.amount === 23438, 'each category rounds on its own subtotal',
     `${night.lines.overtime.amount}`);
  ok(night.lines.night_premium.amount === 4688, 'including the night premium',
     `${night.lines.night_premium.amount}`);
  ok(night.total === 28126, 'so the total is not the same as rounding a combined 1.5 rate',
     `${night.total}`);

  // 端数処理を切れば、combined rate と一致する。
  const exact = (await o('overtime_hours=10&night_hours=10&round=false')).body;
  ok(exact.total === 1875 * 10 * 1.5, 'without rounding it is exactly 1.5',
     `${exact.total}`);

  // 端数は50銭以上切上げ (昭和63年基発第150号)。1875 × 5 × 0.25 = 2343.75 → 2344。
  const frac = (await o('overtime_hours=5&night_hours=5')).body;
  ok(frac.lines.night_premium.amount === 2344, 'half a yen and over rounds up',
     `${frac.lines.night_premium.amount}`);
  const unrounded = (await o('overtime_hours=5&night_hours=5&round=false')).body;
  ok(unrounded.lines.night_premium.amount === 2343.75, 'and rounding can be turned off',
     `${unrounded.lines.night_premium.amount}`);

  // 算定基礎から除外できる手当は限定列挙で、名称ではなく実質で決まる。
  ok(base.excludable_allowances.length === 7, 'the seven excludable allowances are listed',
     `${base.excludable_allowances.length}`);
  ok(base.excludable_allowances.some((a) => /一律支給は除外できない/.test(a.note ?? '')),
     'saying that a flat allowance cannot be excluded despite its name');

  // 所定労働時間は事業所ごとに違うので、推測してはいけない。
  ok((await get('/v1/overtime-pay?base_monthly_pay=300000')).status === 400,
     'scheduled hours are required rather than assumed');
  ok((await get('/v1/overtime-pay?monthly_scheduled_hours=160')).status === 400,
     'and so is the base pay');
  ok((await get('/v1/overtime-pay?base_monthly_pay=300000&monthly_scheduled_hours=0')).status === 400,
     'zero scheduled hours is refused rather than dividing by zero');
}



// ---- 44. 独立した批評で見つかった誤り ----
//
// 3,638件のテストが見逃していたもの。私が想定した使い方の外にあった。

// --- 同月得喪 ---
{
  // 健保法156条3項は「前月から引き続き被保険者である者」に限って喪失月を免除する。
  // 同じ月に入って同じ月に出た人はそれに当たらないので、1か月分が徴収される。
  // ここを false で返していた。条文本文はこのAPI自身が返していたのに、
  // 限定句を読み落としていた。
  const same = (await get('/v1/eligibility?month=2026-04&joined_on=2026-04-10&left_on=2026-04-25')).body;
  ok(same.social_insurance_due === true, '同月得喪 is charged, not exempt',
     `${same.social_insurance_due}`);
  ok(same.same_month_acquisition_and_loss === true, 'and is flagged as the special case');
  ok(/前月から引き続き/.test(same.reason), 'citing the clause that decides it', same.reason);
  ok(same.statutes.some((x) => /第19条/.test(x)), 'and the pension-side provision');

  // 前月から在籍していれば、同じ25日退職でも免除になる。差は「前月から引き続くか」だけ。
  const carried = (await get('/v1/eligibility?month=2026-04&joined_on=2026-03-01&left_on=2026-04-25')).body;
  ok(carried.social_insurance_due === false,
     'someone insured from the previous month is exempt in the loss month');
  ok(!carried.same_month_acquisition_and_loss, 'and is not the same-month case');

  // 入社だけの月、退社だけの月は従来どおり。
  const joinedOnly = (await get('/v1/eligibility?month=2026-04&joined_on=2026-04-10')).body;
  ok(joinedOnly.social_insurance_due === true, 'joining alone is still a chargeable month');
}

// --- 標準報酬月額を外から渡せること ---
{
  const p = (q) => get(`/v1/payroll?prefecture=Tokyo&age=42&${q}`);

  // 標準報酬月額は算定基礎届で決まり翌年8月まで固定。残業で支給額が動いた月に
  // 等級を引き直すのは誤りで、月給30万(等級22)の人が369,469円になった月に
  // 引き直すと等級25になり、8,445円多く引くことになる。
  const fixed = (await p('monthly_salary=369469&standard_remuneration=300000')).body;
  const rederived = (await p('monthly_salary=369469')).body;

  ok(fixed.standard_remuneration.health === 300000,
     'the grade comes from the standard remuneration when given',
     `${fixed.standard_remuneration.health}`);
  ok(rederived.standard_remuneration.health === 360000,
     'and from the pay when not', `${rederived.standard_remuneration.health}`);

  const social = (b) => b.deductions.health_insurance.employee + b.deductions.pension.employee;
  ok(social(fixed) < social(rederived), 'which changes the money',
     `${social(fixed)} vs ${social(rederived)}`);
  ok(social(rederived) - social(fixed) === 8445, 'by 8,445 yen in this case',
     `${social(rederived) - social(fixed)}`);

  // 通常月と残業月で、標準報酬を渡していれば控除は同じでなければならない。
  const quiet = (await p('monthly_salary=300000&standard_remuneration=300000')).body;
  ok(social(quiet) === social(fixed),
     'a busy month and a quiet month deduct the same when the grade is fixed',
     `${social(quiet)} vs ${social(fixed)}`);

  // 雇用保険は実際の支給額にかかるので、こちらは変わってよい。
  ok(fixed.deductions.employment_insurance.employee > quiet.deductions.employment_insurance.employee,
     'while employment insurance still follows actual pay');

  ok((await p('monthly_salary=300000&standard_remuneration=0')).status === 400,
     'a zero standard remuneration is refused');
}

// --- 未知のクエリパラメータを拒否すること ---
{
  // 金額を扱うAPIで綴り間違いを黙って無視するのは事故製造機になる。
  // 批評で挙がった不具合の複数が「渡したのに無視された」だった。
  for (const [path, param] of [
    ['/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=40', 'commute_allowance=15000'],
    ['/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=40', 'zzz_bogus=999'],
    ['/v1/bonus-insurance?prefecture=Tokyo&bonus=500000&age=40', 'left_date=2026-03-30'],
    ['/v1/overtime-pay?base_monthly_pay=300000&monthly_scheduled_hours=160', 'overtime=20'],
  ]) {
    const r = await get(`${path}&${param}`);
    ok(r.status === 400, `"${param}" is rejected rather than ignored`, `${r.status}`);
    ok(r.body.code === 'unknown_parameter', 'with a code a client can branch on', r.body.code);
  }

  // 綴りが近ければ候補を出す。
  const typo = (await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=40&standard_remuneration_=300000')).body;
  ok(/間違いではありませんか/.test(typo.hint ?? ''), 'a near miss suggests the right name', typo.hint);

  // 正しいパラメータは当然通る。
  ok((await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=40&standard_remuneration=300000&employment_type=director&income_tax=false')).status === 200,
     'every accepted parameter still works together');
}


// --- 通勤手当: 社保では報酬、所得税では非課税限度額 (F-03) ---
// バー: 国税庁 タックスアンサー No.2585 / No.2582 (令和8年4月1日現在法令等)、
// 所得税法第9条第1項第5号、所得税法施行令第20条の2。
// 社会保険で報酬に含めるのは健康保険法第3条第5項(名称の如何を問わず労働者が
// 労務の対償として受けるもの)。この二つが食い違うのが給与計算の根幹で、
// 単一の monthly_salary では構造的に表現できなかった。
{
  const p = (q) => get(`/v1/payroll?prefecture=Tokyo&age=42&${q}`);

  const bare = (await p('monthly_salary=300000')).body;
  const t = (await p('monthly_salary=300000&commuting_allowance=15000')).body;

  // 支給の内訳が返ること (F-16)。これが無いと賃金台帳も給与明細も作れない。
  ok(t.earnings?.gross === 315000, 'gross pay includes the commuting allowance',
     `${t.earnings?.gross}`);
  ok(t.earnings?.non_taxable === 15000, '15,000 is under the 150,000 ceiling, so none of it is taxed',
     `${t.earnings?.non_taxable}`);
  ok(t.earnings?.taxable === 300000, 'leaving the base pay as the taxable part',
     `${t.earnings?.taxable}`);

  // 社会保険では報酬に含む。等級が 22 (300,000) から 23 (320,000) に上がる。
  ok(t.earnings?.remuneration_basis === 315000,
     'while social insurance counts the same allowance as remuneration',
     `${t.earnings?.remuneration_basis}`);
  ok(bare.standard_remuneration.health === 300000, 'without it the grade is 300,000',
     `${bare.standard_remuneration.health}`);
  ok(t.standard_remuneration.health === 320000, 'with it 315,000 falls in the 320,000 grade',
     `${t.standard_remuneration.health}`);

  // 雇用保険は賃金総額にかかり、通勤手当は賃金に含まれる。315,000 * 0.005 = 1,575。
  ok(t.earnings?.employment_insurance_basis === 315000,
     'employment insurance is charged on total wages, commuting allowance included',
     `${t.earnings?.employment_insurance_basis}`);
  ok(t.deductions.employment_insurance.employee === 1575,
     '315,000 * 0.005 = 1,575', `${t.deductions.employment_insurance.employee}`);
  ok(bare.deductions.employment_insurance.employee === 1500,
     'against 300,000 * 0.005 = 1,500 without it',
     `${bare.deductions.employment_insurance.employee}`);

  // 所得税の課税対象は非課税分を除いた支給額から社会保険料を引いた額。
  ok(t.income_tax.taxable_amount === 300000 - t.totals.social_insurance_employee,
     'income tax is charged on taxable pay after social insurance, not on gross',
     `${t.income_tax.taxable_amount}`);

  // 限度超過分は課税される。160,000 - 150,000 = 10,000。
  const over = (await p('monthly_salary=300000&commuting_allowance=160000')).body;
  ok(over.earnings?.non_taxable === 150000, 'the transit ceiling is 150,000 a month',
     `${over.earnings?.non_taxable}`);
  ok(over.earnings?.taxable === 310000, 'and 160,000 - 150,000 = 10,000 of it is taxed',
     `${over.earnings?.taxable}`);
  ok(over.earnings?.remuneration_basis === 460000,
     'social insurance still counts all 160,000 as remuneration',
     `${over.earnings?.remuneration_basis}`);

  // 交通用具通勤は片道距離の区分表。10km以上15km未満は7,300円。
  const car = (await p('monthly_salary=300000&commuting_allowance=10000&commuting_distance_km=12')).body;
  ok(car.earnings?.non_taxable === 7300, '12km one way falls in the 10-15km band: 7,300',
     `${car.earnings?.non_taxable}`);
  ok(car.earnings?.taxable === 302700, 'so 10,000 - 7,300 = 2,700 is taxed',
     `${car.earnings?.taxable}`);

  // 片道2km未満は全額課税。
  const near2 = (await p('monthly_salary=300000&commuting_allowance=5000&commuting_distance_km=1.5')).body;
  ok(near2.earnings?.non_taxable === 0, 'under 2km one way nothing is exempt',
     `${near2.earnings?.non_taxable}`);
  ok(near2.earnings?.taxable === 305000, 'the whole allowance is taxed',
     `${near2.earnings?.taxable}`);

  // 95km以上は66,400円。
  const far = (await p('monthly_salary=300000&commuting_allowance=70000&commuting_distance_km=100')).body;
  ok(far.earnings?.non_taxable === 66400, '100km one way is the top band: 66,400',
     `${far.earnings?.non_taxable}`);

  // 併用は「運賃等の額 + 距離区分」が限度。25km区分19,700 + 運賃30,000 = 49,700。
  const both = (await p('monthly_salary=300000&commuting_allowance=60000&commuting_distance_km=25&commuting_fare=30000')).body;
  ok(both.earnings?.non_taxable === 49700, '19,700 (25-35km band) + 30,000 fare = 49,700',
     `${both.earnings?.non_taxable}`);
  ok(both.earnings?.taxable === 310300, 'and 60,000 - 49,700 = 10,300 is taxed',
     `${both.earnings?.taxable}`);

  // 併用でも合計15万が上限。66,400 + 140,000 = 206,400 だが 150,000 で頭打ち。
  const capped = (await p('monthly_salary=300000&commuting_allowance=200000&commuting_distance_km=100&commuting_fare=140000')).body;
  ok(capped.earnings?.non_taxable === 150000, 'the combined ceiling is still 150,000',
     `${capped.earnings?.non_taxable}`);

  // 支給額を超えて非課税にはならない。
  const small = (await p('monthly_salary=300000&commuting_allowance=3000&commuting_distance_km=50')).body;
  ok(small.earnings?.non_taxable === 3000,
     'the exemption never exceeds what was actually paid', `${small.earnings?.non_taxable}`);

  // 通勤手当が無いときは gross と課税支給額が一致し、従来の答えが変わらないこと。
  ok(bare.earnings?.gross === 300000 && bare.earnings?.taxable === 300000,
     'with no allowances the breakdown collapses to the salary', `${bare.earnings?.gross}`);
  ok(bare.totals.net_pay === bare.totals.gross - bare.totals.social_insurance_employee
       - bare.totals.income_tax - bare.totals.resident_tax,
     'and net pay still reconciles');

  // 手取りは通勤手当を含んだ支給額から引いたもの。
  ok(t.totals.net_pay === 315000 - t.totals.social_insurance_employee - t.totals.income_tax,
     'net pay is gross less deductions, commuting allowance included',
     `${t.totals.net_pay}`);

  // 駐車場等の利用料は距離区分の額に加算される。上限5,000円で、片道2km以上に限る
  // (所得税法施行令第20条の2、令和8年4月1日施行)。10-15km区分7,300 + 3,000 = 10,300。
  const park = (await p('monthly_salary=300000&commuting_allowance=12000&commuting_distance_km=12&commuting_parking=3000')).body;
  ok(park.earnings?.non_taxable === 7300 + 3000,
     'parking is added to the distance band: 7,300 + 3,000 = 10,300',
     `${park.earnings?.non_taxable}`);

  // 加算は5,000円で頭打ち。8,000円払っていても5,000円まで。
  const parkCap = (await p('monthly_salary=300000&commuting_allowance=20000&commuting_distance_km=12&commuting_parking=8000')).body;
  ok(parkCap.earnings?.non_taxable === 7300 + 5000,
     'the parking addition stops at 5,000, so 7,300 + 5,000 = 12,300',
     `${parkCap.earnings?.non_taxable}`);

  // 片道2km未満は距離区分が0なので、駐車場代を払っていても加算されない。
  const parkNear = (await p('monthly_salary=300000&commuting_allowance=6000&commuting_distance_km=1.5&commuting_parking=5000')).body;
  ok(parkNear.earnings?.non_taxable === 0,
     'under 2km one way the parking addition does not apply either',
     `${parkNear.earnings?.non_taxable}`);

  // 併用でも加算され、合計15万が上限であることは変わらない。
  const parkBoth = (await p('monthly_salary=300000&commuting_allowance=60000&commuting_distance_km=25&commuting_fare=30000&commuting_parking=4000')).body;
  ok(parkBoth.earnings?.non_taxable === 19700 + 30000 + 4000,
     'combined: 19,700 band + 30,000 fare + 4,000 parking = 53,700',
     `${parkBoth.earnings?.non_taxable}`);

  // 駐車場代の加算は交通用具通勤の制度なので、距離が無ければ意味を成さない。
  ok((await p('monthly_salary=300000&commuting_allowance=12000&commuting_parking=3000')).status === 400,
     'parking with no distance is refused');
  ok((await p('monthly_salary=300000&commuting_parking=3000')).status === 400,
     'parking with no commuting allowance is refused');
  ok((await p('monthly_salary=300000&commuting_allowance=12000&commuting_distance_km=12&commuting_parking=-1')).status === 400,
     'a negative parking cost is refused');

  // 距離だけ渡して手当を渡さないのは指定誤り。
  ok((await p('monthly_salary=300000&commuting_distance_km=12')).status === 400,
     'a distance with no allowance is refused');
  ok((await p('monthly_salary=300000&commuting_allowance=-1')).status === 400,
     'a negative commuting allowance is refused');
  ok((await p('monthly_salary=300000&commuting_allowance=10000&commuting_distance_km=-3')).status === 400,
     'a negative distance is refused');
}

// --- 支給項目を配列で受け、賃金台帳が作れる内訳を返すこと (F-16) ---
{
  const post = async (body) => {
    const r = await tryFetch(BASE + '/v1/payroll/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    return { status: r.status, body: await r.json() };
  };

  const r = await post({
    defaults: { prefecture: 'Tokyo', age: 42 },
    employees: [{
      id: 'e1', monthly_salary: 300000, standard_remuneration: 340000,
      allowances: [
        { name: '通勤手当', amount: 15000, kind: 'commuting' },
        { name: '役職手当', amount: 30000, kind: 'taxable' },
        { name: '出張旅費', amount: 8000, kind: 'reimbursement' },
      ],
    }],
  });
  ok(r.status === 200, 'a row can carry named pay items', JSON.stringify(r.body).slice(0, 200));
  const row = r.body.results?.[0] ?? {};
  const e = row.earnings ?? {};

  // 300,000 + 15,000 + 30,000 + 8,000 = 353,000
  ok(e.gross === 353000, 'gross is every item paid', `${e.gross}`);
  // 課税: 基本給 300,000 + 役職手当 30,000
  ok(e.taxable === 330000, 'commuting under the ceiling and reimbursement are not taxed', `${e.taxable}`);
  ok(e.non_taxable === 23000, '15,000 + 8,000 = 23,000', `${e.non_taxable}`);
  // 報酬: 実費弁償は労務の対償ではないので外れる。300,000 + 15,000 + 30,000
  ok(e.remuneration_basis === 345000,
     'a reimbursement is not remuneration and not wages', `${e.remuneration_basis}`);
  ok(e.employment_insurance_basis === 345000, 'the same total is the wage base',
     `${e.employment_insurance_basis}`);

  // 明細に出せる形で並んでいること。
  ok(Array.isArray(e.items) && e.items.length === 4,
     'the base pay is itemised alongside the allowances', `${e.items?.length}`);
  ok(e.items?.[0]?.name === '基本給' && e.items?.[0]?.amount === 300000,
     'starting with the base pay', JSON.stringify(e.items?.[0]));
  ok(e.items?.[1]?.non_taxable === 15000 && e.items?.[1]?.taxable === 0,
     'each item carries its own taxable / non-taxable split', JSON.stringify(e.items?.[1]));
  ok(e.items?.[3]?.remunerative === false,
     'and whether it counts as remuneration', JSON.stringify(e.items?.[3]));

  // 渡した標準報酬月額が batch でも効くこと(単発と同じ口が無かった)。
  ok(row.standard_remuneration?.health === 340000,
     'a batch row can fix its own standard remuneration', `${row.standard_remuneration?.health}`);

  // 集計にも支給内訳が出ること。
  ok(r.body.summary?.gross === 353000, 'the run summary totals the same gross', `${r.body.summary?.gross}`);
  ok(r.body.summary?.taxable === 330000, 'and the taxable part', `${r.body.summary?.taxable}`);
  ok(r.body.summary?.non_taxable === 23000, 'and the non-taxable part', `${r.body.summary?.non_taxable}`);

  // 役員は batch でも雇用保険を引かない。
  const dir = await post({
    defaults: { prefecture: 'Tokyo', age: 42 },
    employees: [{ monthly_salary: 800000, employment_type: 'director' }],
  });
  ok(dir.body.results?.[0]?.deductions?.employment_insurance?.employee === 0,
     'a batch row can say the person is a director',
     JSON.stringify(dir.body.results?.[0]?.deductions?.employment_insurance));

  // 不正な項目は行ごとに落ちる。
  const badRow = await post({
    defaults: { prefecture: 'Tokyo', age: 42 },
    employees: [{ monthly_salary: 300000, allowances: [{ name: 'x', amount: 1000, kind: 'nonsense' }] }],
  });
  ok(badRow.body.errors?.length === 1, 'an unknown allowance kind fails its own row',
     JSON.stringify(badRow.body.errors));
  ok(/nonsense/.test(badRow.body.errors?.[0]?.error ?? ''), 'and says which one',
     badRow.body.errors?.[0]?.error);
}

// --- 労災保険 (F-02): 全額事業主負担 ---
// バー: 厚生労働省 労災保険率表(令和6年度~、令和8年度も同率)、
// 徴収法第12条第2項・同法施行規則第16条及び別表第1。
// 事業主負担の総額を名乗る以上、これが欠けていると総額が必ず不足する。
{
  const list = await get('/v1/workers-compensation');
  ok(list.status === 200, 'the rate table is published', `${list.status}`);
  ok(list.body.business_types?.length === 55,
     '54 事業の種類 plus 船舶所有者の事業', `${list.body.business_types?.length}`);

  // 公表された率そのもの。1/1000単位で印刷されている値と一致すること。
  const rateOf = (n) => list.body.business_types.find((b) => b.number === n)?.rate_per_1000;
  for (const [num, per1000] of [
    ['02', 52],   // 林業
    ['12', 37],   // 定置網漁業又は海面魚類養殖業
    ['21', 88],   // 金属鉱業、非金属鉱業又は石炭鉱業 — 表の最大
    ['24', 2.5],  // 原油又は天然ガス鉱業 — 表の最小に並ぶ
    ['35', 9.5],  // 建築事業
    ['41', 5.5],  // 食料品製造業
    ['59', 23],   // 船舶製造又は修理業
    ['81', 3],    // 電気、ガス、水道又は熱供給の事業
    ['94', 3],    // その他の各種事業
    ['98', 3],    // 卸売業・小売業、飲食店又は宿泊業
    ['99', 2.5],  // 金融業、保険業又は不動産業
    ['90', 42],   // 船舶所有者の事業
  ]) {
    ok(rateOf(num) === per1000, `事業の種類 ${num} is ${per1000}/1000`, `${rateOf(num)}`);
  }

  // 率の開きが大きいので既定値を置けない、という前提そのものを確かめる。
  const rates = list.body.business_types.map((b) => b.rate_per_1000);
  ok(Math.max(...rates) === 88 && Math.min(...rates) === 2.5,
     'the table spans 2.5 to 88 per 1000 — 35 times, so there is no safe default',
     `${Math.min(...rates)}-${Math.max(...rates)}`);

  // 賃金総額を渡せば保険料が出る。3,000,000 * 3/1000 = 9,000。
  const one = (await get('/v1/workers-compensation?business_type=98&wage_total=3000000')).body;
  ok(one.premium?.employer === 9000, '3,000,000 * 3/1000 = 9,000', `${one.premium?.employer}`);
  ok(one.premium?.employee === 0, 'and none of it comes out of the employee',
     `${one.premium?.employee}`);

  // 1桁で渡しても同じ行を引く(表は2桁で印刷されている)。
  ok((await get('/v1/workers-compensation?business_type=2')).body.business_type?.number === '02',
     'a single digit resolves to the two-digit row');
  ok((await get('/v1/workers-compensation?business_type=07')).status === 400,
     'a number that is not in the table is refused');

  // 給与計算に組み込むと事業主負担の総額に入ること。
  const p = (q) => get(`/v1/payroll?prefecture=Tokyo&age=42&monthly_salary=300000&${q}`);
  const without = (await p('income_tax=false')).body;
  const with98 = (await p('income_tax=false&workers_comp_type=98')).body;

  ok(without.deductions.workers_compensation === undefined,
     'without a business type no workers compensation is invented');
  ok(without.totals.workers_compensation_employer === 0,
     'and the employer figure says so plainly',
     `${without.totals.workers_compensation_employer}`);

  // 300,000 * 3/1000 = 900
  ok(with98.deductions.workers_compensation?.employer === 900,
     '300,000 * 3/1000 = 900', `${with98.deductions.workers_compensation?.employer}`);
  ok(with98.deductions.workers_compensation?.employee === 0,
     'the employee pays none of it', `${with98.deductions.workers_compensation?.employee}`);
  ok(with98.totals.employer_cost === with98.totals.gross
       + with98.totals.social_insurance_employer + 900,
     'employer_cost is pay plus the employer social insurance share plus workers compensation',
     `${with98.totals.employer_cost}`);
  ok(with98.totals.employer_cost - without.totals.employer_cost === 900,
     'which is exactly what was missing before',
     `${with98.totals.employer_cost - without.totals.employer_cost}`);

  // 労働者にかかる保険なので、役員には課さない(雇用保険と同じ扱い)。
  const dir = (await p('income_tax=false&workers_comp_type=98&employment_type=director')).body;
  ok(dir.totals.workers_compensation_employer === 0,
     'a director is not a 労働者, so no workers compensation is charged',
     `${dir.totals.workers_compensation_employer}`);

  // 賃金総額が基礎なので、通勤手当を足すと保険料も増える。315,000 * 3/1000 = 945。
  const comm = (await p('income_tax=false&workers_comp_type=98&commuting_allowance=15000')).body;
  ok(comm.deductions.workers_compensation?.employer === 945,
     '315,000 * 3/1000 = 945 — the commuting allowance is part of 賃金総額',
     `${comm.deductions.workers_compensation?.employer}`);

  // 綴り間違いは黙って無視しない。
  ok((await p('workers_comp_type=999')).status === 400,
     'an unknown workers_comp_type is refused rather than dropped');
}

// --- 料率の時点指定 (F-29 / F-30) ---
// 過去・未来の日付で現行料率を黙って返すと、間違いに気づく手がかりが1つも無い。
{
  const win = (await get('/v1/insurance-rates?prefecture=Tokyo')).body.applies;
  ok(win?.from === '2026-03-01' && win?.through === '2027-02-28',
     'the response says which period the rates are for', JSON.stringify(win));

  // 範囲内は通る。
  ok((await get('/v1/insurance-rates?prefecture=Tokyo&as_of=2026-06-01')).status === 200,
     'a date inside the published period is answered');

  // 過去の日付は422。以前は現行料率が黙って返っていた。
  const past = await get('/v1/insurance-rates?prefecture=Tokyo&as_of=2024-05-01');
  ok(past.status === 422, 'an earlier date is refused, not answered with this year rates',
     `${past.status}`);
  ok(past.body.code === 'out_of_coverage', 'with a code a client can branch on', past.body.code);
  ok(past.body.coverage?.from === '2026-03-01', 'and says what is published instead',
     JSON.stringify(past.body.coverage));

  // 未来の日付も同じ。料率は毎年3月に変わるので、来年分は載っていない。
  ok((await get('/v1/insurance-rates?prefecture=Tokyo&as_of=2028-01-01')).status === 422,
     'a date past the published period is refused too');

  // 雇用保険料率は年度で切り替わる。
  ok((await get('/v1/employment-insurance?as_of=2026-05-01')).status === 200,
     'employment insurance answers inside its fiscal year');
  ok((await get('/v1/employment-insurance?as_of=2026-03-31')).status === 422,
     'and refuses the day before it takes effect');
  ok((await get('/v1/employment-insurance?as_of=2027-04-01')).status === 422,
     'and the day after the fiscal year ends');

  // 労災保険率は令和6年4月1日施行で、令和8年度も同率。
  ok((await get('/v1/workers-compensation?as_of=2025-01-01')).status === 200,
     'workers compensation rates cover from 2024-04-01');
  ok((await get('/v1/workers-compensation?as_of=2024-03-31')).status === 422,
     'but not before the revision took effect');

  // 給与計算そのものも、載っていない時点で回してはいけない。
  const oldRun = await get('/v1/payroll?prefecture=Tokyo&age=42&monthly_salary=300000&as_of=2024-05-01');
  ok(oldRun.status === 422, 'payroll refuses to run a month it has no rates for',
     `${oldRun.status}`);
  ok(oldRun.body.code === 'out_of_coverage', 'for the same reason and with the same code',
     oldRun.body.code);

  // birth_date と as_of を組み合わせた年齢判定は、範囲内なら従来どおり動く。
  ok((await get('/v1/payroll?prefecture=Tokyo&birth_date=1960-01-01&monthly_salary=300000&as_of=2026-06-01')).status === 200,
     'inside the window as_of still drives the age milestones');
}
// ---- 45. 通勤手当の非課税限度額を単独で引けること ----
{
  const ca = async (qs) => {
    const r = await tryFetch(`${BASE}/v1/commuting-allowance${qs ? '?' + qs : ''}`);
    return { status: r.status, body: await r.json() };
  };

  const table = (await ca('')).body;
  ok(table.reference?.transit?.ceiling === 150000,
     'the transit ceiling is 150,000 a month', `${table.reference?.transit?.ceiling}`);
  ok(table.reference?.vehicle?.bands?.length === 12,
     'the distance table has all twelve bands, under 2km up to 95km and over',
     `${table.reference?.vehicle?.bands?.length}`);
  ok(table.reference?.parking?.cap === 5000,
     'the parking addition is capped at 5,000 — the statute says 五千円, not 五万円',
     `${table.reference?.parking?.cap}`);

  // 令和7年11月19日公布の政令が令和7年4月1日に遡って適用された。写した表が腐る実例。
  ok(table.revisions?.some((r) => r.effective_from === '2025-04-01' && /遡/.test(r.summary ?? '')),
     'the April 2025 revision is recorded, and recorded as retroactive');
  ok(table.revisions?.some((r) => r.effective_from === '2026-04-01'),
     'and so is the April 2026 revision that added the 65km bands');

  // 改正後の額であること。改正前は 7,100 / 12,900 / 18,700 だった。
  const band = (km) => table.reference.vehicle.bands.find(
    (b) => km >= b.from_km && (b.to_km === null || km < b.to_km));
  ok(band(12).limit === 7300, '10-15km is 7,300 after the revision, not the old 7,100', `${band(12).limit}`);
  ok(band(20).limit === 13500, '15-25km is 13,500, not the old 12,900', `${band(20).limit}`);
  ok(band(30).limit === 19700, '25-35km is 19,700, not the old 18,700', `${band(30).limit}`);
  ok(band(100).limit === 66400, '95km and over is 66,400', `${band(100).limit}`);
  ok(band(1).limit === 0, 'under 2km one way nothing is exempt', `${band(1).limit}`);

  const car = (await ca('amount=12000&distance_km=12&parking=3000')).body;
  ok(car.non_taxable === 7300 + 3000 && car.taxable === 12000 - 10300,
     'a 12km commute with 3,000 parking exempts 10,300 and taxes 1,700',
     `${car.non_taxable} / ${car.taxable}`);

  // 非課税でも社会保険では報酬。ここが分かれるのが給与計算の核心。
  ok(car.social_insurance?.remuneration === 12000,
     'the whole allowance is still remuneration for social insurance',
     `${car.social_insurance?.remuneration}`);

  const transit = (await ca('amount=200000')).body;
  ok(transit.non_taxable === 150000 && transit.taxable === 50000,
     'a 200,000 train pass is exempt only up to 150,000', `${transit.non_taxable}`);

  ok((await ca('distance_km=12')).status === 400, 'a distance with no amount is refused');
  ok((await ca('amount=10000&parking=3000')).status === 400, 'parking with no distance is refused');
  ok((await ca('amount=-1')).status === 400, 'a negative amount is refused');
  ok((await ca('amount=10000&bogus=1')).status === 400, 'an unknown parameter is refused');
}
// ---- 46. 公開面の整合 — 実装・ルート一覧・OpenAPI が食い違わないこと ----
{
  // 実装はあるが一覧に無い、あるいは仕様書に無いエンドポイントは、存在しないのと
  // 同じになる。第2反復で /v1/overtime-pay と /v1/workers-compensation が
  // まさにその状態だった。割増賃金は作ったのに RapidAPI の出品面に出ていなかった。
  const root = await (await tryFetch(`${BASE}/`)).json();
  const spec = await (await tryFetch(`${BASE}/openapi.json`)).json();

  const listed = new Set(
    Object.keys(root.endpoints ?? {})
      .map((k) => /^(?:GET|POST)\s+(\/\S*)/.exec(k)?.[1])
      .filter(Boolean)
      .map((p) => p.split('?')[0]),
  );
  const specced = new Set(Object.keys(spec.paths ?? {}));

  // 仕様書に載っているものは、すべてルート一覧からも辿れること。
  const unlisted = [...specced].filter((p) => p.startsWith('/v1') && !listed.has(p));
  ok(unlisted.length === 0,
     'every documented endpoint is discoverable from the root listing',
     unlisted.join(', ') || 'none');

  // ルート一覧のものは、すべて仕様書にあること(RapidAPI の購読者に見える面)。
  const undocumented = [...listed].filter((p) => p.startsWith('/v1') && !specced.has(p));
  ok(undocumented.length === 0,
     'and every listed endpoint reaches the OpenAPI spec, so subscribers can see it',
     undocumented.join(', ') || 'none');

  // 一覧に書いた経路が実際に応答すること(404を出品しない)。
  for (const path of ['/v1/commuting-allowance', '/v1/overtime-pay', '/v1/workers-compensation']) {
    const r = await tryFetch(`${BASE}${path}`);
    ok(r.status !== 404, `${path} answers rather than 404`, `${r.status}`);
  }
}
// ---- 47. 介護保険は年齢が要件なので、年齢なしで払える答えは無い (F-05) ----
// バー: 介護保険法第9条。第1号被保険者は「六十五歳以上の者」、第2号被保険者は
// 「四十歳以上六十五歳未満の医療保険加入者」。年齢が徴収義務そのものを決める。
//
// 年齢を渡さないと介護保険なしで計算し、200を返していた。45歳・月給30万・東京なら
// 介護保険の本人負担は 300,000 * 0.0162 / 2 = 2,430円。これがそのまま毎月の
// 過少徴収になり、しかも返り値のどこにも警告が出ない。非専門の利用者は
// 「年齢が要る」ことを知らないので、間違いに気づく手がかりが無い。
{
  const noAge = await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000');
  ok(noAge.status === 400,
     'a payslip with neither age nor birth_date is refused, not answered', `${noAge.status}`);
  ok(noAge.body.code === 'missing_parameter',
     'and it is reported as a missing parameter', noAge.body.code);
  ok(/介護保険法第9条/.test(noAge.body.hint ?? ''),
     'the refusal cites the article that makes age the test', noAge.body.hint);
  ok(/40/.test(noAge.body.hint ?? ''),
     'and names the threshold the caller has to answer for', noAge.body.hint);

  // どちらか一方があれば通る。
  ok((await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=45')).status === 200,
     'age alone is enough');
  ok((await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000&birth_date=1981-05-01')).status === 200,
     'and birth_date alone is enough');

  // 過少徴収の実額。40歳未満と40-64歳の差は、まるまる介護保険の本人負担。
  const at45 = (await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=45')).body;
  const at30 = (await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=30')).body;
  ok(at45.coverage.long_term_care === true && at30.coverage.long_term_care === false,
     '45 is a 第2号被保険者 and 30 is not',
     `${at45.coverage.long_term_care} / ${at30.coverage.long_term_care}`);
  ok(at45.totals.social_insurance_employee - at30.totals.social_insurance_employee
       === 300000 * 0.0162 / 2,
     'the gap is exactly the long-term care half: 300,000 * 0.0162 / 2 = 2,430',
     `${at45.totals.social_insurance_employee - at30.totals.social_insurance_employee}`);

  // 65歳以上は第1号被保険者になり、給与からの徴収は止まる。
  const at66 = (await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=66')).body;
  ok(at66.coverage.long_term_care === false,
     'at 65 the person becomes a 第1号被保険者 and payroll stops collecting it',
     `${at66.coverage.long_term_care}`);

  // 賞与も同じ法理。ここだけ通してしまうと片肺になる。
  const bonusNoAge = await get('/v1/bonus-insurance?prefecture=Tokyo&bonus=500000');
  ok(bonusNoAge.status === 400,
     'a bonus with neither age nor birth_date is refused too', `${bonusNoAge.status}`);
  ok((await get('/v1/bonus-insurance?prefecture=Tokyo&bonus=500000&age=45')).status === 200,
     'and answers once the age is given');

  // バッチは実際の給与計算が通る経路なので、ここが抜けていると意味がない。
  const batch = await tryFetch(BASE + '/v1/payroll/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      defaults: { prefecture: 'Tokyo' },
      employees: [
        { id: 'has-age', monthly_salary: 300000, age: 45 },
        { id: 'no-age', monthly_salary: 300000 },
      ],
    }),
  });
  const batchBody = await batch.json();
  const okIds = new Set((batchBody.results ?? []).map((r) => r.id));
  const errById = Object.fromEntries((batchBody.errors ?? []).map((e) => [e.id, e]));
  ok(okIds.has('has-age'), 'a batch row carrying an age still computes',
     JSON.stringify(batchBody.errors));
  ok(!okIds.has('no-age') && errById['no-age'] !== undefined,
     'while a row without one fails that row instead of guessing',
     JSON.stringify(batchBody.errors));
  ok(errById['no-age']?.code === 'missing_parameter',
     'and the whole run does not fail with it — one bad row is one error',
     `failed=${batchBody.failed} succeeded=${batchBody.succeeded}`);
  ok(/age|birth_date/.test(errById['no-age']?.error ?? ''),
     'the error says which parameter was missing', errById['no-age']?.error);
  ok(/介護保険法第9条/.test(errById['no-age']?.error ?? ''),
     'and cites the article that makes it required', errById['no-age']?.error);

  // defaults に置けば行ごとに書かなくてよい。全員分を1つずつ書かせるのは現実的でない。
  const viaDefaults = await tryFetch(BASE + '/v1/payroll/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      defaults: { prefecture: 'Tokyo', age: 45 },
      employees: [{ id: 'inherits', monthly_salary: 300000 }],
    }),
  });
  const inheritedBody = await viaDefaults.json();
  const inherited = inheritedBody.results?.[0];
  ok(inherited !== undefined && inherited.coverage?.long_term_care === true,
     'a birth_date in defaults is inherited by every row, and batch now accepts one at all',
     JSON.stringify(inheritedBody.errors));
}
// ---- 48. 定時決定をまとめて回せること (F-10) ----
// バー: 健康保険法第41条。保険者は7月1日現に使用される事業所において、その年の
// 4月・5月・6月に受けた報酬の総額を「その月数で除して」報酬月額とし、決まった
// 標準報酬月額をその年の9月から翌年8月まで適用する。支払基礎日数17日も同条にある。
//
// つまり算定基礎届は「6月に全社員分を一度に」出すもので、1人ずつ問う場面が無い。
// 給与には POST /v1/payroll/batch があるのに判定系には無く、200人なら200回。
// 単発の口はあるのに、実務が通る口が無いという同じ形の欠落が3度目になる。
{
  const post = async (body, q = '') => {
    const r = await tryFetch(`${BASE}/v1/standard-remuneration/regular/batch${q}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    return { status: r.status, body: await r.json() };
  };

  const m = (r, d = 30) => ({ remuneration: r, payment_basis_days: d });

  const run = await post({
    employees: [
      // 昇給して等級が上がる人。
      { id: 'up', months: [m(350000), m(352000), m(349000)], previous_remuneration: 300000 },
      // 変わらない人。
      { id: 'same', months: [m(300000), m(300000), m(300000)], previous_remuneration: 300000 },
      // 17日未満の月がある人。その月は除いて平均する。
      { id: 'short', months: [m(300000), m(300000, 10), m(300000)], previous_remuneration: 300000 },
    ],
  });

  ok(run.status === 200, 'the regular determination runs as a batch', `${run.status}`);
  ok(run.body.succeeded === 3 && run.body.failed === 0, 'all three employees are decided',
     `${run.body.succeeded}/${run.body.failed}`);

  const by = Object.fromEntries((run.body.results ?? []).map((r) => [r.id, r]));

  // 単発と完全に一致すること。別経路で別の答えが出るなら意味がない。
  const single = (await get('/v1/standard-remuneration/regular?months=350000:30,352000:31,349000:30')).body;
  ok(by.up?.schemes?.health?.grade === single.schemes.health.grade
       && by.up?.schemes?.pension?.grade === single.schemes.pension.grade,
     'a batch row agrees with the single-employee endpoint exactly',
     `${JSON.stringify(by.up?.schemes)} vs ${JSON.stringify(single.schemes)}`);

  // 17日未満は算定から外れる (健保法41条)。3月とも30万なら平均は30万のまま。
  ok(by.short?.months_used === 2,
     'a month under 17 payment-basis days drops out of the average',
     `${by.short?.months_used}`);
  ok(by.short?.average_remuneration === 300000,
     'and the average is taken over the months that remain', `${by.short?.average_remuneration}`);

  // 6月の実務は「誰の等級が動くか」を知ること。それが一覧で出ること。
  ok(run.body.summary?.employees === 3, 'the summary counts the decided employees',
     `${run.body.summary?.employees}`);
  ok(run.body.summary?.changed === 1 && run.body.summary?.unchanged === 2,
     'and separates who moves grade from who does not',
     JSON.stringify(run.body.summary));
  ok(by.up?.changed === true && by.same?.changed === false,
     'each row says whether that employee moved', `${by.up?.changed} / ${by.same?.changed}`);

  // 適用期間は条文どおり その年の9月から翌年8月まで。
  ok(/9月/.test(JSON.stringify(run.body.applies ?? '')) || run.body.applies?.from_month === 9,
     'the run states the September start the article fixes',
     JSON.stringify(run.body.applies));

  // 壊れた行は、その行だけ落ちて残りは通る。
  const mixed = await post({
    employees: [
      { id: 'ok', months: [m(300000), m(300000), m(300000)] },
      { id: 'twomonths', months: [m(300000), m(300000)] },
      { id: 'notarray', months: 'nonsense' },
      { id: 'badtype', months: [m(300000), m(300000), m(300000)], worker_type: 'nonsense' },
    ],
  });
  ok(mixed.status === 200, 'a partial failure is still a 200', `${mixed.status}`);
  ok(mixed.body.succeeded === 1 && mixed.body.failed === 3, 'one row survives',
     `${mixed.body.succeeded}/${mixed.body.failed}`);
  ok(mixed.body.errors.every((e) => Number.isInteger(e.index)), 'errors carry the input index');
  ok(mixed.body.errors.find((e) => e.id === 'badtype') !== undefined,
     'an unusable worker_type fails its own row', JSON.stringify(mixed.body.errors));

  // defaults は行ごとの記述を省くためのもの。
  const viaDefaults = await post({
    defaults: { worker_type: 'part_time_short_hours' },
    employees: [{ id: 'p', months: [m(120000, 15), m(120000, 15), m(120000, 15)] }],
  });
  ok(viaDefaults.body.results?.[0]?.worker_type === 'part_time_short_hours',
     'a worker_type in defaults is inherited by every row',
     JSON.stringify(viaDefaults.body.errors ?? viaDefaults.body.results?.[0]?.worker_type));

  // 入力の検査。
  ok((await post({ employees: [] })).status === 400, 'an empty run is refused');
  ok((await post({ employees: {} })).status === 400, 'a non-array is refused');
  ok((await post({})).status === 400, 'a missing employees key is refused');
}
// ---- 49. 改定日を過ぎた最低賃金を「最新」と言わないこと (F-09) ----
// バー: 最低賃金法第4条 — 最低賃金額に達しない賃金を定める労働契約は「無効とする」、
// 無効となった部分は最低賃金と同様の定をしたものと「みなす」。第14条 — 効力は
// 「公示」の日から起算して「三十日」を経過した日に生じ、「別に定める」こともできる。
//
// 誤答の帰結が契約の無効である以上、古い額を最新として返すのは重い。地域別最低賃金は
// 毎年10月に改定され、このデータが更新されないまま10月1日を過ぎると、勤怠SaaSは
// 違法な賃金を「適法」と表示する。データが無いときに黙って前年の額を返すのではなく、
// 答えられないと言う必要がある。
{
  const mw = (q) => get(`/v1/minimum-wage?${q}`);

  // 改定日より前は従来どおり答える。
  const before = await mw('prefecture=Tokyo&date=2026-09-30');
  ok(before.status === 200, 'a date before the revision is answered', `${before.status}`);
  ok(before.body.fiscal_year === 2025, 'with the FY2025 figure', `${before.body.fiscal_year}`);

  // 改定予定日以降は、データが追いついていない限り拒否する。
  const fresh = (await get('/v1/data-freshness')).body;
  const mwSet = (fresh.datasets ?? []).find((d) => d.key === 'minimum_wage');
  const nextRevision = mwSet?.next_revision_expected;
  ok(typeof nextRevision === 'string', 'the dataset states when it is next due', `${nextRevision}`);

  const after = await mw(`prefecture=Tokyo&date=${nextRevision}`);
  const covered = before.body.fiscal_year >= Number(String(nextRevision).slice(0, 4));
  if (!covered) {
    ok(after.status === 422,
       'a date on or after the revision is refused while the data still stops short',
       `${after.status}`);
    ok(after.body.code === 'out_of_coverage', 'with a code a client can branch on', after.body.code);
    ok(/最低賃金法/.test(after.body.hint ?? '') || /最低賃金法/.test(after.body.error ?? ''),
       'and says why a stale figure is not a safe answer',
       `${after.body.hint ?? after.body.error}`);
    ok(after.body.coverage?.through !== undefined,
       'the response names how far the data actually reaches',
       JSON.stringify(after.body.coverage));

    // 全都道府県で同じであること。1県だけ通ると気づけない。
    for (const p of ['Osaka', 'Okinawa', 'Akita']) {
      const r = await mw(`prefecture=${p}&date=${nextRevision}`);
      ok(r.status === 422, `${p} refuses the same date`, `${r.status}`);
    }
  } else {
    ok(after.status === 200,
       'once the data covers the revision the same date answers again', `${after.status}`);
  }

  // 履歴は過去の話なので、前縁の欠落とは無関係に引ける。
  const hist = await get('/v1/minimum-wage/history?prefecture=Tokyo');
  ok(hist.status === 200, 'the history is unaffected by the forward edge', `${hist.status}`);
  ok(hist.body.history?.length >= 24, 'and still carries every year on record',
     `${hist.body.history?.length}`);

  // 日付を渡さない既定は「今日」。今日が改定日を越えたら同じ扱いになる。
  const today = new Date().toISOString().slice(0, 10);
  const bare = await mw('prefecture=Tokyo');
  ok(today < String(nextRevision) ? bare.status === 200 : bare.status === 422,
     'the default date follows the same rule as an explicit one',
     `today=${today} next=${nextRevision} status=${bare.status}`);
}
// ---- 50. 被保険者区分そのものを判定すること (F-18) ----
// バー: 健康保険法第3条第1項第9号。本文に「四分の三」「通常の労働者」「同一の事業所」
// 「一月間の所定労働日数」があり、イに「一週間の所定労働時間が二十時間未満であること」、
// ロが労働基準法第4条第3項各号の賃金を除いた月額(八万八千円未満)、ハが学校教育法の学生。
// 特定適用事業所の人数要件は同条には無く、日本年金機構の公表(被保険者総数51人以上、
// 1年のうち6月間以上見込み)による。
//
// この分類を利用者に決めさせていたため、間違えると支払基礎日数の閾値が17日と11日で
// 入れ替わり、定時決定が無警告で誤答になっていた。一番間違えやすい判断を丸投げしていた。
{
  const wt = (q) => get(`/v1/worker-type?${q}`);

  // 4分の3を満たす通常の労働者。
  const full = (await wt('weekly_hours=40&normal_weekly_hours=40')).body;
  ok(full.insured === true && full.worker_type === 'general',
     'a full-time worker is an ordinary insured person',
     `${full.insured} / ${full.worker_type}`);
  ok(full.payment_basis_threshold === 17,
     'and 定時決定 counts months of 17 payment-basis days', `${full.payment_basis_threshold}`);

  // ちょうど4分の三。30/40 = 0.75 なので満たす側。
  const exactly = (await wt('weekly_hours=30&normal_weekly_hours=40')).body;
  ok(exactly.insured === true && exactly.worker_type === 'part_time_short_hours',
     'exactly three-quarters still clears the 四分の三 test, as a 短時間就労者',
     `${exactly.insured} / ${exactly.worker_type}`);
  ok(exactly.payment_basis_threshold === 17,
     'a 短時間就労者 is still judged on 17 days', `${exactly.payment_basis_threshold}`);

  // 4分の三未満 + 4要件すべて充足 → 短時間労働者(11日)。
  const short = (await wt(
    'weekly_hours=25&normal_weekly_hours=40&monthly_wage=100000&is_student=false&workplace_insured_count=51&employment_months=12')).body;
  ok(short.insured === true && short.worker_type === 'short_time_insured',
     'under three-quarters but meeting all four tests is a 短時間労働者',
     `${short.insured} / ${short.worker_type}`);
  ok(short.payment_basis_threshold === 11,
     'and that is the classification judged on 11 days, not 17',
     `${short.payment_basis_threshold}`);

  // 各要件を1つずつ落とす。落ちた理由が名指しされること。
  const fails = [
    ['weekly_hours=15&normal_weekly_hours=40&monthly_wage=100000&workplace_insured_count=51&employment_months=12',
     'weekly_hours', 'under 20 hours a week'],
    ['weekly_hours=25&normal_weekly_hours=40&monthly_wage=80000&workplace_insured_count=51&employment_months=12',
     'monthly_wage', 'under 88,000 a month'],
    ['weekly_hours=25&normal_weekly_hours=40&monthly_wage=100000&is_student=true&workplace_insured_count=51&employment_months=12',
     'is_student', 'a student'],
    ['weekly_hours=25&normal_weekly_hours=40&monthly_wage=100000&workplace_insured_count=40&employment_months=12',
     'workplace_insured_count', 'a workplace under the headcount'],
    ['weekly_hours=25&normal_weekly_hours=40&monthly_wage=100000&workplace_insured_count=51&employment_months=2',
     'employment_months', 'an engagement of two months or less'],
  ];
  for (const [q, key, label] of fails) {
    const r = (await wt(q)).body;
    ok(r.insured === false, `${label} is not insured`, `${r.insured} / ${r.worker_type}`);
    const failed = (r.tests ?? []).filter((t) => t.passed === false).map((t) => t.key);
    ok(failed.includes(key), `and the response names ${key} as the test that failed`,
       JSON.stringify(failed));
  }

  // 判定の根拠が条文で示されること。丸投げをやめた以上、根拠は返す必要がある。
  ok((short.tests ?? []).every((t) => typeof t.basis === 'string' && t.basis.length > 0),
     'every test carries the provision it rests on',
     JSON.stringify((short.tests ?? []).map((t) => t.key)));
  ok(JSON.stringify(short).includes('健康保険法第3条'),
     'and the article itself is cited');

  // 8.8万円に算入しない賃金。ここを足して判定すると通ってしまう人が出る。
  ok(/割増賃金|残業|通勤手当|賞与/.test(JSON.stringify(short.notes ?? {})),
     'the response says which pay is left out of the 88,000',
     JSON.stringify(short.notes ?? {}).slice(0, 200));

  // 人数要件は段階的に下がる。写した数字が腐る類の値なので、予定を返す。
  ok(Array.isArray(short.headcount_schedule) && short.headcount_schedule.length >= 2,
     'the staged reduction of the headcount threshold is reported',
     JSON.stringify(short.headcount_schedule));

  // 判定結果は定時決定にそのまま渡せること。両者が食い違うと意味がない。
  const reg = (await get(
    `/v1/standard-remuneration/regular?months=120000:12,120000:12,120000:12&worker_type=${short.worker_type}`)).body;
  ok(reg.payment_basis_threshold === short.payment_basis_threshold,
     'the threshold this endpoint returns is the one the determination uses',
     `${reg.payment_basis_threshold} vs ${short.payment_basis_threshold}`);
  ok(reg.months_used === 3,
     'so a 12-day month counts for a 短時間労働者 where it would not for anyone else',
     `${reg.months_used}`);

  // 入力の検査。
  ok((await wt('')).status === 400, 'weekly_hours is required');
  ok((await wt('weekly_hours=-1')).status === 400, 'a negative weekly_hours is refused');
  ok((await wt('weekly_hours=25&normal_weekly_hours=0')).status === 400,
     'a normal_weekly_hours of zero is refused — it would divide by nothing');
  ok((await wt('weekly_hours=25&bogus=1')).status === 400, 'an unknown parameter is refused');
}
// ---- 51. 算定基礎届の提出対象かどうかを判定すること (F-17) ----
// バー: 健康保険法第41条。条文に次の文言がある(e-Gov 211AC0000000070 より確認)。
//   「六月一日から七月一日までの間に被保険者の資格を取得した者」
//   「七月から九月までのいずれかの月から標準報酬月額を改定され」
//   「改定されるべき被保険者」
// さらに本文は「毎年七月一日現に使用される事業所において」と基準日を置く。
// つまり4つの対象外は条文から導ける。文章で列挙するだけでは、200人分を選り分ける
// 6月の作業は終わらない。
{
  const reg = (q) => get(`/v1/standard-remuneration/regular?months=350000:30,352000:31,349000:30&${q}`);

  // 条文は「決定する」を原則とし除外を例外に置くので、除外に当たらなければ提出対象。
  // 何を確かめた上での結論かは checked に出す。随時改定が無い人には revision_month に
  // 入れる値がそもそも無いので、渡っていないことを理由に判定不能にはしない。
  const plain = (await reg('year=2026')).body;
  ok(plain.submission?.required === true,
     'with no exclusion supplied the employee is filed, as the article makes filing the rule',
     JSON.stringify(plain.submission));
  ok(Array.isArray(plain.submission?.checked) && plain.submission.checked.length === 3,
     'and the response says which three exclusions it evaluated',
     JSON.stringify(plain.submission?.checked));
  ok(plain.submission.checked.every((t) => typeof t === 'string' && t.length > 0),
     'each one stated rather than left implicit');

  // 6月1日から7月1日までに資格取得した人は対象外。
  const midJune = (await reg('year=2026&acquired_on=2026-06-15')).body;
  ok(midJune.submission?.required === false,
     'someone who became insured on 15 June is not filed',
     JSON.stringify(midJune.submission));
  ok(/六月一日から七月一日までの間に被保険者の資格を取得した者/.test(midJune.submission?.basis ?? ''),
     'and the article wording is quoted', midJune.submission?.basis);

  // 5月31日取得は対象。境界を1日ずらすと結論が変わる。
  const may31 = (await reg('year=2026&acquired_on=2026-05-31')).body;
  ok(may31.submission?.required === true,
     'acquiring on 31 May is inside the ordinary determination',
     JSON.stringify(may31.submission));
  // 7月1日ちょうどは条文の「まで」に含まれる。
  const jul1 = (await reg('year=2026&acquired_on=2026-07-01')).body;
  ok(jul1.submission?.required === false,
     '1 July itself falls inside the excluded window the article names',
     JSON.stringify(jul1.submission));

  // 6月30日以前に退職した人は7月1日に在籍しないので対象外。
  const leftJune = (await reg('year=2026&left_on=2026-06-30')).body;
  ok(leftJune.submission?.required === false,
     'someone who left on 30 June is not employed on the 1 July reference date',
     JSON.stringify(leftJune.submission));
  // 6月30日退職は喪失日が7月1日。7月1日「現に使用される」には当たらない。
  const leftJul1 = (await reg('year=2026&left_on=2026-07-01')).body;
  ok(leftJul1.submission?.required === true,
     'leaving on 1 July means still employed that day, so the filing stands',
     JSON.stringify(leftJul1.submission));

  // 7月・8月・9月に随時改定がある人は対象外。
  for (const m of [7, 8, 9]) {
    const r = (await reg(`year=2026&revision_month=${m}`)).body;
    ok(r.submission?.required === false,
       `a 随時改定 from month ${m} removes the filing`, JSON.stringify(r.submission));
    ok(/七月から九月までのいずれかの月から標準報酬月額を改定され/.test(r.submission?.basis ?? ''),
       'quoting the article rather than paraphrasing it', r.submission?.basis);
  }
  const june = (await reg('year=2026&revision_month=6')).body;
  ok(june.submission?.required === true,
     'a revision in June is outside the excluded months', JSON.stringify(june.submission));

  // 判定そのものは従来どおり返る。対象外でも等級は出す — 出さないと確認できない。
  ok(midJune.schemes?.health?.grade === plain.schemes?.health?.grade,
     'an excluded employee is still graded, so the exclusion can be checked',
     `${midJune.schemes?.health?.grade} vs ${plain.schemes?.health?.grade}`);

  // バッチでも同じ。6月の作業は誰を出すかを選り分けること。
  const post = async (body) => {
    const r = await tryFetch(`${BASE}/v1/standard-remuneration/regular/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    return { status: r.status, body: await r.json() };
  };
  const m = (v, d = 30) => ({ remuneration: v, payment_basis_days: d });
  const run = await post({
    defaults: { year: 2026 },
    employees: [
      { id: 'file', months: [m(300000), m(300000), m(300000)] },
      { id: 'newjoiner', months: [m(300000), m(300000), m(300000)], acquired_on: '2026-06-15' },
      { id: 'leaver', months: [m(300000), m(300000), m(300000)], left_on: '2026-06-30' },
      { id: 'revised', months: [m(300000), m(300000), m(300000)], revision_month: 8 },
    ],
  });
  const by = Object.fromEntries((run.body.results ?? []).map((r) => [r.id, r]));
  ok(by.file?.submission?.required === true, 'the ordinary employee is filed');
  ok(by.newjoiner?.submission?.required === false
       && by.leaver?.submission?.required === false
       && by.revised?.submission?.required === false,
     'and all three excluded cases are marked not to file',
     JSON.stringify([by.newjoiner?.submission?.required, by.leaver?.submission?.required,
                     by.revised?.submission?.required]));
  ok(run.body.summary?.filing_undetermined === 0,
     'no row is left undetermined once filing is the default',
     JSON.stringify(run.body.summary));
  ok(run.body.summary?.to_file === 1 && run.body.summary?.not_required === 3,
     'the run counts how many forms actually have to be filed',
     JSON.stringify(run.body.summary));

  // 未知パラメータを黙って捨てないこと。acquired_on を足す以上、綴り間違いは致命的。
  ok((await reg('year=2026&acquire_on=2026-06-15')).status === 400,
     'a misspelt acquired_on is refused rather than ignored');
  ok((await reg('year=2026&joined_on=2026-06-15')).status === 400,
     'and so is a plausible-sounding name this endpoint does not take');
  // 7〜9以外の月も受け取る。拒否すると「6月に改定があったが、まだ出すのか」に
  // 答えられなくなり、判定が null に落ちてしまう。
  const oct = (await reg('year=2026&revision_month=10')).body;
  ok(oct.submission?.required === true,
     'a revision in October does not displace the determination, and says so',
     JSON.stringify(oct.submission));
  ok((await reg('year=2026&revision_month=13')).status === 400,
     'but a month number outside 1-12 is refused');
}
// ---- 52. どのエンドポイントも未知のクエリパラメータを黙って捨てないこと (F-34) ----
// 前の周回で「渡したのに無視された」を根本原因として直したはずが、そのとき触った
// 9本にしか入っていなかった。第7反復で acquire_on という綴り間違いが 200 で通り、
// 「除外事由なし = 提出対象」と読める答えが返ることが分かった。
//
// 個別に足すと次に追加したものがまた漏れるので、仕様書に載っている全 GET を
// 走査して確かめる。ここが緑である限り、新しいエンドポイントも漏れない。
{
  const spec = await (await tryFetch(`${BASE}/openapi.json`)).json();
  const paths = Object.entries(spec.paths ?? {});

  // GET だけを対象にする。POST の本文は別の検査経路。
  const gets = paths.filter(([, ops]) => ops.get).map(([p, ops]) => [p, ops.get]);
  ok(gets.length >= 25, 'the spec carries the GET endpoints to sweep', `${gets.length}`);

  const sample = (param) => {
    const ex = param.example ?? param.schema?.example;
    if (ex !== undefined && ex !== null) return String(ex);
    const t = param.schema?.type;
    if (t === 'integer' || t === 'number') return '1';
    if (t === 'boolean') return 'false';
    return 'x';
  };

  const skipped = [];
  const leaked = [];

  for (const [path, op] of gets) {
    if (path.includes('{')) { skipped.push(`${path} (templated)`); continue; }

    // 必須パラメータを埋めて 400 の理由を「未知パラメータ」に絞り込む。
    const required = (op.parameters ?? []).filter((p) => p.required);
    const qs = new URLSearchParams();
    for (const p of required) qs.set(p.name, sample(p));

    // まず素の呼び出しが通ることを確かめる。通らないなら、この掃引では判定できない。
    const baseline = await tryFetch(`${BASE}${path}?${qs}`);
    if (baseline.status >= 400) { skipped.push(`${path} (baseline ${baseline.status})`); continue; }

    qs.set('zzz_definitely_not_a_parameter', '1');
    const r = await tryFetch(`${BASE}${path}?${qs}`);
    const body = await r.json().catch(() => ({}));
    if (r.status !== 400 || body.code !== 'unknown_parameter')
      leaked.push(`${path} -> ${r.status} ${body.code ?? ''}`);
  }

  ok(leaked.length === 0,
     'every documented GET refuses a parameter it does not know',
     leaked.join(' | ') || 'none');

  // 掃引から外れたものは、外れた理由ごと見えるようにしておく。黙って減ると気づけない。
  ok(skipped.length <= 6,
     'and few enough endpoints fall outside the sweep to keep it meaningful',
     skipped.join(' | ') || 'none');

  // 掃引で埋められない必須パラメータを持つものは、いちばん使われる経路でもある。
  // 自動で漏れる位置にこそ明示的な検査を置く。
  for (const [label, q] of [
    ['/v1/payroll', 'prefecture=Tokyo&monthly_salary=300000&age=40'],
    ['/v1/holidays', 'year=2026'],
    ['/v1/bonus-insurance', 'prefecture=Tokyo&bonus=500000&age=40'],
    ['/', ''],
  ]) {
    const r = await get(`${label}?${q}${q ? '&' : ''}zzz_definitely_not_a_parameter=1`);
    ok(r.status === 400 && r.body.code === 'unknown_parameter',
       `${label} refuses an unknown parameter too`, `${r.status} ${r.body.code}`);
  }

  // 逆方向。拒否を入れるとき、ヘルパー経由で読んでいるパラメータを許可リストから
  // 落としやすい。calendar がまさにそれで、3本で documented なのに弾かれていた。
  // 「知らないものを拒む」と「知っているものを通す」は別々に守る必要がある。
  const wronglyRejected = [];
  for (const [path, op] of gets) {
    if (path.includes('{')) continue;
    const required = (op.parameters ?? []).filter((p) => p.required);
    for (const p of op.parameters ?? []) {
      const qs = new URLSearchParams();
      for (const rq of required) qs.set(rq.name, sample(rq));
      qs.set(p.name, sample(p));
      const r = await tryFetch(`${BASE}${path}?${qs}`);
      if (r.status !== 400) continue;
      const body = await r.json().catch(() => ({}));
      if (body.code === 'unknown_parameter') wronglyRejected.push(`${path} ?${p.name}`);
    }
  }
  ok(wronglyRejected.length === 0,
     'and never refuses a parameter its own spec documents',
     wronglyRejected.join(' | ') || 'none');

  // 近い綴りには候補を出す。拒否だけでは直せない。
  const typo = await (await tryFetch(
    `${BASE}/v1/minimum-wage?prefecture=Tokyo&dat=2026-01-01`)).json();
  ok(/間違いではありませんか/.test(typo.hint ?? ''),
     'a near miss suggests the parameter that was meant', typo.hint);
}
// ---- 53. 年次有給休暇 (F-07) ----
// バー: 労働基準法第39条、同法施行規則第24条の3、同法第115条。e-Gov から取得して
// 確認した文言と数値 —
//   39条1項: 「六箇月」「全労働日」「八割」「十労働日」
//   39条2項の表: 加算日数 一/二/四/六/八/十 労働日 (継続勤務 1〜6年以上)
//   39条3項: 「厚生労働省令で定める日数」
//   39条7項: 「五日」
//   施行規則24条の3: 「三十時間」「四日」「二百十六日」、別表
//   115条: 「二年」
// 20日という上限は条文に無い。10労働日 + 六年以上の加算十労働日 の結果である。
{
  const al = (q) => get(`/v1/annual-leave?${q}`);
  const H = 'hired_on=2020-04-01&attendance_rate=0.9';

  // 六箇月に達するまでは付与が無い。
  const before = (await al(`${H}&as_of=2020-09-30`)).body;
  ok(before.grants.length === 0 && before.current === null,
     'nothing is granted before six months of service', `${before.grants.length}`);

  // 条文の階段。10 → 11 → 12 → 14 → 16 → 18 → 20 で頭打ち。
  const want = [
    ['2020-10-01', 10, '6か月'], ['2021-10-01', 11, '1年6か月'], ['2022-10-01', 12, '2年6か月'],
    ['2023-10-01', 14, '3年6か月'], ['2024-10-01', 16, '4年6か月'], ['2025-10-01', 18, '5年6か月'],
    ['2026-10-01', 20, '6年6か月'], ['2027-10-01', 20, '7年6か月'],
  ];
  for (const [asOf, days, service] of want) {
    const r = (await al(`${H}&as_of=${asOf}`)).body;
    ok(r.current?.days === days && r.current?.service === service,
       `${service} grants ${days} working days`, `${r.current?.days} / ${r.current?.service}`);
  }

  // 20は条文に書かれた数字ではない。10 + 六年以上の加算10。
  const top = (await al(`${H}&as_of=2026-10-01`)).body;
  ok(top.reference.full_grant.join(',') === '10,11,12,14,16,18,20',
     'the whole ladder comes out of the article table', top.reference.full_grant.join(','));
  ok(/20日という上限は条文に書かれていません/.test(JSON.stringify(top.notes)),
     'and the response says 20 is a sum, not a figure the article states');

  // 比例付与。週3日は 5,6,6,8,9,10,11。
  const P = `${H}&weekly_days=3&weekly_hours=20`;
  for (const [asOf, days] of [['2020-10-01', 5], ['2023-10-01', 8], ['2026-10-01', 11]]) {
    const r = (await al(`${P}&as_of=${asOf}`)).body;
    ok(r.proportional?.applies === true && r.current?.days === days,
       `a three-day week gets ${days} days at that point`,
       `${r.proportional?.applies} / ${r.current?.days}`);
  }

  // 週30時間以上なら、日数が少なくても通常付与になる。ここを取り違えると過少になる。
  const thirty = (await al(`${H}&as_of=2020-10-01&weekly_days=3&weekly_hours=30`)).body;
  ok(thirty.proportional?.applies === false && thirty.current?.days === 10,
     'thirty hours a week takes the ordinary grant even on three days',
     `${thirty.proportional?.applies} / ${thirty.current?.days}`);

  // 出勤率が八割に満たない年は付与が生じない。
  const low = (await al('hired_on=2020-04-01&as_of=2021-10-01&attendance_rate=0.79')).body;
  ok(low.attendance?.met === false && low.current?.days === 0,
     'under eighty per cent attendance nothing is granted',
     `${low.attendance?.met} / ${low.current?.days}`);
  const exact = (await al('hired_on=2020-04-01&as_of=2021-10-01&attendance_rate=0.8')).body;
  ok(exact.attendance?.met === true && exact.current?.days === 11,
     'exactly eighty per cent clears it — the article says 八割以上',
     `${exact.attendance?.met} / ${exact.current?.days}`);

  // 出勤率を渡さなければ判定しない。満たさない年があれば結論は変わる。
  const noRate = (await al('hired_on=2020-04-01&as_of=2021-10-01')).body;
  ok(noRate.attendance?.met === null && /八割要件は判定していません/.test(noRate.attendance?.note ?? ''),
     'without an attendance rate the eighty per cent test is reported as not judged',
     JSON.stringify(noRate.attendance));

  // 年5日の時季指定義務は10労働日以上付与された人に生じる。
  const duty = (await al(`${H}&as_of=2026-10-01&days_taken=2`)).body;
  ok(duty.five_day_duty?.applies === true && duty.five_day_duty?.remaining === 3,
     'twenty days granted with two taken leaves three to be directed',
     JSON.stringify(duty.five_day_duty));
  ok(duty.five_day_duty?.by === '2027-10-01',
     'and the deadline is one year from the grant', duty.five_day_duty?.by);

  const noDuty = (await al(`${H}&as_of=2020-10-01&weekly_days=4&weekly_hours=20&days_taken=0`)).body;
  ok(noDuty.current?.days === 7 && noDuty.five_day_duty?.applies === false,
     'seven days granted is under the ten-day trigger, so no duty arises',
     `${noDuty.current?.days} / ${noDuty.five_day_duty?.applies}`);

  // 時効は2年。繰越しは1年分まで。
  ok(top.current?.expires_on === '2028-10-01',
     'the grant lapses two years on, per 労基法115条', top.current?.expires_on);

  // 根拠が条文で示されること。
  ok(/労働基準法第39条第1項/.test(top.attendance?.basis ?? ''), 'the attendance test cites its provision');
  ok(/施行規則第24条の3/.test(JSON.stringify((await al(`${P}&as_of=2020-10-01`)).body.proportional)),
     'and the proportional table cites the regulation');

  // 入力の検査。
  ok((await al('')).status === 400, 'hired_on is required');
  ok((await al('hired_on=nonsense')).status === 400, 'a malformed date is refused');
  ok((await al('hired_on=2020-04-01&attendance_rate=1.5')).status === 400,
     'an attendance rate above 1 is refused');
  ok((await al('hired_on=2020-04-01&as_of=2019-01-01')).status === 400,
     'an as_of before hiring is refused');
  ok((await al('hired_on=2020-04-01&bogus=1')).status === 400, 'an unknown parameter is refused');
}
// ---- 54. 年間の労務コスト (F-20) ----
// バー: 健康保険法第45条 — 標準賞与額は千円未満切捨て、**年度の累計額**が573万円で
// 頭打ち、年度は4月1日から翌年3月31日。厚生年金保険法第24条の4 — 千円未満切捨て、
// **1回あたり**150万円。年度累計の定めは無い。
// (e-Gov 211AC0000000070 / 329AC0000000115 から円トークンを抽出して確認。
//  健保: [1000, 5730000, 5730000] / 厚年: [1000, 1500000, 1500000])
//
// この非対称のせいで、年間の事業主負担は「月次×12 + 賞与ごとの計算」では出ない。
// 健保は年度を通した累計で切れ、厚年は支給ごとに切れる。外資が採用の可否を決める
// ときに見る数字がこれで、いまは自分で足し合わせるしかなかった。
{
  const ac = (q) => get(`/v1/annual-cost?${q}`);
  const BASE_Q = 'prefecture=Tokyo&monthly_salary=400000&age=40&workers_comp_type=98';

  // 賞与が無ければ月次の12倍に一致すること。ここがずれたら他は読めない。
  const bare = (await ac(BASE_Q)).body;
  const one = (await get(`/v1/payroll?${BASE_Q}`)).body;
  ok(bare.monthly?.employer_cost === one.totals.employer_cost,
     'the monthly figure matches the single payslip exactly',
     `${bare.monthly?.employer_cost} vs ${one.totals.employer_cost}`);
  ok(bare.annual?.employer_cost === one.totals.employer_cost * 12,
     'and with no bonus the year is twelve of them',
     `${bare.annual?.employer_cost} vs ${one.totals.employer_cost * 12}`);

  // 賞与を足すと年額が増える。単純加算ではないので、内訳が出ること。
  const withBonus = (await ac(`${BASE_Q}&bonuses=800000,800000`)).body;
  ok(withBonus.bonuses?.length === 2, 'each bonus is reported separately',
     `${withBonus.bonuses?.length}`);
  ok(withBonus.annual?.employer_cost > bare.annual?.employer_cost,
     'and the year costs more than the same salary without them');

  // 健保は年度累計573万で切れる。300万を2回なら2回目の途中で頭打ちになる。
  const capped = (await ac(`${BASE_Q}&bonuses=3000000,3000000`)).body;
  const hb = capped.bonuses ?? [];
  ok(hb[0]?.health?.standard_bonus === 3000000,
     'the first three-million bonus is counted in full for health',
     `${hb[0]?.health?.standard_bonus}`);
  ok(hb[1]?.health?.standard_bonus === 5730000 - 3000000,
     'the second is cut to what remains of the 5,730,000 year',
     `${hb[1]?.health?.standard_bonus}`);
  ok(hb[1]?.health?.capped === true, 'and the row says it was capped',
     JSON.stringify(hb[1]?.health));

  // 3回目は健保の枠が尽きているのでゼロ。厚年は支給ごとなので払い続ける。
  const third = (await ac(`${BASE_Q}&bonuses=3000000,3000000,1000000`)).body;
  const t3 = third.bonuses?.[2];
  ok(t3?.health?.standard_bonus === 0,
     'once the year is used up a further bonus adds no health premium',
     `${t3?.health?.standard_bonus}`);
  ok(t3?.pension?.standard_bonus === 1000000,
     'while pension still charges it, because its cap is per payment',
     `${t3?.pension?.standard_bonus}`);

  // 厚年は1回150万で切れる。年度累計ではない。
  const bigOne = (await ac(`${BASE_Q}&bonuses=2000000`)).body;
  ok(bigOne.bonuses?.[0]?.pension?.standard_bonus === 1500000,
     'a two-million bonus is capped at 1,500,000 for pension',
     `${bigOne.bonuses?.[0]?.pension?.standard_bonus}`);
  ok(bigOne.bonuses?.[0]?.health?.standard_bonus === 2000000,
     'but health takes the whole two million, being under the yearly total',
     `${bigOne.bonuses?.[0]?.health?.standard_bonus}`);

  // 千円未満は切り捨てる (健保法45条、厚年法24条の4)。
  const odd = (await ac(`${BASE_Q}&bonuses=800999`)).body;
  ok(odd.bonuses?.[0]?.health?.standard_bonus === 800000,
     'the standard bonus drops anything under a thousand yen',
     `${odd.bonuses?.[0]?.health?.standard_bonus}`);

  // 年間の総額は、月次12回と賞与の合計と一致すること。
  // 賞与にかかる事業主負担には社会保険分と労災分の両方が入る。労災は賃金総額に
  // かかる (徴収法第2条第2項) ので賞与も対象で、ここを落とすと突合が合わない。
  const rows = withBonus.bonuses ?? [];
  const bonusGross = rows.reduce((a, b) => a + b.gross, 0);
  const bonusEmployer = rows.reduce((a, b) => a + b.employer + b.workers_compensation_employer, 0);
  const expected = Math.round((withBonus.monthly.employer_cost * 12 + bonusGross + bonusEmployer) * 100) / 100;
  ok(withBonus.annual?.employer_cost === expected,
     'the annual total reconciles with its own parts, workers compensation included',
     `${withBonus.annual?.employer_cost} vs ${expected}`);

  // 労災は賃金総額にかかるので、賞与にもかかる。
  ok((withBonus.bonuses ?? []).every((b) => b.workers_compensation_employer > 0),
     'workers compensation is charged on bonuses too, being on total wages',
     JSON.stringify((withBonus.bonuses ?? []).map((b) => b.workers_compensation_employer)));

  // 年度の範囲が条文どおり示されること。
  ok(withBonus.fiscal_year?.from?.endsWith('-04-01') && withBonus.fiscal_year?.to?.endsWith('-03-31'),
     'the year runs April to March, as the article fixes it',
     JSON.stringify(withBonus.fiscal_year));
  ok(/健康保険法第45条/.test(JSON.stringify(withBonus.caps ?? {})),
     'and the caps cite their provisions', JSON.stringify(withBonus.caps));

  // 入力の検査。
  ok((await ac('prefecture=Tokyo&monthly_salary=400000')).status === 400,
     'age is required here too');
  ok((await ac(`${BASE_Q}&bonuses=abc`)).status === 400, 'a non-numeric bonus is refused');
  ok((await ac(`${BASE_Q}&bonuses=-1`)).status === 400, 'a negative bonus is refused');
  ok((await ac(`${BASE_Q}&bogus=1`)).status === 400, 'an unknown parameter is refused');
}
// ---- 55. 被用者保険に入らない人の側 (F-08) ----
// バー: 国民年金法第87条 — 保険料は法定額に「保険料改定率」を乗じた額で、改定率は
// 「毎年度」「政令で定める」。条文には法定額が 13,580 から 17,000 まで並ぶ。
// 国民健康保険法第76条 — 「市町村」が「世帯主」から徴収する(または国民健康保険税)。
// **円の記載が一つも無い。** (e-Gov 334AC0000000141 / 333AC0000000192 で確認)
//
// つまり国民年金は全国一律で答えられ、国民健康保険は全国一律の答えが存在しない。
// フリーランスが /v1/payroll を呼ぶと会社員として計算した数字が返り、エラーにも
// ならなかった。気づく手がかりが無いまま違う制度の答えが出るのが最も危険で、
// 「無い」より「あるけど間違う」ほうが重い。
{
  const ni = (q) => get(`/v1/national-insurance${q ? '?' + q : ''}`);

  const one = (await ni('as_of=2026-06-01')).body;
  const np = one.national_pension;
  ok(np?.monthly === 17920, 'the national pension contribution is a single national figure',
     `${np?.monthly}`);
  ok(np?.flat_rate === true,
     'and it is flat — it does not move with income the way pension premiums do',
     `${np?.flat_rate}`);
  ok(np?.from === '2026-04-01' && np?.through === '2027-03-31',
     'the year it covers is stated', `${np?.from} - ${np?.through}`);
  ok(/国民年金法第87条/.test(np?.statute ?? ''), 'with the provision behind it', np?.statute);

  // 定額なので月数倍で足りる。
  const year = (await ni('as_of=2026-06-01&months=12')).body;
  ok(year.national_pension?.total === 17920 * 12,
     'twelve months is twelve times the month, being a flat rate',
     `${year.national_pension?.total}`);

  // 付加保険料は月400円。任意。
  const supp = (await ni('as_of=2026-06-01&supplementary=true&months=12')).body;
  ok(supp.national_pension?.monthly_total === 17920 + 400,
     'the optional supplementary contribution adds 400 a month',
     `${supp.national_pension?.monthly_total}`);

  // 国民健康保険は金額を返さない。返さない理由を返す。
  const nh = one.national_health_insurance;
  ok(nh?.computable === false,
     'national health insurance is reported as not computable', `${nh?.computable}`);
  ok(/国民健康保険法第76条/.test(nh?.statute ?? ''),
     'citing the article that leaves it to the municipality', nh?.statute);
  ok(/市町村/.test(nh?.reason ?? '') && /条例|一律/.test(nh?.reason ?? ''),
     'and saying why there is no single national figure', nh?.reason?.slice(0, 80));
  ok(Array.isArray(nh?.determined_by) && nh.determined_by.length >= 4,
     'what actually decides it is listed, so the reader knows where to look',
     `${nh?.determined_by?.length}`);
  ok(typeof nh?.where_to_look === 'string' && nh.where_to_look.length > 0,
     'along with where the actual figure can be got');
  // 概算を返さないことを明言する。もっともらしい概算は気づく手がかりを消す。
  ok(/未実装だから|できるふり|もっともらしい/.test(JSON.stringify(nh)),
     'and it says plainly that no estimate is offered on purpose',
     JSON.stringify(nh).slice(0, 120));

  // どちらの制度に入るかは worker-type が決める。半分実装にしない。
  ok(one.employee_insurance?.worker_type === '/v1/worker-type'
       && one.employee_insurance?.payroll === '/v1/payroll',
     'the response points at the endpoint that decides which side someone is on',
     JSON.stringify(one.employee_insurance));

  // 年度が変われば額が変わる。収録外の日付に現年度の額を返さない。
  for (const asOf of ['2026-03-31', '2027-04-01']) {
    const r = await ni(`as_of=${asOf}`);
    ok(r.status === 422 && r.body.code === 'out_of_coverage',
       `${asOf} is refused rather than answered with this year's figure`,
       `${r.status} ${r.body.code}`);
    ok(r.body.coverage?.from === '2026-04-01',
       'and the refusal names what is actually carried', JSON.stringify(r.body.coverage));
  }

  // 入力の検査。
  ok((await ni('as_of=nonsense')).status === 400, 'a malformed date is refused');
  ok((await ni('as_of=2026-06-01&months=0')).status === 400, 'zero months is refused');
  ok((await ni('as_of=2026-06-01&supplementary=maybe')).status === 400,
     'a non-boolean supplementary is refused');
  ok((await ni('as_of=2026-06-01&bogus=1')).status === 400, 'an unknown parameter is refused');
}
// ---- 56. 登録番号は形が正しくても有効とは限らない (F-11) ----
// バー: 消費税法第57条の2。e-Gov (363AC0000000108) から取得して確認した語 —
// 「登録を受けようとする」「登録簿」「公表しなければならない」「登録番号」「届出書」、
// そして **「登録を取り消す」** と **「効力を失う」**。
//
// 取消しと失効が条文にある以上、チェックディジットが通ることと、いま有効な登録で
// あることは別の事実になる。前者だけを返して後者を尋ねられた形にしておくと、
// 「検証した」と読まれる。税理士が知りたいのは失効・取消のほうで、300社を
// 1件ずつ問うのも現実的でない。
{
  const inv = (q) => get(`/v1/invoice-number/validate?${q}`);

  const good = (await inv('number=T8700110005901')).body;
  ok(good.check_digit_valid === true, 'a well-formed number passes the check digit',
     `${good.check_digit_valid}`);

  // 形式検査で分かることと分からないことを、返り値の中で分ける。
  ok(good.registration_status?.checked === false,
     'and the response says the register was not consulted',
     JSON.stringify(good.registration_status));
  ok(/取り消/.test(JSON.stringify(good.registration_status ?? {}))
       && /失効|効力を失/.test(JSON.stringify(good.registration_status ?? {})),
     'naming revocation and lapse as the things a check digit cannot see',
     JSON.stringify(good.registration_status).slice(0, 140));
  ok(/消費税法第57条の2/.test(JSON.stringify(good.registration_status ?? {})),
     'with the article that provides for both', JSON.stringify(good.registration_status).slice(0, 100));
  ok(typeof good.registration_status?.where_to_check === 'string'
       && good.registration_status.where_to_check.length > 0,
     'and where the actual status can be got', good.registration_status?.where_to_check);

  // 数字を1つ変えればチェックディジットが落ちる。
  const bad1 = (await inv('number=T8700110005902')).body;
  ok(bad1.check_digit_valid === false, 'a transposed digit fails', `${bad1.check_digit_valid}`);

  // 300社を1件ずつ問うのは現実的でない。まとめて通せること。
  const post = async (body) => {
    const r = await tryFetch(`${BASE}/v1/invoice-number/validate/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    return { status: r.status, body: await r.json() };
  };

  const run = await post({
    numbers: ['T8700110005901', 'T8700110005902', '8700110005901', 'nonsense', 'T870011000590'],
  });
  ok(run.status === 200, 'numbers can be checked in bulk', `${run.status}`);
  ok(run.body.count === 5, 'every input is accounted for', `${run.body.count}`);
  const byInput = Object.fromEntries((run.body.results ?? []).map((r) => [r.input, r]));
  ok(byInput['T8700110005901']?.check_digit_valid === true, 'the good one passes');
  ok(byInput['T8700110005902']?.check_digit_valid === false, 'the altered one fails');
  ok(byInput['8700110005901']?.format_valid === false,
     'a number without the leading T is not a registration number',
     JSON.stringify(byInput['8700110005901']));
  ok(byInput['nonsense']?.format_valid === false, 'and neither is nonsense');
  ok(byInput['T870011000590']?.format_valid === false, 'nor one digit short');

  // まとめても、分かるのは形式だけ。件数で要約して、確認先を出す。
  ok(run.body.summary?.check_digit_valid === 1 && run.body.summary?.rejected === 4,
     'the run summarises how many are well-formed', JSON.stringify(run.body.summary));
  ok(run.body.registration_status?.checked === false,
     'and repeats that none of them were looked up in the register',
     JSON.stringify(run.body.registration_status));

  // 重複はそのまま返す。まとめられると突合できない。
  const dup = await post({ numbers: ['T8700110005901', 'T8700110005901'] });
  ok(dup.body.count === 2 && dup.body.results.length === 2,
     'duplicates come back as given, so a caller can line them up with their own list',
     `${dup.body.results?.length}`);

  // 入力の検査。
  ok((await post({})).status === 400, 'a missing numbers key is refused');
  ok((await post({ numbers: [] })).status === 400, 'an empty list is refused');
  ok((await post({ numbers: 'T8700110005901' })).status === 400, 'a non-array is refused');
  ok((await post({ numbers: [123] })).status === 400, 'a non-string entry is refused');
  const tooMany = await post({ numbers: Array.from({ length: 1001 }, () => 'T8700110005901') });
  ok(tooMany.status === 400 && tooMany.body.code === 'batch_too_large',
     'and an oversized run is refused with its own code',
     `${tooMany.status} ${tooMany.body.code}`);
}
// ---- 57. 存在しない行政区画を受け付けないこと (F-12) ----
// バー: 公職選挙法 (e-Gov 325AC1000000100) の本文 1,722,869 字を照合し、47件すべての
// 接尾辞が一意に決まった — 都1(東京)、道1(北海道)、府2(京都・大阪)、県43。
// 「東京府」「大阪県」「京都県」「北海道県」はいずれも本文に一度も現れない。
//
// 解決関数が末尾1文字を /[都道府県]$/ で無条件に落としていたため、「東京府」から
// 「府」を剥がすと「東京」に一致してしまい、存在しない行政区画に平然と答えていた。
// 金額を返すAPIで地名を取り違えるのは、料率がまるごと別の県のものになるということ。
{
  const rate = (p) => get(`/v1/insurance-rates?prefecture=${encodeURIComponent(p)}`);

  // 正しい接尾辞は通る。
  for (const [name, code] of [['東京都', 13], ['北海道', 1], ['大阪府', 27], ['京都府', 26],
                              ['青森県', 2], ['沖縄県', 47]]) {
    const r = await rate(name);
    ok(r.status === 200 && r.body.code === code,
       `${name} resolves to JIS ${code}`, `${r.status} / ${r.body.code}`);
  }

  // 接尾辞なしも通る。実務では「東京」と書く。
  for (const [name, code] of [['東京', 13], ['大阪', 27], ['沖縄', 47]]) {
    const r = await rate(name);
    ok(r.status === 200 && r.body.code === code, `${name} without a suffix still resolves`,
       `${r.status} / ${r.body.code}`);
  }

  // 誤った接尾辞は拒む。ここが今回の本体。
  for (const wrong of ['東京府', '東京県', '大阪県', '京都県', '北海道県', '北海道府',
                       '青森府', '青森都', '沖縄都', '神奈川府']) {
    const r = await rate(wrong);
    ok(r.status === 400, `${wrong} is refused — no such administrative division`,
       `${r.status} ${r.body.code ?? ''}`);
    ok(r.body.code === 'unknown_prefecture', 'with a code a client can branch on', r.body.code);
  }

  // 正しい名前を示すこと。拒むだけでは直せない。
  const hint = (await rate('東京府')).body.hint ?? '';
  ok(/東京都/.test(hint), 'and the refusal names the form that would have worked', hint);

  // 英語名と JIS コードは従来どおり。
  ok((await rate('Tokyo')).body.code === 13, 'the English name still works');
  const byCode = await get('/v1/insurance-rates?prefecture=13');
  ok(byCode.status === 200 && byCode.body.code === 13, 'and so does the JIS code');

  // 存在しない地名は当然拒む。
  for (const nonsense of ['Atlantis', '武蔵国', '東京市', '']) {
    const r = await rate(nonsense);
    ok(r.status === 400, `${nonsense || '(empty)'} is refused`, `${r.status}`);
  }

  // 都道府県を取る他のエンドポイントでも同じ扱いであること。1本だけ直しても意味がない。
  for (const path of ['/v1/minimum-wage', '/v1/payroll?monthly_salary=300000&age=40',
                      '/v1/bonus-insurance?bonus=500000&age=40']) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await get(`${path}${sep}prefecture=${encodeURIComponent('大阪県')}`);
    ok(r.status === 400 && r.body.code === 'unknown_prefecture',
       `${path.split('?')[0]} refuses it too`, `${r.status} ${r.body.code ?? ''}`);
  }

  // 参照一覧が正式名称を持っていること。利用者がどう書けばよいか分かる。
  const prefs = (await get('/v1/prefectures')).body;
  ok(prefs.count === 47, 'the reference list still carries all forty-seven', `${prefs.count}`);
  const tokyo = (prefs.prefectures ?? []).find((p) => p.code === 13);
  ok(tokyo?.prefecture_ja_full === '東京都',
     'and gives the full official name, not just the bare one',
     JSON.stringify(tokyo));
  const suffixes = new Set((prefs.prefectures ?? []).map((p) => (p.prefecture_ja_full ?? '').slice(-1)));
  ok(suffixes.has('都') && suffixes.has('道') && suffixes.has('府') && suffixes.has('県'),
     'covering all four kinds of division', [...suffixes].join(''));
}
// ---- 58. 再送しても二重計上にならないと言えること (F-13) ----
// バー: draft-ietf-httpapi-idempotency-key-header-07 (2025-10-15)。
//   「Idempotency-Key is an Item Structured Header [RFC8941]. Its value MUST be a String」
//   「It is RECOMMENDED that a UUID [RFC4122] or a similar random identifier be used」
//   同じキーで同じ内容 → 前回の結果を返す / 異なる内容 → 422 / 処理中 → 409
//
// ただしこの仕様は**副作用のある操作**のためのもの。ここのバッチは計算して返すだけで
// 何も記録しないので、再送しても二重計上のしようがない。409 も 422 も起きえない。
// 保存を持たないまま「前回の結果を返す」を装うのは嘘になる。
//
// 利用者が本当に困るのは「ネットワークが切れた。同じ実行か、別の実行か」。それには
// 入力から決まる run_id があれば足りる。同じ入力なら必ず同じ id が返るので、
// 自分の台帳と突き合わせられる。
{
  const post = async (path, body, headers = {}) => {
    const r = await tryFetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  const run = {
    defaults: { prefecture: 'Tokyo', age: 40 },
    employees: [{ id: 'a', monthly_salary: 300000 }, { id: 'b', monthly_salary: 280000 }],
  };

  const first = await post('/v1/payroll/batch', run);
  ok(first.status === 200, 'the batch runs', `${first.status}`);
  ok(typeof first.body.run_id === 'string' && first.body.run_id.length >= 16,
     'and returns an id derived from what was sent', `${first.body.run_id}`);

  // 同じ入力なら必ず同じ id。ここが成り立たないと台帳と突き合わせられない。
  const again = await post('/v1/payroll/batch', run);
  ok(again.body.run_id === first.body.run_id,
     'the same input always yields the same id, so a retry is recognisable',
     `${first.body.run_id} vs ${again.body.run_id}`);

  // キーの順序が違うだけでは変わらない。JSONの書き方で id が動くと使えない。
  const reordered = await post('/v1/payroll/batch', {
    employees: [{ monthly_salary: 300000, id: 'a' }, { monthly_salary: 280000, id: 'b' }],
    defaults: { age: 40, prefecture: 'Tokyo' },
  });
  ok(reordered.body.run_id === first.body.run_id,
     'and key order does not change it', `${reordered.body.run_id}`);

  // 中身が1円でも違えば別の id。
  const changed = await post('/v1/payroll/batch', {
    defaults: { prefecture: 'Tokyo', age: 40 },
    employees: [{ id: 'a', monthly_salary: 300001 }, { id: 'b', monthly_salary: 280000 }],
  });
  ok(changed.body.run_id !== first.body.run_id,
     'while a single yen of difference makes a different run',
     `${changed.body.run_id}`);

  // 人の並び順が違えば別の実行。給与の台帳では順序も意味を持つ。
  const swapped = await post('/v1/payroll/batch', {
    defaults: { prefecture: 'Tokyo', age: 40 },
    employees: [{ id: 'b', monthly_salary: 280000 }, { id: 'a', monthly_salary: 300000 }],
  });
  ok(swapped.body.run_id !== first.body.run_id,
     'and so does a different order of employees', `${swapped.body.run_id}`);

  // Idempotency-Key は受け取って返す。クライアントが自動で付けることがある。
  const key = '8e03978e-40d5-43e8-bc93-6894a57f9324';
  const withKey = await post('/v1/payroll/batch', run, { 'idempotency-key': key });
  ok(withKey.body.idempotency?.key === key,
     'a supplied Idempotency-Key comes back', JSON.stringify(withKey.body.idempotency));
  ok(withKey.body.run_id === first.body.run_id,
     'and does not change the run id, which comes from the body alone',
     `${withKey.body.run_id}`);

  // 同じキーで違う内容を送っても 422 にはならない。保存していないので検出しようがなく、
  // 検出したふりをするより「起きえない」と言うほうが正しい。
  const keyDifferent = await post('/v1/payroll/batch', changed.body ? {
    defaults: { prefecture: 'Tokyo', age: 40 },
    employees: [{ id: 'a', monthly_salary: 999999 }],
  } : run, { 'idempotency-key': key });
  ok(keyDifferent.status === 200,
     'the same key with a different body is not a 422 here, because nothing was stored',
     `${keyDifferent.status}`);

  // なぜ 409/422 が起きないのかを、返り値の中で述べること。
  const idem = first.body.idempotency ?? {};
  ok(idem.safe_to_retry === true,
     'the response states that retrying is safe', JSON.stringify(idem));
  ok(/副作用|記録しません|stateless/i.test(JSON.stringify(idem)),
     'and says why — nothing is recorded', JSON.stringify(idem).slice(0, 140));
  ok(/draft-ietf-httpapi-idempotency-key-header/.test(JSON.stringify(idem)),
     'citing the draft it is answering', JSON.stringify(idem).slice(0, 200));

  // POST は他にもある。1本だけ直すのは、この周回で4度やった形。
  for (const [path, body] of [
    ['/v1/standard-remuneration/regular/batch', {
      employees: [{ id: 'x', months: [
        { remuneration: 300000, payment_basis_days: 30 },
        { remuneration: 300000, payment_basis_days: 30 },
        { remuneration: 300000, payment_basis_days: 30 }] }],
    }],
    ['/v1/invoice-number/validate/batch', { numbers: ['T8700110005901'] }],
  ]) {
    const a = await post(path, body);
    const b = await post(path, body);
    ok(typeof a.body.run_id === 'string' && a.body.run_id === b.body.run_id,
       `${path} carries the same kind of id`, `${a.body.run_id}`);
    ok(a.body.idempotency?.safe_to_retry === true,
       `${path} says a retry is safe too`, JSON.stringify(a.body.idempotency));
  }
}
// ---- 59. Custom GPT Actions の30オペレーション上限に収めること (F-19) ----
// バー: OpenAI の Custom GPT Actions は **最大30オペレーション**。超えると読み込み
// そのものが失敗する。スキーマの上限は1MB(こちらは85KBなので問題にならない)。
//
// 記録された当時は33本だった。いま44本ある。**載らなければ、この配布経路は
// まるごとゼロになる。**機能を増やすほど遠のく類の壁で、放っておくと悪化する一方だった。
{
  const full = await get('/openapi.json');
  const gpt = await get('/openapi.json?profile=gpt');
  const count = (spec) => Object.values(spec.paths ?? {})
    .reduce((n, v) => n + Object.keys(v).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).length, 0);

  ok(full.status === 200 && gpt.status === 200, 'both profiles are served',
     `${full.status} / ${gpt.status}`);

  // ここが本体。30を超えたら Custom GPT に載らない。
  ok(count(gpt.body) <= 30,
     'the GPT profile fits inside the thirty-operation limit', `${count(gpt.body)}`);
  ok(count(full.body) > 30,
     'while the full one is over it, which is why the profile exists', `${count(full.body)}`);

  // 1MBの上限。いまは余裕があるが、増え方を見ておく。
  const bytes = new TextEncoder().encode(JSON.stringify(gpt.body)).length;
  ok(bytes < 1_000_000, 'and inside the one-megabyte schema limit', `${bytes} bytes`);

  // 絞った版が、絞った元の部分集合であること。別物になっていたら意味がない。
  const fullPaths = new Set(Object.keys(full.body.paths ?? {}));
  const extra = Object.keys(gpt.body.paths ?? {}).filter((p) => !fullPaths.has(p));
  ok(extra.length === 0, 'the profile is a subset, not a different document',
     extra.join(', ') || 'none');

  // 会話で本当に要るものが残っていること。落としすぎては元も子もない。
  for (const p of ['/v1/payroll', '/v1/worker-type', '/v1/annual-leave', '/v1/overtime-pay',
                   '/v1/eligibility', '/v1/insurance-rates', '/v1/minimum-wage',
                   '/v1/commuting-allowance', '/v1/annual-cost', '/v1/national-insurance',
                   '/v1/statute', '/v1/standard-remuneration/revision']) {
    ok(p in (gpt.body.paths ?? {}), `${p} survives the trim`, 'missing');
  }

  // 落としたものは、落とした理由ごと書いてあること。「無い」ではなく「なぜ無いか」に
  // 辿り着けるようにする。
  const desc = gpt.body.info?.description ?? '';
  ok(/30/.test(desc) && /openapi\.json/.test(desc),
     'the trimmed schema says why it is trimmed and where the full one is',
     desc.slice(0, 120));
  for (const dropped of ['/v1/payroll/batch', '/v1/consumption-tax', '/v1/enums']) {
    ok(desc.includes(dropped), `${dropped} is listed as dropped, with a reason`,
       desc.slice(0, 80));
    ok(!(dropped in (gpt.body.paths ?? {})), `${dropped} really is out of the profile`);
  }

  // profile の値は検査すること。綴り間違いで完全版が返ると、上限に静かにぶつかる。
  ok((await get('/openapi.json?profile=chatgpt')).status === 400,
     'an unrecognised profile is refused rather than silently served in full');
  ok((await get('/openapi.json?profile=full')).status === 200,
     'and "full" is accepted explicitly');
}
// ---- 60. 毎回同じ文言を運ばずに済むこと (F-15) ----
// バー: 実測。全38本のGETで 114,695 バイト、うち attribution / notes / guidance /
// statutes が 44,892 バイト (39%)。判定系ほど比率が高く、
// /v1/standard-remuneration/revision は 6,776 バイト中 6,028 バイト (88%) が
// 呼ぶたびに同じ文言だった。/v1/payroll も 5,249 中 3,487 (66%)。
//
// バッチには detail=compact があったが、単発には無かった。500人を1人ずつ呼ぶ利用者が
// いちばん払っている。出典を消すのではなく、**要らないと言えるようにする** —
// 既定は従来どおり全部返す。
{
  const P = '/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=40';

  const full = await get(P);
  const compact = await get(`${P}&detail=compact`);
  ok(full.status === 200 && compact.status === 200, 'both details answer',
     `${full.status} / ${compact.status}`);

  // 数字は1つも変わらないこと。軽くする代わりに答えが変わるなら使えない。
  ok(JSON.stringify(compact.body.totals) === JSON.stringify(full.body.totals),
     'the figures are identical either way',
     `${JSON.stringify(compact.body.totals).slice(0, 60)}`);
  ok(JSON.stringify(compact.body.deductions) === JSON.stringify(full.body.deductions),
     'and so is every deduction');

  // 定型が落ちること。
  ok(full.body.attribution !== undefined && compact.body.attribution === undefined,
     'attribution is carried by default and dropped on request',
     `${full.body.attribution !== undefined} / ${compact.body.attribution === undefined}`);
  ok(full.body.notes !== undefined && compact.body.notes === undefined,
     'and so are the notes');

  // 消したなら、どこにあるかを示すこと。黙って消えると出典を追えなくなる。
  ok(typeof compact.body.omitted === 'object' && compact.body.omitted !== null,
     'the compact response says what it left out', JSON.stringify(compact.body.omitted));
  ok(/detail=full|detail を外/.test(JSON.stringify(compact.body.omitted ?? {})),
     'and how to get it back', JSON.stringify(compact.body.omitted));
  ok((compact.body.omitted?.fields ?? []).includes('attribution'),
     'naming the fields by name', JSON.stringify(compact.body.omitted?.fields));

  // 実際に小さくなること。効かない対策を入れても意味がない。
  const fullBytes = new TextEncoder().encode(JSON.stringify(full.body)).length;
  const compactBytes = new TextEncoder().encode(JSON.stringify(compact.body)).length;
  ok(compactBytes < fullBytes * 0.6,
     'and the response is meaningfully smaller, not nominally',
     `${fullBytes} -> ${compactBytes} bytes (${Math.round(compactBytes * 100 / fullBytes)}%)`);

  // 定型の比率が高い判定系でこそ効くこと。
  const rev = '/v1/standard-remuneration/revision?current_remuneration=300000'
    + '&months=350000:31,352000:30,349000:31&fixed_pay_change=increase';
  const revFull = await get(rev);
  const revCompact = await get(`${rev}&detail=compact`);
  const rf = new TextEncoder().encode(JSON.stringify(revFull.body)).length;
  const rc = new TextEncoder().encode(JSON.stringify(revCompact.body)).length;
  ok(rc < rf * 0.35,
     'the judgement endpoints, where the boilerplate ran to 88 per cent, shrink most',
     `${rf} -> ${rc} bytes (${Math.round(rc * 100 / rf)}%)`);
  // 判定そのものは残ること。理由を消しては判定が使えない。
  ok(revCompact.body.decision !== undefined || revCompact.body.schemes !== undefined
       || revCompact.body.required !== undefined,
     'while the judgement itself survives', Object.keys(revCompact.body).join(','));

  // 既定は変えない。既存の利用者のレスポンスが黙って変わるのは避ける。
  ok(full.body.attribution !== undefined,
     'omitting the parameter changes nothing for anyone already integrated');

  // 全GETで受け付けること。1本だけ直すのは、この周回で何度もやった形。
  const spec = (await get('/openapi.json')).body;
  const notAccepted = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    if (!ops.get || path.includes('{')) continue;
    const required = (ops.get.parameters ?? []).filter((p) => p.required);
    const qs = new URLSearchParams();
    for (const p of required) {
      const ex = p.example ?? p.schema?.example;
      qs.set(p.name, ex != null ? String(ex)
        : (p.schema?.type === 'integer' || p.schema?.type === 'number') ? '1' : 'x');
    }
    const base = await get(`${path}?${qs}`);
    if (base.status >= 400) continue;
    qs.set('detail', 'compact');
    const r = await get(`${path}?${qs}`);
    if (r.status === 400 && r.body.code === 'unknown_parameter') notAccepted.push(path);
  }
  ok(notAccepted.length === 0, 'every GET accepts detail=compact',
     notAccepted.join(', ') || 'none');

  // 綴り間違いは拒む。黙って全部返すと、軽くしたつもりで軽くなっていない。
  ok((await get(`${P}&detail=brief`)).status === 400,
     'an unrecognised detail is refused rather than silently served in full');
}
// ---- 61. 実務者が読む文言の言語が揃っていること (F-14) ----
// 記録は「レスポンスが全部英語」だったが、実測すると全体の62%は和文だった。
// 日本語で書いたエンドポイントを足してきた分で、記録のほうが古い。
//
// **本当の欠陥は不統一のほう。**同じフィールド名が、エンドポイントによって和文
// だったり欧文だったりする — note は和25/欧12、description は和8/欧17、basis は
// 和17/欧2。どちらで来るか予測できないので、これを読んで画面が作れない。
// 実測時点で 37 件 / 12 エンドポイントが欧文だった。
//
// 対象読者は日本の経理担当と社労士なので、**人が読む文言は和文に寄せる**。
// 機械が読むもの(key, code, value, url, law_id)は英字のままでよい。
{
  const spec = (await get('/openapi.json')).body;
  const JA = /[ぁ-んァ-ヶ一-龥]/;

  // 人が読む文言のフィールド。機械可読なものは含めない。
  // rule は入れない。fourteen_days_in_one_month のような識別子で、分岐に使うもの。
  // 人が読む文言だけを対象にする。
  const PROSE = new Set(['note', 'notes', 'description', 'basis', 'reason', 'summary',
                         'label', 'caption', 'caveat', 'covers', 'applies_to',
                         'why', 'how_to_get', 'hint', 'meaning', 'where_to_check',
                         'where_to_look', 'not_visible_here', 'determined_by']);

  const walk = function* (o, path = '') {
    if (Array.isArray(o)) { for (const v of o) yield* walk(v, path + '[]'); return; }
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) yield* walk(v, path ? `${path}.${k}` : k);
      return;
    }
    if (typeof o === 'string' && o.length > 12) yield [path, o];
  };

  const sample = (p) => {
    const ex = p.example ?? p.schema?.example;
    if (ex !== undefined && ex !== null && ex !== '') return String(ex);
    const t = p.schema?.type;
    return (t === 'integer' || t === 'number') ? '1' : t === 'boolean' ? 'false' : 'x';
  };

  const english = [];
  let checked = 0;
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    if (!ops.get || path.includes('{')) continue;
    const qs = new URLSearchParams();
    for (const p of (ops.get.parameters ?? []).filter((x) => x.required)) qs.set(p.name, sample(p));
    const r = await get(`${path}?${qs}`);
    if (r.status !== 200) continue;
    for (const [fp, txt] of walk(r.body)) {
      const leaf = fp.split('.').pop().replace(/\[\]/g, '');
      if (!PROSE.has(leaf)) continue;
      checked++;
      if (!JA.test(txt)) english.push(`${path} ${fp}: ${txt.slice(0, 40)}`);
    }
  }

  ok(checked > 100, 'the sweep looked at enough prose to mean something', `${checked} strings`);
  ok(english.length === 0,
     'every string a person reads is in Japanese, so a client can rely on which language it gets',
     english.slice(0, 6).join(' | ') || 'none');

  // 機械が読むものは英字のまま。和文に寄せるのは人が読むものだけで、
  // code や key まで日本語にすると分岐が書けなくなる。
  const bad = await get('/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=40&zzz=1');
  ok(bad.body.code === 'unknown_parameter',
     'while the error code stays machine-readable', bad.body.code);
  const enums = (await get('/v1/enums')).body;
  ok((enums.column ?? []).every((v) => /^[a-z_]+$/.test(v.value)),
     'and so do the enum values themselves',
     JSON.stringify((enums.column ?? []).map((v) => v.value)));

  // 判定の理由は、判定と同じ言語で返ること。片方だけ英語だと読み手が切り替わる。
  const elig = (await get('/v1/eligibility?month=2026-03&left_on=2026-03-30')).body;
  ok(JA.test(elig.reason ?? ''), 'a judgement explains itself in Japanese', elig.reason);

  // 出典の注記も同じ。数字の根拠を確かめる人が読むところ。
  const inv = (await get('/v1/invoice-number/validate?number=T8700110005901')).body;
  ok(JA.test(inv.attribution?.note ?? ''),
     'and so does the caveat on a source', inv.attribution?.note?.slice(0, 50));
}
{
  // API を叩く掃引だけでは足りなかった。
  //
  // 前のブロックの掃引は「人が読む文言 138 件、欧文 0」と報告したが、left_on を
  // 渡したときの eligibility は英語のままだった。掃引が必須パラメータだけで呼ぶので、
  // 分岐に入る文言に届かない。第6反復で見つけたのと同じ偏り —
  // **自動の網から漏れるのは、条件が多い＝重要な経路のほう。**
  //
  // ソースを直接読めば、呼ばれ方によらず全部見える。API 側の掃引と両方置く。
  const files = [
    'index.ts', 'lib.ts', 'eligibility.ts', 'holidays.ts', 'corporate-number.ts',
    'payslip.ts', 'age.ts', 'freshness.ts', 'leave-exemption.ts', 'bonus.ts',
    'bonus-insurance.ts', 'remuneration-revision.ts', 'worker-type.ts',
    'annual-leave.ts', 'national-insurance.ts', 'allowances.ts', 'overtime.ts',
    'workers-comp.ts', 'statutes.ts', 'withholding.ts', 'batch.ts',
  ];
  const JA = /[ぁ-んァ-ヶ一-龥]/;
  // 人が読むキー。code / key / value / url は機械が読むので入れない。
  const KEY = /(reason|note|basis|summary|description|caveat|hint|why|meaning|label|applies_to|covers)\s*:\s*\n?\s*['`]([^'`]{20,})['`]/g;

  const leftovers = [];
  let scanned = 0;
  for (const name of files) {
    let src;
    try {
      src = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    } catch { continue; }
    scanned++;
    for (const m of src.matchAll(KEY)) {
      if (!JA.test(m[2])) leftovers.push(`src/${name}: ${m[1]} = ${m[2].slice(0, 40)}`);
    }
  }
  ok(scanned >= 15, 'the source sweep covers the modules that carry prose', `${scanned} files`);
  ok(leftovers.length === 0,
     'and no branch left in English, including the ones a parameter sweep never reaches',
     leftovers.slice(0, 5).join(' | ') || 'none');

  // 掃引が届かない分岐を名指しで確かめる。網の目からこぼれた先こそ見る。
  for (const [q, label] of [
    ['month=2026-03&left_on=2026-03-30', '喪失月'],
    ['month=2026-03&left_on=2026-03-31', '月末退職'],
    ['month=2026-03&joined_on=2026-04-01', '入社前'],
    ['month=2026-03&joined_on=2026-03-05&left_on=2026-03-20', '同月得喪'],
  ]) {
    const r = (await get(`/v1/eligibility?${q}`)).body;
    ok(JA.test(r.reason ?? '') && !/[A-Za-z]{5,}/.test(r.reason ?? ''),
       `${label} の理由が和文で返る`, r.reason?.slice(0, 46));
  }
  for (const [path, label] of [
    ['/v1/corporate-number/validate?number=abc', '法人番号 非数字'],
    ['/v1/corporate-number/validate?number=123', '法人番号 桁不足'],
    ['/v1/invoice-number/validate?number=X123', '登録番号 先頭違い'],
  ]) {
    const r = (await get(path)).body;
    ok(JA.test(r.reason ?? ''), `${label} の理由が和文で返る`, r.reason?.slice(0, 40));
  }
}
{
  // 走査を二度、狭く作ってしまった。
  //
  // 一度目はキー名(reason / note / basis)で探して37件。三項演算子の片側だけ訳した
  // のをテストが捕まえたので、二度目は文字列リテラル全部に広げた。ところが英文の
  // 条件を「4文字以上+3文字以上+3文字以上の3語連続」にしたため、177件で止まった。
  // 英語の散文は in / on / is / not のような短い機能語で埋まっている。だから
  // `The minimum wage in force on ...` も `"months" needs exactly 3 entries` も
  // すり抜けた。**入力を間違えた瞬間に読む文言ほど短く、いちばん漏れていた。**
  //
  // 語長ではなく機能語で数える。ただしパラメータ名・URL・ヘッダ値は数えない。
  // そこを数えたせいで「No.2585」「from=&to=」が英文と誤判定されていた。
  const FUNC = /\b(the|is|are|was|an|of|in|on|to|and|for|not|this|that|it|be|with|from|only|when|must|needs?|cannot|its|but|by|or|at|you|your|has|have|does|do|so|if|any|all|each|per|than|then|there|here|which|what|why|how|into|over|under|between|because|rather|instead|whether|while|would|should|could|may|can|will|use|pass|got|see|add)\b/gi;
  const NOISE = /https?:\/\/\S+|\$\{[^}]*\}?|\/v1\/[\w/-]+|\b[a-z][a-z_-]*=\S*|No\.\d+|\b[A-Z]\d{6,}\b|[「"][a-z_]+[」"]/g;
  const JA = /[ぁ-んァ-ヶ一-龥]/;
  const KANA = /[ぁ-んァ-ヶ]/;
  const STR = /'[^'\n]*'|`[^`\n]*`|"[^"\n]*"/g;
  // Peppol の 0188 は登録された識別子の正式名称で、訳すと別のものを指す。
  const KEEP_WHOLE = ['0188 (Corporate Number of Japan, ISO 6523 ICD)'];
  // 散文に出て当たり前の固有名詞・頭字語・HTTPの status phrase。
  const KEEP_WORDS = new Set(`YYYY MM DD ISO ICD Peppol Gov API Web BASIC RapidAPI MCP JIS NTA
    PDL UTC GET POST Japan Public Data License Tokyo Conflict Unprocessable Content`.split(/\s+/));

  const dir = new URL('../src/', import.meta.url);
  const names = (await readdir(dir, { recursive: true }))
    .filter((n) => n.endsWith('.ts')).map((n) => n.replace(/\\/g, '/'));
  const sources = new Map();
  for (const n of names) sources.set(n, await readFile(new URL(n, dir), 'utf8'));

  // 許可語は手で並べない。**コードに識別子として在る語**と、列挙値として単独で
  // 現れる語を許可する。フィールドを増やせば許可も自動で増える。手書きの一覧は
  // 私が思い付いた分しか載らず、それがこの周回で三度漏れた原因だった。
  const allowed = new Set(KEEP_WORDS);
  for (const src of sources.values()) {
    for (const m of src.matchAll(STR)) {
      const v = m[0].slice(1, -1);
      if (/^[a-z][a-z0-9_]*$/.test(v)) allowed.add(v);
    }
    for (const w of src.replace(STR, ' ').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) allowed.add(w[0]);
  }

  // 12文字の下限が `Not found`(9文字)を落としていた。404と500という、
  // **迷った人がいちばん最初に見る2つ**が英語のまま残っていた。
  // error / hint / bad( / fail( の直後だけは、短くても見る。
  const SHORT = /(?:error:|hint:|bad\(c,|fail\()\s*['"]([^'"\n]{4,24})['"]/g;
  const shortEnglish = [];
  for (const [name, text] of sources) {
    for (const [i, line] of text.split(String.fromCharCode(10)).entries()) {
      const st = line.trim();
      if (st.startsWith('*') || st.startsWith('//') || st.startsWith('/*')) continue;
      for (const m of line.matchAll(SHORT)) {
        const t = m[1];
        if (JA.test(t)) continue;
        const stray = (t.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) ?? []).filter((w) => !allowed.has(w));
        if (stray.length) shortEnglish.push(`src/${name}:${i + 1} "${t}"`);
      }
    }
  }
  ok(shortEnglish.length === 0, 'including the short ones a length threshold would skip',
     shortEnglish.slice(0, 4).join(' | ') || 'none');

  const english = [], prose = [], frag = [];
  for (const [name, src] of sources) {
    for (const [i, line] of src.split('\n').entries()) {
      const st = line.trim();
      if (st.startsWith('*') || st.startsWith('//') || st.startsWith('/*')) continue;
      for (const m of line.matchAll(/['`]([^'`\n]{12,})['`]/g)) {
        const t = m[1];
        if (KEEP_WHOLE.includes(t)) continue;
        const at = `src/${name}:${i + 1} ${t.slice(0, 40)}`;
        // かなの直後に小文字ラテン = 部分置換の残骸。正しい並びは API や YYYY で大文字。
        if (/[ぁ-んァ-ヶ][a-z]/.test(t)) frag.push(at);
        const clean = t.replace(NOISE, ' ');
        if (!JA.test(t)) {
          if ((clean.match(FUNC) ?? []).length >= 1) english.push(at);
        } else if (KANA.test(t)) {
          // 和文に混じる英字は、識別子か列挙値でなければ散文の残り。
          const stray = (clean.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) ?? []).filter((w) => !allowed.has(w));
          if (stray.length) prose.push(`${at} → ${stray.slice(0, 3).join(',')}`);
        }
      }
    }
  }
  ok(names.length >= 20, 'the sweep reads every module under src/, not a list I keep up to date', `${names.length} files`);
  ok(allowed.size >= 1500, 'and the allow-list is built from the code, so new fields need no edit here', `${allowed.size} tokens`);
  ok(english.length === 0, 'no sentence is left in English, however short', english.slice(0, 4).join(' | ') || 'none');
  ok(prose.length === 0, 'no English survives inside a Japanese one either', prose.slice(0, 4).join(' | ') || 'none');
  ok(frag.length === 0, 'and no partial replace left the tail of the original behind', frag.slice(0, 4).join(' | ') || 'none');

  // 入力を間違えた瞬間に言語が切り替わらないこと。ここが本体。
  //
  // 手で並べた一覧では、私が思い付いた経路しか踏めない。実際 `Unknown column:`
  // の6箇所は、静的走査(${...} を除くと機能語が0語になる)も、私が書いた17件の
  // 一覧も、どちらもすり抜けた。だから経路を仕様書から取る。全パス×全パラメータに
  // 不正値を投げて、エンドポイントごとの検証を書き漏らしなく踏む。
  const spec = (await get('/openapi.json')).body;
  const engRuntime = [];
  let refused = 0;
  for (const [path, ops] of Object.entries(spec.paths)) {
    if (!ops.get) continue;
    for (const url of [path, ...(ops.get.parameters ?? []).map((q) => `${path}?${q.name}=zz`)]) {
      const r = await get(url);
      if (r.status < 400) continue;
      refused++;
      for (const k of ['error', 'hint']) {
        const v = r.body?.[k];
        if (typeof v === 'string' && v && !JA.test(v)) engRuntime.push(`${url} ${k}: ${v.slice(0, 46)}`);
      }
    }
  }
  ok(refused >= 60, 'the sweep reached that many validators, so it is not vacuous', `${refused} refusals`);
  ok(engRuntime.length === 0, 'and every refusal along the way speaks Japanese',
     engRuntime.slice(0, 5).join(' | ') || 'none');

  const postJson = async (path, body) => {
    const r = await tryFetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  for (const path of Object.entries(spec.paths).filter(([, o]) => o.post).map(([p]) => p)) {
    const r = await postJson(path, {});
    ok(r.status >= 400, `POST ${path} は空の本文を拒否する`, `${r.status}`);
    ok(JA.test(r.body.error ?? ''), `POST ${path} のエラー文が和文`, r.body.error?.slice(0, 44));
  }

  // code は英字のまま。読む人向けの文と、分岐に使う値は別物。
  for (const [path, want] of [
    ['/v1/payroll?prefecture=Tokyo&monthly_salary=300000&age=40&zzz=1', 'unknown_parameter'],
    ['/v1/payroll?prefecture=Atlantis&monthly_salary=300000&age=40', 'unknown_prefecture'],
    ['/v1/holidays?year=2100', 'out_of_coverage'],
  ]) {
    const r = await get(path);
    ok(r.body.code === want, `${want} は機械可読のまま`, r.body.code);
  }
}
{
  // 空の値は、渡さなかったのとは違う。
  //
  // `?weekly_hours=` は 400 ではなく 200 を返し、`Number('')` が 0 になるので
  // 0時間として判定していた。テンプレートが空を吐いた利用者は、エラーではなく
  // 「被保険者でない」という**もっともらしい誤答**を受け取っていた。
  //
  // 実測してから直した。128組のうち空文字で200が返ったのは7組、うち5組は
  // 「渡されなかった」扱いで正しく、実害は2組だった。それでも直すのは中央で。
  // 第8反復で「触った9本だけ」を直して残りを見落としたのと同じ形になるため。
  const spec = (await get('/openapi.json')).body;
  const leaked = [], kept = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    if (!ops.get) continue;
    for (const q of ops.get.parameters ?? []) {
      const r = await get(`${path}?${q.name}=`);
      if (r.status === 200) leaked.push(`${path}?${q.name}=`);
      else if (r.body?.code === 'empty_parameter') kept.push(q.name);
    }
  }
  ok(leaked.length === 0, 'an empty value is refused on every parameter, not the two I found',
     leaked.slice(0, 5).join(' | ') || 'none');
  ok(kept.length >= 100, 'and the refusal is the central one, so a new endpoint gets it for free',
     `${kept.length} parameters`);

  // 省略はこれまでどおり通る。ここを壊すと、いま動いている呼び出しが落ちる。
  for (const path of ['/v1/workers-compensation', '/v1/consumption-tax',
                      '/v1/commuting-allowance', '/v1/eligibility']) {
    const r = await get(path);
    ok(r.status === 200, `${path} は省略時はこれまでどおり答える`, `${r.status}`);
  }

  const empty = await get('/v1/worker-type?weekly_hours=');
  ok(empty.status === 400, 'the case that started this returns 400', `${empty.status}`);
  ok(empty.body.code === 'empty_parameter', 'with a code of its own, not lumped into invalid_request');
  ok(/値が空/.test(empty.body.error ?? ''), 'and says the value is empty, not that it is wrong');
  ok(/外して/.test(empty.body.hint ?? ''), 'and says to drop the parameter instead');

  // POST も同じ検査を通ること。第8反復の見落としがここに残っていた。
  const postJson = async (path, body, q = '') => {
    const r = await tryFetch(BASE + path + q, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const posts = Object.entries(spec.paths).filter(([, o]) => o.post).map(([p]) => p);
  ok(posts.length === 4, 'there are four POSTs to check', `${posts.length}`);
  for (const path of posts) {
    const r = await postJson(path, {}, '?zzz=1');
    ok(r.status === 400 && r.body.code === 'unknown_parameter',
       `POST ${path} も未知のクエリを拒否する`, `${r.status} ${r.body.code}`);
  }

  // run_id は経路を含む。同じ本文でも、別の処理なら別の実行。
  const body = { employees: [{ prefecture: 'Tokyo', monthly_salary: 300000, age: 40 }],
                 numbers: ['T8700110005901'] };
  const a = await postJson('/v1/payroll/batch', body);
  const b = await postJson('/v1/invoice-number/validate/batch', body);
  ok(a.body.run_id && b.body.run_id, 'both return a run_id');
  ok(a.body.run_id !== b.body.run_id,
     'and the same body on a different route is a different run — a ledger keyed on run_id would have merged them',
     `${a.body.run_id} vs ${b.body.run_id}`);
  const again = await postJson('/v1/payroll/batch', body);
  ok(a.body.run_id === again.body.run_id, 'while the same call is still the same run', again.body.run_id);
}
{
  // 課金側の商品棚。買う人が読むのは説明ページで、そこに無い機能は無いのと同じ。
  //
  // Endpointsタブは仕様書から自動生成されるので43本とも呼べる状態にはある。
  // 抜けていたのは購入判断に使われるほうで、割増賃金・年次有給休暇・被保険者区分・
  // 労災保険率・国民年金・通勤手当・年額コスト・消費税の8領域が載っていなかった。
  // **第1〜第2反復で「臨界経路の穴」と呼んで塞いだものが、買い手に見えていなかった。**
  const doc = await readFile(new URL('../recipes/jp-payroll/rapidapi-docs.md', import.meta.url), 'utf8');
  const spec = (await get('/openapi.json')).body;
  const n = Object.keys(spec.paths).filter((p) => p.startsWith('/v1/')).length;

  // 機能領域は、その領域を実装しているエンドポイントの存在から導く。
  // 手で並べた一覧だと、次に足す領域がまた抜ける。
  const AREAS = [
    ['/v1/overtime-pay', '割増賃金'],
    ['/v1/annual-leave', '年次有給休暇'],
    ['/v1/worker-type', '被保険者区分'],
    ['/v1/workers-compensation', '労災保険率'],
    ['/v1/national-insurance', '国民年金'],
    ['/v1/commuting-allowance', 'commuting allowance'],
    ['/v1/annual-cost', 'a year of employing'],
    ['/v1/consumption-tax', 'Consumption tax'],
    ['/v1/statute', 'e-Gov'],
    ['/v1/minimum-wage', 'Minimum wage'],
  ];
  const live = AREAS.filter(([p]) => p in spec.paths);
  ok(live.length === AREAS.length, 'every area named here still has an endpoint behind it',
     AREAS.filter(([p]) => !(p in spec.paths)).map(([p]) => p).join(', ') || 'none');
  const unsold = live.filter(([, phrase]) => !doc.includes(phrase)).map(([p]) => p);
  ok(unsold.length === 0, 'and the page a buyer reads mentions each of them',
     unsold.join(', ') || 'none');
  ok(doc.includes(`${n} endpoints`),
     'while the count it advertises matches what is deployed', `spec has ${n}`);

  // 課金仕様そのものも実態に追いつくこと。ここが遅れると、作った機能に課金できない。
  const recipe = await readFile(new URL('../recipes/jp-payroll/recipe.py', import.meta.url), 'utf8');
  const notPriced = Object.keys(spec.paths).filter((p) => p.startsWith('/v1/') && !recipe.includes(p));
  ok(notPriced.length === 0, 'and every endpoint reaches the paid spec at all',
     notPriced.join(', ') || 'none');
}
























console.log(`\n  passed ${pass} / ${pass + fail}`);
if (fail) { console.log('\n  FAILURES:'); failures.forEach((f) => console.log('   - ' + f)); process.exit(1); }
console.log('  all checks green\n');
