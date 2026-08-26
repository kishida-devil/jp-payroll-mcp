import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  insurance, minwage, empins,
  resolvePrefecture, roundEmployeeShare, findGrade,
  pensionStandardRemuneration, isLtcInsured, minimumWageAt,
  ATTRIBUTION, type PrefKey,
} from './lib';
import ctax from './data/consumption-tax.json';
// Served at /openapi.json so a marketplace or a client generator can import
// by URL instead of a file upload, and always gets the deployed version
// rather than whatever spec someone downloaded once.
import openapiSpec from './data/openapi.json';
import {
  STATUTE_ATTRIBUTION, STATUTE_INDEX, STATUTE_LAWS,
  attachStatuteText, statuteDetail,
} from './statutes';
import { freshnessOf, freshnessReport } from './freshness';
import {
  MAX_DEPENDANTS_IN_TABLE, TABLE_MAX, TABLE_MIN, WITHHOLDING_ATTRIBUTION,
  withholdingTax, type Column,
} from './withholding';
import { COMPUTER_ATTRIBUTION, computerMethod } from './withholding-computer';
import { MAX_BATCH, runBatch, type BatchDefaults, type BatchRow, type Detail } from './batch';
import { computePayslip } from './payslip';
import { BONUS_ATTRIBUTION, BONUS_EXCEPTIONS, bonusWithholding } from './bonus';
import { BONUS_INSURANCE_ATTRIBUTION, bonusInsurance } from './bonus-insurance';
import { AGE_RULES, ageStatus, parseDate } from './age';
import { ELIGIBILITY_ATTRIBUTION, eligibilityFor } from './eligibility';
import { LEAVE_ATTRIBUTION, leaveExemption, type LeaveKind } from './leave-exemption';
import {
  FIXED_PAY_GUIDANCE, PAYMENT_BASIS_DAYS_GUIDANCE, REGULAR_DECISION_EXCLUSIONS,
  REVISION_ATTRIBUTION, acquisitionDecisionPeriod, annualAverageRegular,
  annualAverageRevision, judgeLeaveEndRevision, judgeRegularDecision, judgeRevision,
  type AnnualMonth, type PayMonth, type WorkerType,
} from './remuneration-revision';
import {
  DAILY_ATTRIBUTION, DAILY_MAX, DAILY_MAX_DEPENDANTS, DAILY_MIN,
  dailyWithholdingTax, type DailyColumn,
} from './withholding-daily';
import {
  CORPORATE_NUMBER_ATTRIBUTION, INVOICE_NUMBER_ATTRIBUTION,
  fromBaseNumber, validateCorporateNumber, validateInvoiceNumber,
} from './corporate-number';
import {
  BANK_CALENDAR, COVERAGE, HOLIDAY_META, closureReasons, countBusinessDays,
  getHoliday, holidaysBetween, holidaysInYear, inCoverage, isBusinessDay,
  isOpenOn, isWeekend, parseISO, shiftBusinessDays, toISO, type Calendar,
} from './holidays';

/** Cloudflare's Rate Limiting binding, typed structurally so this file does not
 *  depend on which name the workers-types version happens to export. */
type RateLimiter = { limit(o: { key: string }): Promise<{ success: boolean }> };
type Env = {
  FREE_TIER?: RateLimiter;
  /** From RapidAPI's Security tab. Set with `wrangler secret put RAPIDAPI_PROXY_SECRET`. */
  RAPIDAPI_PROXY_SECRET?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));

/**
 * Which channel a request came through. Without this the question "is the MCP
 * server actually bringing anyone in?" has no answer — every request looks alike
 * in the dashboard, and a channel that is working is indistinguishable from one
 * that nobody found.
 *
 * RapidAPI is identified by the headers its proxy adds, not by anything the
 * caller sets, so it cannot be spoofed into the wrong bucket by accident.
 */
function channelOf(c: any): 'mcp' | 'rapidapi' | 'direct' {
  if (c.req.header('x-rapidapi-proxy-secret') || c.req.header('x-rapidapi-host')) return 'rapidapi';
  return /jp-payroll-mcp/i.test(c.req.header('user-agent') ?? '') ? 'mcp' : 'direct';
}

/**
 * The free tier, and the one place its shape is defined.
 *
 * Two limits rather than one, because they catch different users. A per-minute
 * rate limit does nothing to the case that actually costs money: an employer
 * running 500 payslips uses the batch endpoint and that is a *single* request.
 * So the batch row cap is the real boundary, and the rate limit is only a
 * backstop against someone looping the single-payslip endpoint instead.
 *
 * The free tier is deliberately generous — interactive use through an assistant
 * never approaches either figure. What it is not is a way to run a payroll
 * product for nothing.
 */
const FREE_TIER = {
  requests_per_minute: 300,
  batch_rows: 10,
};

const UPGRADE = {
  where: 'https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants',
  what: 'Higher limits and full-size batches, with billing, keys and quotas handled there.',
};

/** Local development is exempt: a test suite is not a customer. */
const isLocal = (c: any) => {
  const host = new URL(c.req.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
};

/**
 * What a caller is entitled to, which is a different question from which channel
 * they arrived on.
 *
 * `channelOf` reads `x-rapidapi-host`, a header any client can set. That is fine
 * for analytics — a mislabelled row in a dashboard costs nothing. It is not fine
 * for deciding what somebody gets for free, because then `curl -H
 * "X-RapidAPI-Host: anything"` is a paid plan. Entitlement therefore rests on
 * `x-rapidapi-proxy-secret`, which only RapidAPI's runtime can send.
 *
 * RapidAPI's BASIC plan is free, so arriving through RapidAPI is not the same as
 * paying. `X-RapidAPI-Subscription` distinguishes them (BASIC / PRO / ULTRA /
 * MEGA / CUSTOM).
 *
 * Until the secret is configured the check cannot run, so the old behaviour is
 * kept — a live listing must not break because a secret has not been set yet —
 * and each such request is logged as unverified so the gap is visible rather
 * than silent.
 */
function entitlement(c: any): { paid: boolean; plan: string | null; verified: boolean } {
  if (isLocal(c)) return { paid: true, plan: 'local', verified: true };

  const configured = c.env?.RAPIDAPI_PROXY_SECRET;
  const plan = (c.req.header('x-rapidapi-subscription') ?? '').toUpperCase() || null;

  if (!configured)
    return { paid: channelOf(c) === 'rapidapi', plan, verified: false };

  if (c.req.header('x-rapidapi-proxy-secret') !== configured)
    return { paid: false, plan: null, verified: true };

  // A verified RapidAPI caller on anything other than the free BASIC plan.
  return { paid: plan !== null && plan !== 'BASIC', plan, verified: true };
}

app.use('*', async (c, next) => {
  const channel = channelOf(c);
  const local = isLocal(c);
  // RapidAPI traffic is metered on their side; limiting it again here would just
  // break something a customer already paid for.
  if (channel !== 'rapidapi' && !local && c.env?.FREE_TIER) {
    const key = c.req.header('cf-connecting-ip') ?? 'anonymous';
    const { success } = await c.env.FREE_TIER.limit({ key });
    if (!success)
      return c.json({
        error: `Free tier limit reached: ${FREE_TIER.requests_per_minute} requests per minute.`,
        code: 'rate_limited',
        hint: 'This applies to direct and MCP access. For production volume, see the ' +
          'RapidAPI listing. ' + UPGRADE.what,
        free_tier: FREE_TIER,
        upgrade: UPGRADE.where,
      }, 429);
  }

  await next();

  // `include=statute_text` は個々のハンドラに配線していない。34本すべてに同じ分岐を
  // 足すのは、34箇所の書き忘れる機会を作ることでもある。ここで一度だけ、返された
  // ボディが引用している条文を拾って足す。
  //
  // 既定で足さないのは、レスポンスが既に大きく、判定結果だけを見たい呼び出しでは
  // 条文本文が純粋なノイズになるため。
  if (c.req.query('include') === 'statute_text' && c.res.status === 200) {
    const body = await c.res.clone().json().catch(() => null);
    if (body && typeof body === 'object') {
      const attached = attachStatuteText(body);
      if (attached.count > 0)
        c.res = new Response(
          JSON.stringify({ ...(body as object), statute_text: attached }),
          { status: 200, headers: c.res.headers });
    }
  }

  // One structured line per request, picked up by Workers Logs. Filter on
  // channel in the dashboard to see whether MCP is converting into API use.
  //
  // Skipped in local development: `wrangler dev` echoes every line to the
  // terminal, and there is nothing to analyse locally anyway.
  if (!local) {
    const ent = entitlement(c);
    console.log(JSON.stringify({
      channel, path: new URL(c.req.url).pathname, status: c.res.status,
      plan: ent.plan,
      // Flags requests whose entitlement could not be checked because
      // RAPIDAPI_PROXY_SECRET is not set. Filter on this to confirm the gap is
      // closed after configuring it.
      ...(ent.verified ? {} : { unverified: true }),
    }));
  }
  // Reference data changes on known dates (rates in March/April, minimum wage in
  // October), and a fix should reach callers the same day rather than a day late.
  // An hour is long enough to absorb bursts without pinning stale figures.
  c.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
});

/**
 * Errors carry a stable `code` alongside the prose. Integrators need to branch on
 * "the caller sent something wrong" versus "the date is outside what we publish",
 * and matching on English sentences breaks the moment the wording improves.
 */
const bad = (c: any, message: string, hint?: string, code = 'invalid_request') =>
  c.json({ error: message, code, ...(hint ? { hint } : {}) }, 400);

const needPref = (c: any) => {
  const raw = c.req.query('prefecture') ?? c.req.query('pref');
  const pref = resolvePrefecture(raw ?? null);
  if (!pref) {
    return {
      err: bad(c, raw ? `Unknown prefecture: "${raw}"` : 'Missing required query parameter: prefecture',
        'Accepts English name ("Tokyo"), Japanese ("東京" / "東京都"), or JIS code 1-47. See /v1/prefectures.',
        raw ? 'unknown_prefecture' : 'missing_parameter'),
    };
  }
  return { pref };
};

app.get('/', (c) =>
  c.json({
    name: 'Japan Payroll and Labor Constants API',
    description:
      'Japanese statutory reference data in one API — social and employment insurance rates for all 47 prefectures, the 50-grade standard remuneration table, 24 years of minimum wage history, public holidays with business-day arithmetic, consumption tax since 1989, and corporate/invoice number validation. Extracted programmatically from government open data and verified against the published figures.',
    version: '2.9.0',
    endpoints: {
      'GET /v1/prefectures': 'All 47 prefectures with JIS codes and Japanese names',
      'GET /v1/insurance-rates?prefecture=Tokyo': 'Health, long-term care, pension and child-support rates',
      'GET /v1/standard-remuneration?remuneration=350000': 'Standard monthly remuneration grade lookup',
      'GET /v1/standard-remuneration/table': 'Full 50-grade table',
      'GET /v1/employment-insurance?business_type=general': 'Employment insurance rates by business type',
      'GET /v1/minimum-wage?prefecture=Tokyo&date=2020-01-01': 'Minimum wage in effect on a date',
      'GET /v1/minimum-wage/history?prefecture=Tokyo': 'Full history since FY2002',
      'GET /v1/payroll?prefecture=Tokyo&monthly_salary=350000&age=40&dependants=2': 'Full monthly payslip: social insurance, income tax and net pay in one call',
      'GET /v1/holidays?year=2026': 'Public holidays for a year (or from=&to= for a range)',
      'GET /v1/holidays/check?date=2026-01-01': 'Is a date a holiday, weekend or business day',
      'GET /v1/business-days?from=2026-01-01&to=2026-03-31': 'Count business days in a range',
      'GET /v1/business-days/shift?date=2026-01-01&days=1': 'Move N business days forward or back',
      'calendar=bank': 'Add &calendar=bank to any business-day endpoint for the statutory banking calendar (銀行法施行令第5条): also closed 12/31-1/3',
      'GET /v1/consumption-tax?date=2015-01-01&amount=1000': 'Consumption tax rate in force, optionally applied to an amount',
      'GET /v1/consumption-tax/history': 'Every rate change since 1989',
      'GET /v1/corporate-number/validate?number=8700110005901': 'Validate a 法人番号 check digit (Peppol ICD 0188)',
      'GET /v1/corporate-number/check-digit?base=700110005901': 'Compute the check digit for a 12-digit base number',
      'GET /v1/invoice-number/validate?number=T8700110005901': 'Validate a qualified invoice registration number',
      'GET /v1/withholding-tax?taxable_amount=300000&dependants=2': 'Monthly withholding income tax (源泉徴収税額表 月額表)',
      'GET /v1/withholding-tax/daily?taxable_amount=12000&column=hei': 'Daily withholding table (日額表), including the 丙 column',
      'GET /v1/withholding-tax/computer?taxable_amount=300000&dependants=2': 'Same tax by the statutory formula method (電算機計算の特例)',
      'POST /v1/payroll/batch': `Up to ${MAX_BATCH} payslips in one call, with run totals (free tier: ${FREE_TIER.batch_rows} per batch)`,
      'GET /v1/leave-exemption?kind=childcare&start=2026-03-15&end=2026-03-28': 'Which months of social insurance a maternity or childcare leave exempts',
      'GET /v1/eligibility?month=2026-03&left_on=2026-03-30': 'Whether social insurance is due in a joining or leaving month',
      'GET /v1/age-milestones?birth_date=1986-04-01': 'When 40, 65, 70 and 75 are reached and what each changes',
      'GET /v1/bonus-insurance?prefecture=Tokyo&bonus=800000&age=40': 'Social insurance on a bonus, with the annual and per-payment caps',
      'GET /v1/bonus-tax?bonus=500000&previous_month_pay=350000&previous_month_insurance=55750&dependants=2': 'Withholding tax on a bonus (賞与の算出率表)',
      'GET /v1/standard-remuneration/revision?current_remuneration=300000&months=350000:31,352000:30,349000:31&fixed_pay_change=increase': 'Is a 随時改定 (月額変更) due? Judges health and pension separately',
      'GET /v1/standard-remuneration/regular?months=350000:30,352000:31,349000:30': 'Annual 定時決定 (算定基礎) from April-June pay',
      'GET /v1/standard-remuneration/leave-end?kind=childcare&current_remuneration=300000&months=260000:31,258000:30,262000:31': 'Revision on returning from maternity or childcare leave (one grade is enough)',
      'POST /v1/standard-remuneration/annual-average': 'Seasonal work: 年間平均による保険者算定 for either determination',
      'GET /v1/statute?ref=健康保険法第43条': 'Full text of a provision this API cites — 健保法43条 and 厚年法81条の2 resolve too',
      'GET /v1/statute/index': 'Every provision available, with its law',
      'include=statute_text': 'Add to any endpoint to attach the text of whatever it cited',
      'GET /v1/enums': 'Every accepted enum value and error code, for build-time reference',
      'GET /v1/data-freshness': 'What each dataset covers and when it is next due to change',
    },
    free_tier: {
      ...FREE_TIER,
      applies_to: 'Direct and MCP access, and the free BASIC plan on RapidAPI. Paid RapidAPI plans are metered by RapidAPI instead.',
      entitlement_verified: !!c.env?.RAPIDAPI_PROXY_SECRET,
      upgrade: UPGRADE.where,
      note: UPGRADE.what,
    },
    attribution: ATTRIBUTION,
  }));

/**
 * 引用した条文の本文。判定エンドポイントは根拠を示すが本文は返さないので、
 * 条文番号を受け取った利用者が e-Gov を開き直す手間がここで消える。
 */
app.get('/v1/statute', (c) => {
  const ref = c.req.query('ref');
  if (!ref)
    return bad(c, '"ref" is required.',
      'A citation such as "健康保険法第43条". See GET /v1/statute/index for everything available. ' +
      'Abbreviations (健保法43条) and paragraph-level references (第43条第1項) resolve to the article.');

  const detail = statuteDetail(ref);
  if (!detail)
    return bad(c, `No provision is bundled for "${ref}".`,
      'Only the provisions this API actually cites are bundled — see GET /v1/statute/index. ' +
      'For anything else, e-Gov 法令検索 has the full corpus: https://laws.e-gov.go.jp/',
      'out_of_coverage');

  return c.json({ ...detail, attribution: STATUTE_ATTRIBUTION });
});

app.get('/v1/statute/index', (c) =>
  c.json({
    count: STATUTE_INDEX.length,
    laws: STATUTE_LAWS,
    provisions: STATUTE_INDEX,
    note:
      'Every provision this API cites, with its text. Add ?include=statute_text to a judgement ' +
      'endpoint to have the text of whatever it cited attached to the answer.',
    attribution: STATUTE_ATTRIBUTION,
  }));

app.get('/openapi.json', (c) => {
  c.header('Content-Type', 'application/json; charset=utf-8');
  return c.body(JSON.stringify(openapiSpec));
});

app.get('/v1/prefectures', (c) =>
  c.json({
    count: 47,
    prefectures: Object.entries(insurance.prefectures).map(([en, v]) => ({
      name: en, name_ja: v.prefecture_ja, code: v.code,
    })),
  }));

app.get('/v1/insurance-rates', (c) => {
  const r = needPref(c); if ('err' in r) return r.err;
  const p = insurance.prefectures[r.pref];
  return c.json({
    prefecture: r.pref, prefecture_ja: p.prefecture_ja, code: p.code,
    fiscal_year: insurance.meta.fiscal_year, effective_from: insurance.meta.effective_from,
    rates: {
      health_insurance: p.health_insurance_rate,
      long_term_care: p.long_term_care_rate,
      pension: p.pension_rate,
      child_support: p.child_support_rate,
      child_care_contribution_employer_only: insurance.meta.child_care_contribution_rate,
    },
    notes: {
      split: 'Health, long-term care, pension and child-support premiums are split 50/50 between employee and employer.',
      long_term_care: 'Long-term care applies only to employees aged 40-64 (介護保険第2号被保険者).',
      bonus_caps: {
        health_annual: insurance.meta.bonus_cap_health_annual,
        pension_monthly: insurance.meta.bonus_cap_pension_monthly,
      },
    },
    freshness: freshnessOf('social_insurance', new Date()),
    attribution: ATTRIBUTION.social_insurance,
  });
});

app.get('/v1/standard-remuneration/table', (c) =>
  c.json({
    fiscal_year: insurance.meta.fiscal_year,
    health_grades: 50, pension_grades: 32,
    grades: insurance.grades,
    attribution: ATTRIBUTION.social_insurance,
  }));

app.get('/v1/standard-remuneration', (c) => {
  const raw = c.req.query('remuneration') ?? c.req.query('monthly_salary');
  const rem = Number(raw);
  if (!raw || !Number.isFinite(rem) || rem < 0)
    return bad(c, 'Query parameter "remuneration" must be a non-negative number (monthly yen).');
  const g = findGrade(rem);
  const pen = pensionStandardRemuneration(g);
  return c.json({
    remuneration: rem,
    health: { grade: g.health_grade, standard_monthly_remuneration: g.standard_monthly_remuneration },
    pension: { grade: pen.grade, standard_monthly_remuneration: pen.smr, clamped: pen.clamped },
    range: { from: g.remuneration_from, to: g.remuneration_to },
    attribution: ATTRIBUTION.social_insurance,
  });
});

app.get('/v1/employment-insurance', (c) => {
  const t = (c.req.query('business_type') ?? 'general').toLowerCase();
  const bt = (empins.business_types as any)[t];
  if (!bt)
    return bad(c, `Unknown business_type: "${t}"`,
      `One of: ${Object.keys(empins.business_types).join(', ')}`);
  return c.json({
    business_type: t, label_ja: bt.label_ja,
    fiscal_year: empins.meta.fiscal_year, effective_from: empins.meta.effective_from,
    rates: { employee: bt.employee_rate, employer: bt.employer_rate, total: bt.total_rate },
    breakdown: bt.breakdown,
    note: empins.meta.note,
    freshness: freshnessOf('employment_insurance', new Date()),
    attribution: ATTRIBUTION.employment_insurance,
  });
});

app.get('/v1/minimum-wage', (c) => {
  const r = needPref(c); if ('err' in r) return r.err;
  const date = c.req.query('date') ?? null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return bad(c, 'Query parameter "date" must be ISO format YYYY-MM-DD.');
  const row = minimumWageAt(r.pref, date);
  if (!row)
    return c.json({
      error: `No minimum wage on record for ${r.pref} on or before ${date}.`,
      code: 'out_of_coverage', earliest_fiscal_year: 2002,
    }, 404);
  const p = (minwage.prefectures as any)[r.pref];
  return c.json({
    prefecture: r.pref, prefecture_ja: p.prefecture_ja, code: p.code,
    ...(date ? { queried_date: date } : {}),
    hourly_wage: row.hourly_wage, currency: 'JPY',
    fiscal_year: row.fiscal_year, era_year: row.era_year,
    effective_from: row.effective_from, is_latest: row.latest,
    freshness: freshnessOf('minimum_wage', new Date()),
    attribution: ATTRIBUTION.minimum_wage,
  });
});

app.get('/v1/minimum-wage/history', (c) => {
  const r = needPref(c); if ('err' in r) return r.err;
  const p = (minwage.prefectures as any)[r.pref];
  return c.json({
    prefecture: r.pref, prefecture_ja: p.prefecture_ja, code: p.code,
    count: p.history.length, history: p.history,
    attribution: ATTRIBUTION.minimum_wage,
  });
});

app.get('/v1/payroll', (c) => {
  const r = needPref(c); if ('err' in r) return r.err;

  const salaryRaw = c.req.query('monthly_salary');
  const salary = Number(salaryRaw);
  if (!salaryRaw || !Number.isFinite(salary) || salary < 0)
    return bad(c, 'Query parameter "monthly_salary" is required and must be a non-negative number (yen).');

  const ageRaw = c.req.query('age');
  const age = ageRaw === undefined ? null : Number(ageRaw);
  if (ageRaw !== undefined && (!Number.isFinite(age!) || age! < 0 || age! > 120))
    return bad(c, 'Query parameter "age" must be a number between 0 and 120.');

  const btKey = (c.req.query('business_type') ?? 'general').toLowerCase();
  if (!(empins.business_types as any)[btKey])
    return bad(c, `Unknown business_type: "${btKey}"`,
      `One of: ${Object.keys(empins.business_types).join(', ')}`);

  // 源泉所得税まで通すかどうか。既定で通す — 課税対象額は「社会保険料等控除後の
  // 給与等の金額」であって総支給額ではなく、そこを呼び出し側に計算させるのが
  // この種の実装で最も多い誤りだから。
  const taxRaw = (c.req.query('income_tax') ?? 'true').toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(taxRaw))
    return bad(c, `"income_tax" must be a boolean; got "${taxRaw}".`);
  const withTax = ['true', '1', 'yes'].includes(taxRaw);

  const colRaw = (c.req.query('column') ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return bad(c, `Unknown column: "${colRaw}"`,
      'Use "kou" (甲欄, a 扶養控除等申告書 was filed) or "otsu" (乙欄, it was not).');

  const depRaw = c.req.query('dependants') ?? '0';
  const dependants = Number(depRaw);
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '"dependants" must be an integer between 0 and 50.');

  const residentRaw = c.req.query('resident_tax') ?? '0';
  const residentTax = Number(residentRaw);
  if (!Number.isFinite(residentTax) || residentTax < 0)
    return bad(c, '"resident_tax" must be a non-negative number.',
      'Resident tax is assessed by the municipality and notified to the employer; this API cannot compute it, but will subtract a figure you supply.');

  const birthRaw = c.req.query('birth_date');
  const birth = birthRaw === undefined ? null : parseDate(birthRaw);
  if (birthRaw !== undefined && !birth)
    return bad(c, '"birth_date" must be a valid ISO date (YYYY-MM-DD).',
      'With a birth date the 40, 65, 70 and 75 milestones are applied exactly.');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');

  const pref = insurance.prefectures[r.pref];
  const slip = computePayslip({
    prefecture: r.pref, monthly_salary: salary, age, birth_date: birth, as_of: asOf!,
    business_type: btKey,
    column: colRaw as Column, dependants, income_tax: withTax, resident_tax: residentTax,
  });

  return c.json({
    input: {
      prefecture: r.pref, prefecture_ja: pref.prefecture_ja,
      monthly_salary: salary, age, business_type: btKey,
      ...(birth ? { birth_date: birthRaw, as_of: (asOf ?? new Date()).toISOString().slice(0, 10) } : {}),
      ...(withTax ? { column: colRaw, dependants } : {}),
      ...(residentTax ? { resident_tax: residentTax } : {}),
    },
    ...(slip.age_status ? { age_status: slip.age_status } : {}),
    coverage: slip.coverage,
    standard_remuneration: slip.standard_remuneration,
    long_term_care_applicable: slip.long_term_care_applicable,
    deductions: slip.deductions,
    ...(slip.income_tax ? {
      income_tax: {
        taxable_amount: slip.income_tax.taxable_amount,
        column: slip.income_tax.column,
        dependants: slip.income_tax.dependants,
        tax: slip.income_tax.tax,
        basis: slip.income_tax.basis,
        ...(slip.income_tax.dependants_over_seven
          ? { dependants_over_seven: slip.income_tax.dependants_over_seven } : {}),
        note: 'Charged on pay after social insurance, not on gross pay.',
      },
    } : {}),
    totals: {
      ...slip.totals,
      // 旧フィールド名。既存の利用者を壊さないために残す。
      employee: slip.totals.social_insurance_employee,
      employer: slip.totals.social_insurance_employer,
      combined: slip.totals.social_insurance_combined,
      take_home_before_tax: slip.totals.after_social_insurance,
    },
    notes: {
      rounding: insurance.meta.rounding,
      basis: 'Statutory premiums use the standard monthly remuneration; employment insurance and income tax use actual pay.',
      income_tax: withTax
        ? 'Income tax is computed from pay after social insurance, which this endpoint derives for you. Pass income_tax=false to omit it.'
        : 'Income tax omitted. Pass income_tax=true to include it.',
      resident_tax: residentTax
        ? 'Resident tax is the figure you supplied; it is not computed here.'
        : 'Resident tax (住民税) is assessed by the municipality and is not computed here. Pass resident_tax= to subtract it.',
      batch: 'POST /v1/payroll/batch runs many employees at once.',
    },
    attribution: { ...ATTRIBUTION, ...(withTax ? { withholding_tax: WITHHOLDING_ATTRIBUTION } : {}) },
  });
});

// ---- Holidays and business days -------------------------------------------

const HOLIDAY_ATTRIBUTION = {
  source: HOLIDAY_META.source,
  source_url: HOLIDAY_META.source_url,
  coverage: COVERAGE,
  note: 'Substitute holidays (振替休日) and citizens\' holidays (国民の休日) are recorded by the Cabinet Office under the single name 休日; the "substitute" flag marks them.',
};

/** ?calendar=standard|bank — bank adds 12/31-1/3 per 銀行法施行令第5条. */
const readCalendar = (c: any): Calendar | null => {
  const raw = (c.req.query('calendar') ?? 'standard').toLowerCase();
  return raw === 'standard' || raw === 'bank' ? raw : null;
};
const badCalendar = (c: any) =>
  bad(c, `Unknown calendar: "${c.req.query('calendar')}"`, 'Use "standard" or "bank".');

const outOfCoverage = (c: any, iso: string) =>
  c.json({
    error: `Date ${iso} is outside the published range.`,
    code: 'out_of_coverage',
    coverage: COVERAGE,
    hint: 'The Cabinet Office publishes holidays for this range only. Future years are added each February.',
  }, 422);

app.get('/v1/holidays', (c) => {
  const raw = c.req.query('year');
  const from = c.req.query('from');
  const to = c.req.query('to');

  if (from || to) {
    if (!from || !to) return bad(c, 'Both "from" and "to" are required when querying a range.');
    if (!parseISO(from) || !parseISO(to)) return bad(c, '"from" and "to" must be ISO dates (YYYY-MM-DD).');
    if (from > to) return bad(c, '"from" must not be after "to".');
    if (!inCoverage(from)) return outOfCoverage(c, from);
    if (!inCoverage(to)) return outOfCoverage(c, to);
    const list = holidaysBetween(from, to);
    return c.json({ from, to, count: list.length, holidays: list, attribution: HOLIDAY_ATTRIBUTION });
  }

  const year = Number(raw);
  if (!raw || !Number.isInteger(year))
    return bad(c, 'Query parameter "year" is required.', 'Or use from= and to= for a date range.');
  if (year < HOLIDAY_META.year_from || year > HOLIDAY_META.year_to)
    return outOfCoverage(c, String(year));
  const list = holidaysInYear(year);
  return c.json({ year, count: list.length, holidays: list, attribution: HOLIDAY_ATTRIBUTION });
});

app.get('/v1/holidays/check', (c) => {
  const raw = c.req.query('date');
  const d = parseISO(raw);
  if (!d) return bad(c, 'Query parameter "date" is required and must be a valid ISO date (YYYY-MM-DD).');
  const iso = toISO(d);
  if (!inCoverage(iso)) return outOfCoverage(c, iso);
  const cal = readCalendar(c);
  if (!cal) return badCalendar(c);
  const h = getHoliday(iso);
  const reasons = closureReasons(d, cal);
  return c.json({
    date: iso,
    calendar: cal,
    weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()],
    is_holiday: h !== null,
    is_weekend: isWeekend(d),
    is_business_day: isBusinessDay(d),
    is_open: isOpenOn(d, cal),
    closed_because: reasons,
    holiday: h,
    attribution: cal === 'bank'
      ? { ...HOLIDAY_ATTRIBUTION, bank_calendar: BANK_CALENDAR }
      : HOLIDAY_ATTRIBUTION,
  });
});

app.get('/v1/business-days', (c) => {
  const from = c.req.query('from') ?? c.req.query('start');
  const to = c.req.query('to') ?? c.req.query('end');
  const a = parseISO(from);
  const b = parseISO(to);
  if (!a || !b) return bad(c, '"from" and "to" are required and must be ISO dates (YYYY-MM-DD).');
  if (from! > to!) return bad(c, '"from" must not be after "to".');
  if (!inCoverage(from!)) return outOfCoverage(c, from!);
  if (!inCoverage(to!)) return outOfCoverage(c, to!);
  const cal = readCalendar(c);
  if (!cal) return badCalendar(c);
  const counts = countBusinessDays(a, b, cal);
  return c.json({
    from: toISO(a), to: toISO(b), inclusive: true, calendar: cal,
    ...counts,
    attribution: cal === 'bank'
      ? { ...HOLIDAY_ATTRIBUTION, bank_calendar: BANK_CALENDAR }
      : HOLIDAY_ATTRIBUTION,
  });
});

app.get('/v1/business-days/shift', (c) => {
  const raw = c.req.query('date');
  const d = parseISO(raw);
  if (!d) return bad(c, 'Query parameter "date" is required and must be a valid ISO date (YYYY-MM-DD).');
  if (!inCoverage(toISO(d))) return outOfCoverage(c, toISO(d));
  const nRaw = c.req.query('days') ?? '1';
  const n = Number(nRaw);
  if (!Number.isInteger(n) || Math.abs(n) > 10_000)
    return bad(c, '"days" must be an integer between -10000 and 10000.',
      'Positive moves forward, negative moves backward. 1 = next business day.');
  const cal = readCalendar(c);
  if (!cal) return badCalendar(c);
  const result = shiftBusinessDays(d, n, cal);
  if (!result) return outOfCoverage(c, 'the resulting date');
  return c.json({
    from: toISO(d), days: n, calendar: cal, result: toISO(result),
    result_weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][result.getUTCDay()],
    attribution: cal === 'bank'
      ? { ...HOLIDAY_ATTRIBUTION, bank_calendar: BANK_CALENDAR }
      : HOLIDAY_ATTRIBUTION,
  });
});

// ---- Consumption tax --------------------------------------------------------

app.get('/v1/consumption-tax', (c) => {
  const dateRaw = c.req.query('date');
  if (dateRaw && !parseISO(dateRaw))
    return bad(c, '"date" must be a valid ISO date (YYYY-MM-DD).');
  const on = dateRaw ?? null;

  const period = on
    ? ctax.history.find((h) => on >= h.effective_from && (h.effective_to === null || on <= h.effective_to))
    : ctax.history[ctax.history.length - 1];

  if (!period)
    return c.json({
      error: `No consumption tax was in force on ${on}.`,
      code: 'out_of_coverage',
      hint: 'Japan introduced consumption tax on 1989-04-01.',
      introduced: ctax.history[0].effective_from,
    }, 422);

  const amountRaw = c.req.query('amount');
  const reduced = ['1', 'true', 'yes'].includes((c.req.query('reduced') ?? '').toLowerCase());
  const rate = reduced ? period.reduced : period.standard;

  if (reduced && !rate)
    return c.json({
      error: 'No reduced rate existed on that date.',
      code: 'out_of_coverage',
      reduced_rate_since: ctax.reduced_rate_scope.since,
    }, 422);

  const body: Record<string, unknown> = {
    ...(on ? { date: on } : { date: 'current' }),
    effective_from: period.effective_from,
    effective_to: period.effective_to,
    rate_type: reduced ? 'reduced' : 'standard',
    rate: rate!.total,
    breakdown: { national: rate!.national, local: rate!.local },
    standard: period.standard,
    reduced: period.reduced,
    reduced_rate_scope: ctax.reduced_rate_scope,
    attribution: { source: ctax.meta.source, source_url: ctax.meta.source_url },
  };

  if (amountRaw !== undefined) {
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount < 0)
      return bad(c, '"amount" must be a non-negative number (yen, tax-exclusive).');
    // Consumption tax is truncated to the yen on the invoice total.
    const tax = Math.floor(amount * rate!.total);
    body.calculation = {
      amount_excluding_tax: amount,
      tax,
      amount_including_tax: amount + tax,
      rounding: 'tax truncated to the yen (切り捨て)',
    };
  }

  return c.json(body);
});

app.get('/v1/consumption-tax/history', (c) =>
  c.json({
    count: ctax.history.length,
    history: ctax.history,
    reduced_rate_scope: ctax.reduced_rate_scope,
    attribution: { source: ctax.meta.source, source_url: ctax.meta.source_url },
  }));

// ---- Corporate number (法人番号) structural validation ----------------------

app.get('/v1/corporate-number/validate', (c) => {
  const raw = c.req.query('number');
  if (!raw) return bad(c, 'Query parameter "number" is required.', 'A 13-digit 法人番号, e.g. 8700110005901.');
  const r = validateCorporateNumber(raw);
  return c.json({ input: raw, ...r, attribution: CORPORATE_NUMBER_ATTRIBUTION });
});

app.get('/v1/corporate-number/check-digit', (c) => {
  const raw = c.req.query('base');
  if (!raw) return bad(c, 'Query parameter "base" is required.', 'A 12-digit 会社法人等番号, e.g. 700110005901.');
  const r = fromBaseNumber(raw);
  if (!r.ok) return bad(c, r.reason);
  return c.json({
    input: raw,
    base_number: r.base_number,
    check_digit: r.check_digit,
    corporate_number: r.corporate_number,
    attribution: CORPORATE_NUMBER_ATTRIBUTION,
  });
});

app.get('/v1/invoice-number/validate', (c) => {
  const raw = c.req.query('number');
  if (!raw)
    return bad(c, 'Query parameter "number" is required.',
      'A registration number such as T8700110005901.');
  return c.json({ ...validateInvoiceNumber(raw), attribution: INVOICE_NUMBER_ATTRIBUTION });
});

app.get('/v1/withholding-tax', (c) => {
  const amountRaw = c.req.query('taxable_amount') ?? c.req.query('amount');
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount < 0)
    return bad(c, 'Query parameter "taxable_amount" is required and must be a non-negative number.',
      'This is the monthly pay AFTER social insurance deductions (社会保険料等控除後の給与等の金額).');

  const colRaw = (c.req.query('column') ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return bad(c, `Unknown column: "${colRaw}"`,
      'Use "kou" (甲欄, a 扶養控除等申告書 was filed) or "otsu" (乙欄, it was not).');
  const column = colRaw as Column;

  const depRaw = c.req.query('dependants') ?? '0';
  const dependants = Number(depRaw);
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '"dependants" must be an integer between 0 and 50.',
      '扶養親族等の数. Ignored for the 乙 column.');

  const r = withholdingTax(amount, column, dependants);
  return c.json({
    ...r,
    notes: {
      input: 'taxable_amount is pay after social insurance, not gross pay.',
      table_range: { from: TABLE_MIN, to: TABLE_MAX },
      over_seven: `The table stops at ${MAX_DEPENDANTS_IN_TABLE} dependants; beyond that 1,610 yen is deducted per additional person.`,
      excludes: 'Resident tax and the year-end adjustment are out of scope.',
    },
    attribution: WITHHOLDING_ATTRIBUTION,
  });
});

app.get('/v1/withholding-tax/daily', (c) => {
  const raw = c.req.query('taxable_amount') ?? c.req.query('amount');
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount < 0)
    return bad(c, 'Query parameter "taxable_amount" is required and must be a non-negative number.',
      'The day’s pay AFTER social insurance deductions.');

  const colRaw = (c.req.query('column') ?? 'kou').toLowerCase();
  if (!['kou', 'otsu', 'hei'].includes(colRaw))
    return bad(c, `Unknown column: "${colRaw}"`,
      'Use "kou", "otsu", or "hei" (丙欄, for day labourers and short-term hires).');

  const dependants = Number(c.req.query('dependants') ?? '0');
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '"dependants" must be an integer between 0 and 50.');

  return c.json({
    ...dailyWithholdingTax(amount, colRaw as DailyColumn, dependants),
    notes: {
      input: 'taxable_amount is the day’s pay after social insurance.',
      table_range: { from: DAILY_MIN, to: DAILY_MAX },
      over_seven: `Beyond ${DAILY_MAX_DEPENDANTS} dependants the 甲 column deducts 50 yen per additional person.`,
      hei: 'The 丙 column is for day labourers and short-term hires, and has its own rates.',
    },
    attribution: DAILY_ATTRIBUTION,
  });
});

app.get('/v1/withholding-tax/computer', (c) => {
  const amountRaw = c.req.query('taxable_amount') ?? c.req.query('amount');
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount < 0)
    return bad(c, 'Query parameter "taxable_amount" is required and must be a non-negative number.',
      'Monthly pay AFTER social insurance deductions.');

  const spouseRaw = (c.req.query('spouse') ?? 'false').toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(spouseRaw))
    return bad(c, `"spouse" must be a boolean; got "${spouseRaw}".`);
  const hasSpouse = ['true', '1', 'yes'].includes(spouseRaw);

  const depRaw = c.req.query('dependants') ?? '0';
  const dependants = Number(depRaw);
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '"dependants" must be an integer between 0 and 50.',
      '源泉控除対象親族の数. Count each of the taxpayer’s own 障害者 / 寡婦 / ひとり親 / 勤労学生 statuses as one.');

  return c.json({
    ...computerMethod(amount, hasSpouse, dependants),
    method: 'computer',
    attribution: COMPUTER_ATTRIBUTION,
  });
});

app.post('/v1/payroll/batch', async (c) => {
  let payload: { employees?: unknown; defaults?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return bad(c, 'Request body must be JSON.',
      'POST {"defaults": {...}, "employees": [{...}]}');
  }

  const rows = payload?.employees;
  if (!Array.isArray(rows))
    return bad(c, '"employees" must be an array.', 'Each element is one employee for this run.');
  if (rows.length === 0)
    return bad(c, '"employees" must not be empty.');
  // The free tier can run a batch — just a small one. Gating the endpoint
  // entirely would hide the feature from the people most likely to want it;
  // capping it lets them see exactly what it returns before deciding to pay.
  const { paid } = entitlement(c);
  const cap = paid ? MAX_BATCH : FREE_TIER.batch_rows;
  if (rows.length > cap)
    return bad(c,
      paid
        ? `A batch is limited to ${MAX_BATCH} employees; got ${rows.length}.`
        : `The free tier allows ${FREE_TIER.batch_rows} employees per batch; got ${rows.length}.`,
      paid
        ? 'Split the run into several requests.'
        : `Batches of up to ${MAX_BATCH} are available through ${UPGRADE.where}. ` +
          'Everything else on the free tier is unmetered per call — this cap applies only to batch size.',
      'batch_too_large');
  if (rows.some((r) => typeof r !== 'object' || r === null || Array.isArray(r)))
    return bad(c, 'Every element of "employees" must be an object.');

  const defaults = (payload?.defaults ?? {}) as BatchDefaults;
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults))
    return bad(c, '"defaults" must be an object.');

  const detailRaw = (c.req.query('detail') ?? 'full').toLowerCase();
  if (detailRaw !== 'full' && detailRaw !== 'compact')
    return bad(c, `Unknown detail: "${detailRaw}"`,
      'Use "full" for every premium split, or "compact" for the payout figures only.');

  const { results, errors, summary } = runBatch(rows as BatchRow[], defaults, detailRaw as Detail);
  return c.json({
    count: rows.length,
    detail: detailRaw,
    succeeded: results.length,
    failed: errors.length,
    defaults,
    summary,
    results,
    errors,
    notes: {
      partial: 'A row that fails is reported in "errors" and skipped; the rest still run.',
      order: 'Each result carries the index of its input row.',
      detail: 'Add ?detail=compact for payout figures only — roughly a tenth the size on a large run.',
      employer_cost: 'summary.employer_cost is gross pay plus the employer social insurance share.',
      resident_tax: 'Resident tax is only ever the figure you supply; it is not computed.',
    },
    attribution: { ...ATTRIBUTION, withholding_tax: WITHHOLDING_ATTRIBUTION },
  });
});

app.get('/v1/leave-exemption', (c) => {
  const kindRaw = (c.req.query('kind') ?? 'childcare').toLowerCase();
  if (kindRaw !== 'maternity' && kindRaw !== 'childcare')
    return bad(c, `Unknown kind: "${kindRaw}"`,
      'Use "maternity" (産前産後休業) or "childcare" (育児休業等).');

  const start = parseDate(c.req.query('start'));
  if (!start)
    return bad(c, '"start" is required and must be an ISO date (YYYY-MM-DD).');
  const end = parseDate(c.req.query('end'));
  if (!end)
    return bad(c, '"end" is required and must be an ISO date (YYYY-MM-DD).');
  if (end.getTime() < start.getTime())
    return bad(c, '"end" must not be before "start".');

  const workedRaw = c.req.query('worked_days') ?? '0';
  const workedDays = Number(workedRaw);
  if (!Number.isInteger(workedDays) || workedDays < 0 || workedDays > 31)
    return bad(c, '"worked_days" must be an integer between 0 and 31.',
      'Days worked during 出生時育児休業 only. Hours convert as floor(hours / daily contracted hours).');
  if (workedDays > 0 && kindRaw === 'maternity')
    return bad(c, 'worked_days applies only to 出生時育児休業, not to 産前産後休業.');

  return c.json({
    ...leaveExemption({ kind: kindRaw as LeaveKind, start, end, workedDays }),
    notes: {
      priority: '産前産後休業 takes precedence: 健保法159条1項 excludes anyone already covered by 159条の3.',
      consecutive: 'Two childcare leaves with no working day between them count as one (健保法159条2項).',
      shares: 'Both the employee and employer shares are exempt.',
    },
    attribution: LEAVE_ATTRIBUTION,
  });
});

const WORKER_TYPES = ['general', 'part_time_short_hours', 'short_time_insured'] as const;

/** `350000:31,352000:30,349000:31` — amount:payment_basis_days, three months. */
function parseMonths(raw: string | undefined): PayMonth[] | string {
  if (!raw) return '"months" is required.';
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 3) return `"months" needs exactly 3 entries, got ${parts.length}.`;
  const out: PayMonth[] = [];
  for (const [i, p] of parts.entries()) {
    const [a, d] = p.split(':');
    const remuneration = Number(a);
    const days = Number(d);
    if (!Number.isFinite(remuneration) || remuneration < 0)
      return `Month ${i + 1}: "${a}" is not a valid remuneration.`;
    if (!Number.isInteger(days) || days < 0 || days > 31)
      return `Month ${i + 1}: payment basis days must be an integer from 0 to 31, got "${d}".`;
    out.push({ remuneration, payment_basis_days: days });
  }
  return out;
}

/**
 * Returns null when the value is not a worker type. It cannot signal the failure
 * by returning a message the way parseMonths does, because WorkerType *is* a
 * string — `typeof result === 'string'` would then be true for every valid input.
 */
function parseWorkerType(raw: unknown): WorkerType | null {
  const t = String(raw ?? 'general').toLowerCase();
  return (WORKER_TYPES as readonly string[]).includes(t) ? (t as WorkerType) : null;
}

const badWorkerType = (c: any, raw: unknown) =>
  bad(c, `Unknown worker_type: "${String(raw)}"`,
    `Use one of ${WORKER_TYPES.join(', ')}. The day threshold is 17 except for ` +
    '短時間労働者 at a 特定適用事業所, where it is 11.');

app.get('/v1/standard-remuneration/revision', (c) => {
  const current = Number(c.req.query('current_remuneration'));
  if (!Number.isFinite(current) || current < 0)
    return bad(c, '"current_remuneration" is required and must be a non-negative number.',
      'Pass the 報酬月額 the current grade was based on, not the 標準報酬月額 — the upper and lower exceptions turn on the actual pay.');

  const months = parseMonths(c.req.query('months'));
  if (typeof months === 'string')
    return bad(c, months, 'Format: months=350000:31,352000:30,349000:31 (報酬月額:支払基礎日数).');

  const workerType = parseWorkerType(c.req.query('worker_type'));
  if (workerType === null) return badWorkerType(c, c.req.query('worker_type'));

  const changeRaw = (c.req.query('fixed_pay_change') ?? '').toLowerCase();
  if (!['increase', 'decrease', 'none'].includes(changeRaw))
    return bad(c, '"fixed_pay_change" is required.',
      'Use "increase", "decrease" or "none". Only fixed pay counts — overtime alone never triggers a revision. See guidance.fixed_pay in the response.');

  return c.json({
    ...judgeRevision({
      current_remuneration: current,
      months: months as [PayMonth, PayMonth, PayMonth],
      fixed_pay_change: changeRaw as 'increase' | 'decrease' | 'none',
      worker_type: workerType,
    }),
    guidance: { fixed_pay: FIXED_PAY_GUIDANCE, payment_basis_days: PAYMENT_BASIS_DAYS_GUIDANCE },
    attribution: REVISION_ATTRIBUTION,
  });
});

app.get('/v1/standard-remuneration/regular', (c) => {
  const months = parseMonths(c.req.query('months'));
  if (typeof months === 'string')
    return bad(c, months, 'Format: months=350000:30,352000:31,349000:30 for April, May and June.');

  const workerType = parseWorkerType(c.req.query('worker_type'));
  if (workerType === null) return badWorkerType(c, c.req.query('worker_type'));

  const prevRaw = c.req.query('previous_remuneration');
  const previous = prevRaw === undefined ? undefined : Number(prevRaw);
  if (previous !== undefined && (!Number.isFinite(previous) || previous < 0))
    return bad(c, '"previous_remuneration" must be a non-negative number.',
      'Needed only so the response can name the grade that carries over when no month qualifies.');

  const acquiredRaw = c.req.query('acquired_month');
  const acquired = acquiredRaw === undefined ? undefined : Number(acquiredRaw);
  if (acquired !== undefined && (!Number.isInteger(acquired) || acquired < 1 || acquired > 12))
    return bad(c, '"acquired_month" must be a month number from 1 to 12.');

  return c.json({
    ...judgeRegularDecision({
      months: months as [PayMonth, PayMonth, PayMonth],
      worker_type: workerType,
      previous_remuneration: previous,
    }),
    not_required_for: REGULAR_DECISION_EXCLUSIONS,
    ...(acquired !== undefined
      ? { acquisition_decision: acquisitionDecisionPeriod(acquired) }
      : {}),
    guidance: { payment_basis_days: PAYMENT_BASIS_DAYS_GUIDANCE },
    attribution: REVISION_ATTRIBUTION,
  });
});

app.get('/v1/standard-remuneration/leave-end', (c) => {
  const kindRaw = (c.req.query('kind') ?? 'childcare').toLowerCase();
  if (kindRaw !== 'maternity' && kindRaw !== 'childcare')
    return bad(c, `Unknown kind: "${kindRaw}"`,
      'Use "maternity" (産前産後休業終了時改定) or "childcare" (育児休業等終了時改定).');

  const current = Number(c.req.query('current_remuneration'));
  if (!Number.isFinite(current) || current < 0)
    return bad(c, '"current_remuneration" is required and must be a non-negative number.');

  const months = parseMonths(c.req.query('months'));
  if (typeof months === 'string')
    return bad(c, months,
      'Three months from the one containing the day after the leave ended. Format: months=260000:31,258000:30,262000:31.');

  const workerType = parseWorkerType(c.req.query('worker_type'));
  if (workerType === null) return badWorkerType(c, c.req.query('worker_type'));

  return c.json({
    ...judgeLeaveEndRevision({
      kind: kindRaw as 'maternity' | 'childcare',
      current_remuneration: current,
      months: months as [PayMonth, PayMonth, PayMonth],
      worker_type: workerType,
      next_leave_starts_immediately: c.req.query('next_leave_starts_immediately') === 'true',
    }),
    guidance: { payment_basis_days: PAYMENT_BASIS_DAYS_GUIDANCE },
    attribution: REVISION_ATTRIBUTION,
  });
});

app.post('/v1/standard-remuneration/annual-average', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return bad(c, 'Body must be valid JSON.', 'Send Content-Type: application/json.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return bad(c, 'Body must be a JSON object.');

  const type = String(body.type ?? '').toLowerCase();
  if (type !== 'regular' && type !== 'revision')
    return bad(c, '"type" is required.',
      '"regular" for 定時決定の年間平均 (前年7月〜当年6月), "revision" for 随時改定の年間平均 (変動月前9か月＋以後3か月).');

  if (!Array.isArray(body.months) || body.months.length !== 12)
    return bad(c, '"months" must be an array of exactly 12 entries.',
      type === 'regular'
        ? 'In order from 前年7月 to 当年6月, each {"remuneration": n, "payment_basis_days": n}.'
        : 'The 9 months before the pay change, then the 3 months after, each {"fixed": n, "non_fixed": n, "payment_basis_days": n}.');

  const months: AnnualMonth[] = [];
  for (const [i, m] of body.months.entries()) {
    if (!m || typeof m !== 'object')
      return bad(c, `months[${i}] must be an object.`);
    const days = Number(m.payment_basis_days);
    if (!Number.isInteger(days) || days < 0 || days > 31)
      return bad(c, `months[${i}].payment_basis_days must be an integer from 0 to 31.`);
    if (type === 'regular') {
      const r = Number(m.remuneration);
      if (!Number.isFinite(r) || r < 0)
        return bad(c, `months[${i}].remuneration must be a non-negative number.`);
      months.push({ month: m.month, remuneration: r, payment_basis_days: days });
    } else {
      const fixed = Number(m.fixed);
      const nonFixed = Number(m.non_fixed);
      if (!Number.isFinite(fixed) || fixed < 0)
        return bad(c, `months[${i}].fixed must be a non-negative number.`,
          'Fixed pay is base salary and fixed allowances; the annual figure averages it over the 3 months after the change only.');
      if (!Number.isFinite(nonFixed) || nonFixed < 0)
        return bad(c, `months[${i}].non_fixed must be a non-negative number.`,
          'Non-fixed pay is overtime and the like; it is averaged over all 12 months.');
      months.push({ month: m.month, fixed, non_fixed: nonFixed, payment_basis_days: days });
    }
  }

  const workerType = parseWorkerType(body.worker_type);
  if (workerType === null) return badWorkerType(c, body.worker_type);

  const recurring = body.recurring_annually === true;
  const consent = body.employee_consent === true;

  if (type === 'regular')
    return c.json({
      type,
      ...annualAverageRegular({
        months, worker_type: workerType,
        recurring_annually: recurring, employee_consent: consent,
      }),
      attribution: REVISION_ATTRIBUTION,
    });

  const current = Number(body.current_remuneration);
  if (!Number.isFinite(current) || current < 0)
    return bad(c, '"current_remuneration" is required for type "revision".');
  const change = String(body.fixed_pay_change ?? '').toLowerCase();
  if (change !== 'increase' && change !== 'decrease')
    return bad(c, '"fixed_pay_change" must be "increase" or "decrease" for type "revision".',
      'The annual-average route exists only where fixed pay actually changed; "none" can never qualify.');

  return c.json({
    type,
    ...annualAverageRevision({
      months, current_remuneration: current,
      fixed_pay_change: change as 'increase' | 'decrease',
      worker_type: workerType,
      recurring_annually: recurring, employee_consent: consent,
    }),
    attribution: REVISION_ATTRIBUTION,
  });
});

app.get('/v1/eligibility', (c) => {
  const monthRaw = c.req.query('month');
  const month = monthRaw
    ? parseDate(/^\d{4}-\d{2}$/.test(monthRaw) ? `${monthRaw}-01` : monthRaw)
    : new Date();
  if (!month)
    return bad(c, '"month" must be YYYY-MM or a full ISO date.');

  const joinedRaw = c.req.query('joined_on');
  const joined = joinedRaw === undefined ? null : parseDate(joinedRaw);
  if (joinedRaw !== undefined && !joined)
    return bad(c, '"joined_on" must be a valid ISO date (YYYY-MM-DD).');

  const leftRaw = c.req.query('left_on');
  const left = leftRaw === undefined ? null : parseDate(leftRaw);
  if (leftRaw !== undefined && !left)
    return bad(c, '"left_on" must be a valid ISO date (YYYY-MM-DD).',
      'This is the last day worked, not the day eligibility ends.');

  if (joined && left && left.getTime() < joined.getTime())
    return bad(c, '"left_on" must not be before "joined_on".');

  return c.json({
    ...eligibilityFor({ month, joined, left }),
    attribution: ELIGIBILITY_ATTRIBUTION,
  });
});

app.get('/v1/bonus-insurance', (c) => {
  const r = needPref(c); if ('err' in r) return r.err;

  const bonusRaw = c.req.query('bonus');
  const bonus = Number(bonusRaw);
  if (!bonusRaw || !Number.isFinite(bonus) || bonus < 0)
    return bad(c, 'Query parameter "bonus" is required and must be a non-negative number (yen).');

  const ytdRaw = c.req.query('fiscal_year_to_date') ?? '0';
  const ytd = Number(ytdRaw);
  if (!Number.isFinite(ytd) || ytd < 0)
    return bad(c, '"fiscal_year_to_date" must be a non-negative number.',
      'The 標準賞与額 already counted since 1 April; needed to apply the annual health cap.');

  const ageRaw = c.req.query('age');
  const age = ageRaw === undefined ? null : Number(ageRaw);
  if (ageRaw !== undefined && (!Number.isFinite(age!) || age! < 0 || age! > 120))
    return bad(c, '"age" must be a number between 0 and 120.');

  const birthRaw = c.req.query('birth_date');
  const birth = birthRaw === undefined ? null : parseDate(birthRaw);
  if (birthRaw !== undefined && !birth)
    return bad(c, '"birth_date" must be a valid ISO date (YYYY-MM-DD).');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');

  const pref = insurance.prefectures[r.pref];
  return c.json({
    prefecture: r.pref, prefecture_ja: pref.prefecture_ja,
    ...bonusInsurance({
      prefecture: r.pref, bonus, fiscal_year_to_date: ytd,
      age, birth_date: birth, as_of: asOf!,
    }),
    notes: {
      base: '標準賞与額 is the bonus truncated to the thousand yen.',
      annual_cap: 'The health-side cap is cumulative across the fiscal year, so pass fiscal_year_to_date or it cannot be applied.',
      withholding: 'Income tax on a bonus is a separate calculation — see /v1/bonus-tax.',
    },
    attribution: BONUS_INSURANCE_ATTRIBUTION,
  });
});

app.get('/v1/age-milestones', (c) => {
  const birth = parseDate(c.req.query('birth_date'));
  if (!birth)
    return bad(c, 'Query parameter "birth_date" is required and must be an ISO date (YYYY-MM-DD).');
  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');

  return c.json({
    ...ageStatus(birth, asOf!),
    rules: AGE_RULES,
    attribution: {
      source: 'e-Gov 法令検索',
      statutes: [
        { name: '年齢計算ニ関スル法律', url: 'https://laws.e-gov.go.jp/law/135AC1000000050' },
        { name: '介護保険法第9条', url: 'https://laws.e-gov.go.jp/law/409AC0000000123' },
        { name: '厚生年金保険法第9条・第14条', url: 'https://laws.e-gov.go.jp/law/329AC0000000115' },
        { name: '高齢者の医療の確保に関する法律第50条', url: 'https://laws.e-gov.go.jp/law/357AC0000000080' },
      ],
      licence: '公共データ利用規約(第1.0版)',
    },
  });
});

app.get('/v1/bonus-tax', (c) => {
  const n = (k: string) => {
    const raw = c.req.query(k);
    if (raw === undefined) return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  };

  const bonus = n('bonus');
  if (bonus === undefined || Number.isNaN(bonus) || bonus < 0)
    return bad(c, 'Query parameter "bonus" is required and must be a non-negative number (yen).');

  const prev = n('previous_month_pay');
  if (prev === undefined || Number.isNaN(prev) || prev < 0)
    return bad(c, 'Query parameter "previous_month_pay" is required and must be a non-negative number.',
      'The rate is looked up from LAST month’s pay, not from the bonus.');

  const prevIns = n('previous_month_insurance') ?? 0;
  if (Number.isNaN(prevIns) || prevIns < 0)
    return bad(c, '"previous_month_insurance" must be a non-negative number.');
  const bonusIns = n('bonus_insurance') ?? 0;
  if (Number.isNaN(bonusIns) || bonusIns < 0)
    return bad(c, '"bonus_insurance" must be a non-negative number.');

  const colRaw = (c.req.query('column') ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return bad(c, `Unknown column: "${colRaw}"`, 'Use "kou" or "otsu".');

  const dependants = Number(c.req.query('dependants') ?? '0');
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '"dependants" must be an integer between 0 and 50.');

  const r = bonusWithholding({
    previousMonthPay: prev, previousMonthInsurance: prevIns,
    bonus, bonusInsurance: bonusIns,
    column: colRaw as Column, dependants,
  });

  return c.json({
    input: {
      bonus, bonus_insurance: bonusIns,
      previous_month_pay: prev, previous_month_insurance: prevIns,
      column: colRaw, dependants,
    },
    ...r,
    exceptions: BONUS_EXCEPTIONS,
    notes: {
      procedure: 'Rate from last month’s pay after social insurance; applied to this bonus after its own social insurance.',
      rounding: 'Tax is truncated to the yen.',
      not_the_monthly_table: 'Bonuses do not use 月額表. Using it here would be wrong.',
    },
    attribution: BONUS_ATTRIBUTION,
  });
});

app.get('/v1/enums', (c) =>
  c.json({
    note: 'Every closed set of values this API accepts, so they can be read at build time rather than discovered from a 400.',
    business_type: Object.entries(empins.business_types).map(([k, v]: [string, any]) => ({
      value: k, label_ja: v.label_ja,
    })),
    column: [
      { value: 'kou', label_ja: '甲欄', description: 'A 扶養控除等申告書 was filed.' },
      { value: 'otsu', label_ja: '乙欄', description: 'No 扶養控除等申告書 was filed.' },
    ],
    // The daily table has a third column the monthly table does not.
    daily_column: [
      { value: 'kou', label_ja: '甲欄', description: 'A 扶養控除等申告書 was filed.' },
      { value: 'otsu', label_ja: '乙欄', description: 'No 扶養控除等申告書 was filed.' },
      { value: 'hei', label_ja: '丙欄', description: 'Engaged by the day. No dependant adjustment applies.' },
    ],
    worker_type: [
      { value: 'general', label_ja: '一般の被保険者', payment_basis_days: 17 },
      {
        value: 'part_time_short_hours', label_ja: '短時間就労者 (パート等)', payment_basis_days: 17,
        description: 'Works shorter hours than a regular employee but meets the three-quarters test. ' +
          'In 定時決定 only, months of 15-16 days can be used when no month reaches 17.',
      },
      {
        value: 'short_time_insured', label_ja: '特定適用事業所の短時間労働者', payment_basis_days: 11,
        description: '健康保険法施行規則第24条の2. The 11-day threshold reaches 定時決定, 随時改定 and both leave-end revisions.',
      },
    ],
    fixed_pay_change: [
      { value: 'increase', label_ja: '昇給', description: 'Fixed pay rose.' },
      { value: 'decrease', label_ja: '降給', description: 'Fixed pay fell.' },
      { value: 'none', label_ja: '変動なし', description: 'Only non-fixed pay moved. Never triggers a 随時改定.' },
    ],
    leave_kind: [
      { value: 'maternity', label_ja: '産前産後休業' },
      { value: 'childcare', label_ja: '育児休業等' },
    ],
    annual_average_type: [
      { value: 'regular', label_ja: '定時決定の年間平均', description: 'Compares April-June with the twelve months to June.' },
      { value: 'revision', label_ja: '随時改定の年間平均', description: 'Three-month fixed pay plus twelve-month non-fixed pay.' },
    ],
    detail: [
      { value: 'full', description: 'Every line of every payslip.' },
      { value: 'compact', description: 'Payout figures only, roughly a tenth the size.' },
    ],
    include: [
      {
        value: 'statute_text',
        description:
          'Attach the full text of every provision the response cites, under `statute_text`. ' +
          'Works on any endpoint. Off by default because most callers want the answer, not the Act.',
      },
    ],
    calendar: [
      { value: 'standard', description: 'Weekends and public holidays.' },
      { value: 'bank', description: 'Also closed 12/31-1/3, per 銀行法施行令第5条.' },
    ],
    error_codes: [
      { value: 'invalid_request', description: 'A parameter was missing, malformed or out of range.' },
      { value: 'missing_parameter', description: 'A required parameter was absent.' },
      { value: 'unknown_prefecture', description: 'The prefecture could not be resolved.' },
      { value: 'out_of_coverage', description: 'Valid input, but outside the range this API publishes.' },
      { value: 'not_found', description: 'No such endpoint.' },
      { value: 'internal_error', description: 'Unexpected failure.' },
    ],
    prefectures: 'See GET /v1/prefectures for all 47.',
  }));

app.get('/v1/data-freshness', (c) =>
  c.json(freshnessReport(new Date())));

app.notFound((c) => c.json({ error: 'Not found', code: 'not_found', hint: 'See GET / for the endpoint list.' }, 404));
app.onError((e, c) => c.json({ error: 'Internal error', code: 'internal_error', detail: String(e?.message ?? e) }, 500));

export default app;
