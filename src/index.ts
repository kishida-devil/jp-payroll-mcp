import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  insurance, minwage, empins,
  resolvePrefecture, roundEmployeeShare, findGrade,
  pensionStandardRemuneration, isLtcInsured, minimumWageAt,
  PREFECTURE_FULL_JA, suggestPrefecture,
  latestMinimumWageEffectiveFrom,
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
import { DATASETS, freshnessOf, freshnessReport } from './freshness';
import {
  MAX_DEPENDANTS_IN_TABLE, TABLE_MAX, TABLE_MIN, WITHHOLDING_ATTRIBUTION,
  withholdingTax, type Column,
} from './withholding';
import { COMPUTER_ATTRIBUTION, computerMethod } from './withholding-computer';
import { MAX_BATCH, runBatch, type BatchDefaults, type BatchRow, type Detail } from './batch';
import { computePayslip } from './payslip';
import { COMMUTING_SOURCE, ALLOWANCE_KIND_MEANING, VEHICLE_BANDS, TRANSIT_CEILING, PARKING_CAP, commutingExemption } from './allowances';
import {
  WORKERS_COMP_ATTRIBUTION, WORKERS_COMP_META, WORKERS_COMP_TYPES, workersCompType,
} from './workers-comp';
import { BONUS_ATTRIBUTION, BONUS_EXCEPTIONS, bonusWithholding } from './bonus';
import { BONUS_INSURANCE_ATTRIBUTION, bonusInsurance } from './bonus-insurance';
import { OVERTIME_ATTRIBUTION, overtimePay } from './overtime';
import { AGE_RULES, ageStatus, parseDate } from './age';
import { ELIGIBILITY_ATTRIBUTION, eligibilityFor } from './eligibility';
import {
  NATIONAL_HEALTH, NATIONAL_INSURANCE_ATTRIBUTION, NATIONAL_PENSION,
} from './national-insurance';
import {
  HEALTH_ANNUAL_CAP, PENSION_PER_PAYMENT_CAP,
} from './bonus-insurance';
import {
  ANNUAL_LEAVE_ATTRIBUTION, ATTENDANCE_THRESHOLD, FULL_GRANT, PROPORTIONAL_TABLE,
  judgeAnnualLeave,
} from './annual-leave';
import {
  EXCLUDED_FROM_WAGE_TEST, HEADCOUNT_SCHEDULE, WORKER_TYPE_ATTRIBUTION, judgeWorkerType,
} from './worker-type';
import { LEAVE_ATTRIBUTION, leaveExemption, type LeaveKind } from './leave-exemption';
import {
  FIXED_PAY_GUIDANCE, PAYMENT_BASIS_DAYS_GUIDANCE, REGULAR_DECISION_EXCLUSIONS,
  REVISION_ATTRIBUTION, acquisitionDecisionPeriod, annualAverageRegular,
  annualAverageRevision, judgeLeaveEndRevision, judgeRegularDecision, judgeRevision,
  judgeSubmission,
  realGrade,
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
 * 未知のクエリパラメータを拒否する。
 *
 * 金額を扱うAPIで綴り間違いを黙って無視するのは事故製造機になる。独立した批評で
 * 指摘された不具合のうち、`standard_remuneration` `commuting_allowance`
 * `employment_type` `as_of`(料率) が効かない件は、どれも「渡したのに無視された」
 * であって、400を返していれば全部その場で分かった。
 *
 * 拒否ではなく警告に留めない理由は、警告はレスポンスの奥に埋もれて読まれないため。
 * 給与計算で「気づかないまま間違った額が出る」ことのほうが、400で止まることより
 * はるかに高くつく。
 */
function rejectUnknownQuery(c: any, allowed: readonly string[]) {
  const seen = Object.keys(c.req.query());
  const unknown = seen.filter((k) => !allowed.includes(k));
  if (!unknown.length) return null;
  const near = (k: string) =>
    allowed.find((a) => a.startsWith(k.slice(0, 4)) || k.startsWith(a.slice(0, 4)));
  return bad(c,
    `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `"${u}"`).join(', ')}`,
    unknown.map((u) => {
      const s = near(u);
      return s ? `Did you mean "${s}"?` : null;
    }).filter(Boolean).join(' ') ||
      `Accepted here: ${allowed.join(', ')}. Parameters are rejected rather than ignored, ` +
      'because a silently dropped one produces a plausible wrong figure.',
    'unknown_parameter');
}

/**
 * 料率が有効な期間。
 *
 * 料率は毎年変わる。協会けんぽの保険料額表は3月分から、雇用保険料率と労災保険率は
 * 年度で切り替わる。ここに載っているのは1組だけなので、範囲外の日付を渡されたら
 * **現行の率を黙って返してはいけない。**過去の給与を計算し直す人にとって、
 * 黙って今年の率が返るのは、間違いに気づく手がかりが1つも無いということ。
 *
 * 範囲外は422で返し、何年何月分が載っているかを添える。
 */
const RATE_WINDOWS = {
  social_insurance: {
    from: '2026-03-01', through: '2027-02-28',
    label: '協会けんぽ 令和8年3月分からの保険料額表',
    note: '協会けんぽの料率は毎年3月分(4月納付分)から切り替わる。',
  },
  employment_insurance: {
    from: '2026-04-01', through: '2027-03-31',
    label: '令和8年度の雇用保険料率',
    note: '雇用保険料率は年度で切り替わる。',
  },
  workers_compensation: {
    from: '2024-04-01', through: '2027-03-31',
    label: '労災保険率表(令和6年度~、令和8年度も同率)',
    note: '労災保険率は概ね3年ごとに改定される。',
  },
} as const;

type RateSet = keyof typeof RATE_WINDOWS;

/** null when the date is inside the window, or a 422 response when it is not. */
function outsideRateWindow(c: any, set: RateSet, iso: string | null) {
  if (!iso) return null;
  const w = RATE_WINDOWS[set];
  if (iso >= w.from && iso <= w.through) return null;
  return c.json({
    error: `No ${set.replace(/_/g, ' ')} rates are published for ${iso}.`,
    code: 'out_of_coverage',
    coverage: { from: w.from, through: w.through, table: w.label },
    hint: iso < w.from
      ? `This API carries one rate table at a time — ${w.label}. ${w.note} ` +
        'Returning the current rates for an earlier date would produce a plausible wrong figure, so it refuses instead.'
      : `${w.note} The rates for ${iso} are not published yet; they appear here once the source publishes them.`,
  }, 422);
}

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
    // 接尾辞だけが違うなら、正しい形を示す。「大阪県」と書いた人が知りたいのは
    // 「そんな県は無い」ではなく「大阪府と書けばよい」のほう。
    const meant = suggestPrefecture(raw ?? null);
    return {
      err: bad(c, raw ? `Unknown prefecture: "${raw}"` : 'Missing required query parameter: prefecture',
        meant
          ? `Did you mean "${meant}"? 都道府県の接尾辞は1つしか正しくありません — 都は東京、道は北海道、府は京都と大阪、残る43が県です。`
          : 'Accepts English name ("Tokyo"), Japanese ("東京" / "東京都"), or JIS code 1-47. See /v1/prefectures.',
        raw ? 'unknown_prefecture' : 'missing_parameter'),
    };
  }
  return { pref };
};

app.get('/', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return c.json({
    name: 'Japan Payroll and Labor Constants API',
    description:
      'Japanese statutory reference data in one API — social and employment insurance rates for all 47 prefectures, the 50-grade standard remuneration table, 24 years of minimum wage history, public holidays with business-day arithmetic, consumption tax since 1989, and corporate/invoice number validation. Extracted programmatically from government open data and verified against the published figures.',
    version: '2.10.0',
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
      'POST /v1/invoice-number/validate/batch': '登録番号をまとめて形式検査 — 分かるのは形式だけで、登録・取消・失効は国税庁の公表サイトでしか分からない',
      'GET /v1/withholding-tax?taxable_amount=300000&dependants=2': 'Monthly withholding income tax (源泉徴収税額表 月額表)',
      'GET /v1/withholding-tax/daily?taxable_amount=12000&column=hei': 'Daily withholding table (日額表), including the 丙 column',
      'GET /v1/withholding-tax/computer?taxable_amount=300000&dependants=2': 'Same tax by the statutory formula method (電算機計算の特例)',
      'POST /v1/payroll/batch': `Up to ${MAX_BATCH} payslips in one call, with run totals (free tier: ${FREE_TIER.batch_rows} per batch)`,
      'GET /v1/leave-exemption?kind=childcare&start=2026-03-15&end=2026-03-28': 'Which months of social insurance a maternity or childcare leave exempts',
      'GET /v1/national-insurance?months=12': '国民年金は全国一律なので額を返す。国民健康保険は市町村の条例なので全国一律の額が存在せず、返さない理由を返す',
      'GET /v1/annual-cost?prefecture=Tokyo&monthly_salary=400000&age=40&bonuses=800000,800000': '年間の労務コスト — 健保の賞与上限は年度累計573万、厚年は1回150万なので、月次×12では出ない',
      'GET /v1/annual-leave?hired_on=2020-04-01&attendance_rate=0.9': '年次有給休暇の付与日数と年5日の時季指定義務 — 勤続で10→20日、週30時間未満は比例付与 (労基法39条)',
      'GET /v1/worker-type?weekly_hours=25&monthly_wage=100000&workplace_insured_count=51&employment_months=12': '被保険者区分の判定 — 四分の三基準と20時間/88,000円/学生/51人。誤ると定時決定の支払基礎日数が17日と11日で入れ替わる',
      'GET /v1/eligibility?month=2026-03&left_on=2026-03-30': 'Whether social insurance is due in a joining or leaving month',
      'GET /v1/age-milestones?birth_date=1986-04-01': 'When 40, 65, 70 and 75 are reached and what each changes',
      'GET /v1/bonus-insurance?prefecture=Tokyo&bonus=800000&age=40': 'Social insurance on a bonus, with the annual and per-payment caps',
      'GET /v1/bonus-tax?bonus=500000&previous_month_pay=350000&previous_month_insurance=55750&dependants=2': 'Withholding tax on a bonus (賞与の算出率表)',
      'GET /v1/overtime-pay?base_monthly_pay=300000&monthly_scheduled_hours=160&overtime_hours=20&night_hours=5': '割増賃金 — overtime 25%, over 60h 50%, statutory holiday 35%, night 25% on top (労基法37条)',
      'GET /v1/workers-compensation?business_type=98&wage_total=3600000': '労災保険料 — the whole premium falls on the employer, at a rate that runs from 2.5 to 88 per 1,000 by trade',
      'GET /v1/commuting-allowance?amount=12000&distance_km=12&parking=3000': '通勤手当の非課税限度額 — social insurance counts it in full, income tax only above the ceiling. The table changed twice in twelve months, once retroactively',
      'GET /v1/standard-remuneration/revision?current_remuneration=300000&months=350000:31,352000:30,349000:31&fixed_pay_change=increase': 'Is a 随時改定 (月額変更) due? Judges health and pension separately',
      'GET /v1/standard-remuneration/regular?months=350000:30,352000:31,349000:30': 'Annual 定時決定 (算定基礎) from April-June pay',
      'GET /v1/standard-remuneration/leave-end?kind=childcare&current_remuneration=300000&months=260000:31,258000:30,262000:31': 'Revision on returning from maternity or childcare leave (one grade is enough)',
      'POST /v1/standard-remuneration/regular/batch': '算定基礎届 for a whole payroll in one call — June is the one month everybody is decided at once (健保法41条)',
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
  });
});

/**
 * 引用した条文の本文。判定エンドポイントは根拠を示すが本文は返さないので、
 * 条文番号を受け取った利用者が e-Gov を開き直す手間がここで消える。
 */
app.get('/v1/statute', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include', 'ref'] as const);
  if (unknownQ) return unknownQ;

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

app.get('/v1/statute/index', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
  c.json({
    count: STATUTE_INDEX.length,
    laws: STATUTE_LAWS,
    provisions: STATUTE_INDEX,
    note:
      'Every provision this API cites, with its text. Add ?include=statute_text to a judgement ' +
      'endpoint to have the text of whatever it cited attached to the answer.',
    attribution: STATUTE_ATTRIBUTION,
  }));
});
app.get('/openapi.json', (c) => {
  c.header('Content-Type', 'application/json; charset=utf-8');
  return c.body(JSON.stringify(openapiSpec));
});

app.get('/v1/prefectures', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
  c.json({
    count: 47,
    prefectures: Object.entries(insurance.prefectures).map(([en, v]) => ({
      name: en, name_ja: v.prefecture_ja, code: v.code,
          prefecture_ja_full: PREFECTURE_FULL_JA[(v as any).prefecture_ja],
    })),
  }));
});
app.get('/v1/insurance-rates', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['prefecture', 'pref', 'as_of'] as const);
  if (unknownQ) return unknownQ;
  const r = needPref(c); if ('err' in r) return r.err;

  const asOfRaw = c.req.query('as_of');
  if (asOfRaw !== undefined && !parseDate(asOfRaw))
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');
  const outside = outsideRateWindow(c, 'social_insurance', asOfRaw ?? null);
  if (outside) return outside;

  const p = insurance.prefectures[r.pref];
  return c.json({
    prefecture: r.pref, prefecture_ja: p.prefecture_ja, code: p.code,
    ...(asOfRaw ? { as_of: asOfRaw } : {}),
    fiscal_year: insurance.meta.fiscal_year, effective_from: insurance.meta.effective_from,
    applies: RATE_WINDOWS.social_insurance,
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

app.get('/v1/standard-remuneration/table', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
  c.json({
    fiscal_year: insurance.meta.fiscal_year,
    health_grades: 50, pension_grades: 32,
    grades: insurance.grades,
    attribution: ATTRIBUTION.social_insurance,
  }));
});
app.get('/v1/standard-remuneration', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include', 'monthly_salary', 'pref', 'prefecture', 'remuneration'] as const);
  if (unknownQ) return unknownQ;

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
  const unknownQ = rejectUnknownQuery(c, ['business_type', 'as_of'] as const);
  if (unknownQ) return unknownQ;
  const t = (c.req.query('business_type') ?? 'general').toLowerCase();
  const bt = (empins.business_types as any)[t];
  if (!bt)
    return bad(c, `Unknown business_type: "${t}"`,
      `One of: ${Object.keys(empins.business_types).join(', ')}`);

  const asOfRaw = c.req.query('as_of');
  if (asOfRaw !== undefined && !parseDate(asOfRaw))
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');
  const outside = outsideRateWindow(c, 'employment_insurance', asOfRaw ?? null);
  if (outside) return outside;

  return c.json({
    business_type: t, label_ja: bt.label_ja,
    ...(asOfRaw ? { as_of: asOfRaw } : {}),
    fiscal_year: empins.meta.fiscal_year, effective_from: empins.meta.effective_from,
    applies: RATE_WINDOWS.employment_insurance,
    rates: { employee: bt.employee_rate, employer: bt.employer_rate, total: bt.total_rate },
    breakdown: bt.breakdown,
    note: empins.meta.note,
    freshness: freshnessOf('employment_insurance', new Date()),
    attribution: ATTRIBUTION.employment_insurance,
  });
});

/**
 * 地域別最低賃金が、いつまで「その額」なのか。
 *
 * 最低賃金法第4条は、最低賃金額に達しない賃金を定める労働契約を**無効とし**、その
 * 部分は最低賃金と同様の定をしたものと**みなす**。額を間違えることの帰結が契約の
 * 無効である以上、古い額を最新として返すのは重い。第14条は効力の発生を「公示の日から
 * 起算して三十日を経過した日」とし、別に定めることも認めるので、発効日は都道府県ごとに
 * 動く。実際には毎年10月に一斉に切り替わる。
 *
 * データが改定に追いついていないとき、直前の年度額を返すのが最も危険な振る舞いになる。
 * 勤怠SaaSが10月に「適法」と表示し、その賃金は無効になっている、という形で外れる。
 * 答えられないと言うほうがはるかに軽い。
 */
function minimumWageBeyondData(c: any, iso: string): any | null {
  const d = DATASETS.minimum_wage;
  const due = d.next_revision_expected;
  if (!due || iso < due) return null;

  // データ側が改定に追いついていれば、この防壁は自動的に効かなくなる。
  const newest = latestMinimumWageEffectiveFrom();
  if (newest && newest >= due) return null;

  return c.json({
    error: `The minimum wage in force on ${iso} is not established in this dataset.`,
    code: 'out_of_coverage',
    coverage: { through: newest, covers: d.covers, next_revision_expected: due },
    hint:
      '地域別最低賃金は毎年10月に改定されます。この日付以降の額はまだ収録されておらず、' +
      '直前の年度額を返せば、実際には下回っている賃金を「適法」と表示させることになります。' +
      '最低賃金法第4条は最低賃金額に達しない賃金を定める労働契約を無効とし、その部分を' +
      '最低賃金と同様の定をしたものとみなすので、古い額を返す誤りは契約の効力に及びます。' +
      `収録済みの最新は ${newest} 発効分です。改定額が収録され次第、この日付も答えられるようになります。`,
    source_url: d.source_url,
  }, 422);
}

app.get('/v1/minimum-wage', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['date', 'include', 'pref', 'prefecture'] as const);
  if (unknownQ) return unknownQ;

  const r = needPref(c); if ('err' in r) return r.err;
  const date = c.req.query('date') ?? null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return bad(c, 'Query parameter "date" must be ISO format YYYY-MM-DD.');

  // 日付を渡さない既定は「今日」。今日が改定日を越えていれば同じ扱いにする。
  const asked = date ?? new Date().toISOString().slice(0, 10);
  const beyond = minimumWageBeyondData(c, asked);
  if (beyond) return beyond;

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
  const unknownQ = rejectUnknownQuery(c, ['include', 'pref', 'prefecture'] as const);
  if (unknownQ) return unknownQ;

  const r = needPref(c); if ('err' in r) return r.err;
  const p = (minwage.prefectures as any)[r.pref];
  return c.json({
    prefecture: r.pref, prefecture_ja: p.prefecture_ja, code: p.code,
    count: p.history.length, history: p.history,
    attribution: ATTRIBUTION.minimum_wage,
  });
});

const PAYROLL_PARAMS = [
  'prefecture', 'pref', 'monthly_salary', 'standard_remuneration', 'age', 'birth_date',
  'as_of', 'business_type', 'employment_type', 'column', 'dependants', 'income_tax',
  'resident_tax', 'include',
  'commuting_allowance', 'commuting_distance_km', 'commuting_fare', 'commuting_parking', 'workers_comp_type',
] as const;

app.get('/v1/payroll', (c) => {
  const unknown = rejectUnknownQuery(c, PAYROLL_PARAMS);
  if (unknown) return unknown;

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

  // 年齢は「あると精度が上がる」ものではなく、徴収するかどうかを決める要件そのもの。
  // 渡さなければ介護保険なしで計算して200を返していたが、それは「40歳未満」という
  // 仮定を黙って置くことで、40〜64歳なら必ず過少になる。非専門の利用者ほど
  // 年齢が要ることを知らないので、いちばん間違えやすい人が黙って間違える。
  if (ageRaw === undefined && birthRaw === undefined)
    return bad(c, 'Either "age" or "birth_date" is required.', '介護保険法第9条 makes age the test itself: a 第2号被保険者 is someone 40 or over and under 65. Without it this endpoint would have to assume "under 40", which silently under-collects — 2,430 yen a month on a 300,000 yen salary in Tokyo. Pass age, or birth_date to have the 40, 65, 70 and 75 milestones applied to the exact day.',
      'missing_parameter');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');
  // as_of は年齢の判定だけでなく**どの料率表を使うか**でもある。載っていない
  // 時点を渡されて現行の率で答えるのは、間違いに気づく手がかりを消すこと。
  const outsideRates = outsideRateWindow(c, 'social_insurance', asOfRaw ?? null);
  if (outsideRates) return outsideRates;

  const pref = insurance.prefectures[r.pref];
  // 標準報酬月額は算定基礎届で決まり、翌年8月まで固定される。渡されなければ
  // 支給額から引き直すが、残業のある月はそれで等級が上がり過大控除になる。
  const smrRaw = c.req.query('standard_remuneration');
  const smr = smrRaw === undefined ? null : Number(smrRaw);
  if (smrRaw !== undefined && (!Number.isFinite(smr!) || smr! <= 0))
    return bad(c, '"standard_remuneration" must be a positive number.',
      'The 標準報酬月額 fixed by 算定基礎届 or 月額変更届. Pass it whenever you know it: without ' +
      'it the grade is re-derived from the pay you send, which is wrong in any month with overtime. ' +
      'GET /v1/standard-remuneration/regular decides it.');

  const empRaw = c.req.query('employment_type');
  const EMPLOYMENT_TYPES = ['employee', 'director', 'director_employee'] as const;
  if (empRaw !== undefined && !(EMPLOYMENT_TYPES as readonly string[]).includes(empRaw))
    return bad(c, `Unknown employment_type: "${empRaw}"`,
      'Use "employee", "director" (役員 — not covered by employment insurance, 雇用保険法第4条), ' +
      'or "director_employee" (兼務役員 — covered when the employee side is genuine). Defaults to employee.');
  const empType = (empRaw ?? 'employee') as 'employee' | 'director' | 'director_employee';

  // 通勤手当。社会保険では報酬に含み、所得税では非課税限度額まで課さない。
  // 距離を渡せば交通用具の距離区分表、渡さなければ交通機関として月15万円が限度。
  const commRaw = c.req.query('commuting_allowance');
  const commuting = commRaw === undefined ? null : Number(commRaw);
  if (commRaw !== undefined && (!Number.isFinite(commuting!) || commuting! < 0))
    return bad(c, '"commuting_allowance" must be a non-negative number (yen per month).');

  const kmRaw = c.req.query('commuting_distance_km');
  const km = kmRaw === undefined ? null : Number(kmRaw);
  if (kmRaw !== undefined && (!Number.isFinite(km!) || km! < 0))
    return bad(c, '"commuting_distance_km" must be a non-negative number (one-way kilometres).',
      'Pass it when the person commutes by car or bicycle; the non-taxable ceiling then comes from the distance table (国税庁 No.2585) instead of the 150,000 yen transit ceiling.');

  const fareRaw = c.req.query('commuting_fare');
  const fare = fareRaw === undefined ? null : Number(fareRaw);
  if (fareRaw !== undefined && (!Number.isFinite(fare!) || fare! < 0))
    return bad(c, '"commuting_fare" must be a non-negative number (yen per month).',
      'The reasonable fare or toll paid on top of a car or bicycle commute. With commuting_distance_km it makes the combined ceiling: distance band + fare, capped at 150,000.');

  // 駐車場等の利用料は距離区分の額への「加算」なので、距離が無ければ成り立たない。
  const parkRaw = c.req.query('commuting_parking');
  const parking = parkRaw === undefined ? null : Number(parkRaw);
  if (parkRaw !== undefined && (!Number.isFinite(parking!) || parking! < 0))
    return bad(c, '"commuting_parking" must be a non-negative number (yen per month).',
      'The parking cost the employee bears for a car or bicycle commute. It is added to the distance band, up to 5,000 a month.');

  if (commRaw === undefined && (kmRaw !== undefined || fareRaw !== undefined || parkRaw !== undefined))
    return bad(c, 'commuting_distance_km, commuting_fare and commuting_parking only mean something alongside commuting_allowance.',
      'Pass the allowance you actually pay; the distance, fare and parking decide how much of it is non-taxable.',
      'missing_parameter');

  if (parkRaw !== undefined && kmRaw === undefined)
    return bad(c, 'commuting_parking is an addition to the distance band, so it needs commuting_distance_km.',
      'The parking addition exists only for a commute by car or bicycle. Someone travelling only by train has no distance band for it to be added to.',
      'missing_parameter');

  // 労災保険は全額事業主負担。事業の種類ごとに率が35倍開くので既定値は置かない。
  const wcRaw = c.req.query('workers_comp_type');
  if (wcRaw !== undefined && !workersCompType(wcRaw))
    return bad(c, `Unknown workers_comp_type: "${wcRaw}"`,
      'Use the 事業の種類の番号 from GET /v1/workers-compensation, for example 98 for 卸売業・小売業、飲食店又は宿泊業.',
      'unknown_workers_comp_type');

  const allowances = commuting === null ? [] : [{
    name: '通勤手当', amount: commuting, kind: 'commuting' as const,
    distance_km: km, fare, parking,
  }];

  const slip = computePayslip({
    prefecture: r.pref, monthly_salary: salary, age, birth_date: birth, as_of: asOf!,
    business_type: btKey, employment_type: empType, standard_remuneration: smr,
    allowances, workers_comp_type: wcRaw ?? null,
    column: colRaw as Column, dependants, income_tax: withTax, resident_tax: residentTax,
  });

  return c.json({
    input: {
      prefecture: r.pref, prefecture_ja: pref.prefecture_ja,
      monthly_salary: salary, age, business_type: btKey,
      ...(birth ? { birth_date: birthRaw, as_of: (asOf ?? new Date()).toISOString().slice(0, 10) } : {}),
      ...(withTax ? { column: colRaw, dependants } : {}),
      ...(residentTax ? { resident_tax: residentTax } : {}),
      ...(commuting !== null ? {
        commuting_allowance: commuting,
        ...(km !== null ? { commuting_distance_km: km } : {}),
        ...(fare !== null ? { commuting_fare: fare } : {}),
        ...(parking !== null ? { commuting_parking: parking } : {}),
      } : {}),
    },
    ...(slip.age_status ? { age_status: slip.age_status } : {}),
    earnings: slip.earnings,
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
      workers_compensation: wcRaw !== undefined
        ? 'Workers compensation is borne entirely by the employer and is included in totals.employer_cost.'
        : 'Workers compensation (労災保険) is not included unless you pass workers_comp_type; the rate runs from 2.5/1000 to 88/1000 by industry, so there is no safe default. totals.employer_cost is short by that amount until you do.',
      resident_tax: residentTax
        ? 'Resident tax is the figure you supplied; it is not computed here.'
        : 'Resident tax (住民税) is assessed by the municipality and is not computed here. Pass resident_tax= to subtract it.',
      batch: 'POST /v1/payroll/batch runs many employees at once, and takes named pay items as an array.',
      commuting: commuting !== null
        ? 'A commuting allowance is remuneration for social insurance in full, but income tax is charged only on what exceeds the non-taxable ceiling. earnings.items carries the split.'
        : 'Pass commuting_allowance to have the allowance counted as remuneration for social insurance and exempted, up to the statutory ceiling, from income tax.',
    },
    attribution: {
      ...ATTRIBUTION,
      ...(withTax ? { withholding_tax: WITHHOLDING_ATTRIBUTION } : {}),
      ...(commuting !== null ? { commuting_allowance: COMMUTING_SOURCE } : {}),
      ...(wcRaw !== undefined ? { workers_compensation: WORKERS_COMP_ATTRIBUTION } : {}),
    },
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
  const unknownQ = rejectUnknownQuery(c, ['from', 'include', 'to', 'year'] as const);
  if (unknownQ) return unknownQ;

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
  const unknownQ = rejectUnknownQuery(c, ['calendar', 'date', 'include'] as const);
  if (unknownQ) return unknownQ;

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
  const unknownQ = rejectUnknownQuery(c, ['calendar', 'end', 'from', 'include', 'start', 'to'] as const);
  if (unknownQ) return unknownQ;

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
  const unknownQ = rejectUnknownQuery(c, ['calendar', 'date', 'days', 'include'] as const);
  if (unknownQ) return unknownQ;

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
  const unknownQ = rejectUnknownQuery(c, ['amount', 'date', 'include', 'reduced'] as const);
  if (unknownQ) return unknownQ;

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

app.get('/v1/consumption-tax/history', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
  c.json({
    count: ctax.history.length,
    history: ctax.history,
    reduced_rate_scope: ctax.reduced_rate_scope,
    attribution: { source: ctax.meta.source, source_url: ctax.meta.source_url },
  }));
});// ---- Corporate number (法人番号) structural validation ----------------------

app.get('/v1/corporate-number/validate', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include', 'number'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('number');
  if (!raw) return bad(c, 'Query parameter "number" is required.', 'A 13-digit 法人番号, e.g. 8700110005901.');
  const r = validateCorporateNumber(raw);
  return c.json({ input: raw, ...r, attribution: CORPORATE_NUMBER_ATTRIBUTION });
});

app.get('/v1/corporate-number/check-digit', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['base', 'include'] as const);
  if (unknownQ) return unknownQ;

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

/**
 * 登録番号について、チェックディジットが通ることと、いま有効な登録であることは別。
 *
 * 消費税法第57条の2は、税務署長が登録簿に登載して**公表しなければならない**とし、
 * 一方で登録を**取り消す**ことができ、登録が**効力を失う**場合も定める。つまり
 * 形式が正しい番号が、未登録・取消済み・失効済みのいずれでもありうる。
 *
 * このAPIは登録簿を引かない。引かずに「検証した」と読める答えを返すのが、
 * この項目でいちばん危ないところだった。何を見ていないかを返り値に書く。
 */
/** 一括検査の上限。形式検査だけなので給与のバッチより多く通せる。 */
const MAX_INVOICE_BATCH = 1000;

const REGISTRATION_STATUS_CAVEAT = {
  checked: false,
  meaning:
    'チェックディジットが通ったことは、番号の形が正しいことしか意味しません。' +
    'その番号が実際に登録されているか、いま有効かは、この結果からは分かりません。',
  not_visible_here: [
    '未登録 — 形式を満たすだけの番号は誰でも作れます。',
    '取消済み — 消費税法第57条の2は税務署長が登録を取り消すことができると定めています。',
    '失効済み — 同条は登録が効力を失う場合も定めています。',
  ],
  statute: '消費税法第57条の2(適格請求書発行事業者の登録。登録簿への登載と公表、登録の取消し、登録の失効)',
  where_to_check: '国税庁「適格請求書発行事業者公表サイト」で番号を照会してください。取消年月日・失効年月日もそこに公表されます。',
  where_to_check_url: 'https://www.invoice-kohyo.nta.go.jp/',
  bulk: '同サイトは全件データのダウンロードとWeb-APIを提供しています。件数が多いならそちらが確実です。',
} as const;

app.get('/v1/invoice-number/validate', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include', 'number'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('number');
  if (!raw)
    return bad(c, 'Query parameter "number" is required.',
      'A registration number such as T8700110005901.');
  return c.json({
    ...validateInvoiceNumber(raw),
    registration_status: REGISTRATION_STATUS_CAVEAT,
    attribution: INVOICE_NUMBER_ATTRIBUTION,
  });
});

/**
 * 登録番号をまとめて検査する。
 *
 * 顧問先300社を1件ずつ問うのは現実的でない。分かるのは形式だけだが、形式で落ちる
 * ものを先に外せれば、登録簿を引く手間はその分だけ減る。
 *
 * 重複は畳まずそのまま返す。呼ぶ側の一覧と行が揃わなくなるほうが困る。
 */
app.post('/v1/invoice-number/validate/batch', async (c) => {
  let payload: { numbers?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return bad(c, 'Request body must be JSON.', 'POST {"numbers": ["T8700110005901", ...]}');
  }

  const list = payload?.numbers;
  if (!Array.isArray(list))
    return bad(c, '"numbers" must be an array of registration numbers.');
  if (list.length === 0) return bad(c, '"numbers" must not be empty.');
  if (list.length > MAX_INVOICE_BATCH)
    return bad(c, `A batch is limited to ${MAX_INVOICE_BATCH} numbers; got ${list.length}.`,
      'Split the run, or use the bulk dataset the NTA publishes.',
      'batch_too_large');
  if (list.some((n) => typeof n !== 'string'))
    return bad(c, 'Every element of "numbers" must be a string.');

  const results = (list as string[]).map((n, index) => ({ index, ...validateInvoiceNumber(n) }));
  const passed = results.filter((r) => r.check_digit_valid).length;

  return c.json({
    run_id: await runId(payload),
    idempotency: idempotencyNote(c.req.header('idempotency-key')),
    count: results.length,
    summary: {
      check_digit_valid: passed,
      rejected: results.length - passed,
      note: '形式で落ちたものは登録簿を引くまでもありません。通ったものは、そこから先が未確認です。',
    },
    results,
    registration_status: REGISTRATION_STATUS_CAVEAT,
    notes: {
      duplicates: '重複は畳まずそのまま返します。呼ぶ側の一覧と行を揃えられるようにするためです。',
      order: '各結果は入力の index を持ちます。',
    },
    attribution: INVOICE_NUMBER_ATTRIBUTION,
  });
});

app.get('/v1/withholding-tax', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['amount', 'column', 'dependants', 'include', 'taxable_amount'] as const);
  if (unknownQ) return unknownQ;

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
  const unknownQ = rejectUnknownQuery(c, ['amount', 'column', 'dependants', 'include', 'taxable_amount'] as const);
  if (unknownQ) return unknownQ;

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
  const unknownQ = rejectUnknownQuery(c, ['amount', 'dependants', 'include', 'spouse', 'taxable_amount'] as const);
  if (unknownQ) return unknownQ;

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

/**
 * 入力から決まる実行ID。
 *
 * バッチは計算して返すだけで、何も記録しない。だから再送しても二重計上は起きない。
 * 起きないことを利用者が確かめられないのが問題だった。同じ入力なら必ず同じ id が
 * 返るようにしておけば、切れた通信のあとで「同じ実行か、別の実行か」を自分の台帳と
 * 突き合わせて決められる。
 *
 * キーの順序では変わらないよう正規化する。JSONの書き方で id が動くと使えない。
 * ただし配列の順序は保つ — 給与の台帳では並び順も意味を持つ。
 */
function canonicalise(v: any): any {
  if (Array.isArray(v)) return v.map(canonicalise);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalise(v[k])]));
  return v;
}

async function runId(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalise(payload)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 冪等性についての申告。
 *
 * draft-ietf-httpapi-idempotency-key-header-07 は、同じキーで内容が違えば 422、
 * 処理中の重複なら 409 を返せと定める。ここではどちらも起きない。保存していないので
 * 検出しようがなく、**検出したふりをするより「起きえない」と言うほうが正しい。**
 * Idempotency-Key は受け取って返す — クライアントが自動で付けることがあるため。
 */
function idempotencyNote(key: string | undefined) {
  return {
    ...(key !== undefined ? { key } : {}),
    safe_to_retry: true,
    deterministic_run_id: true,
    why:
      'この呼び出しは計算して返すだけで、何も記録しません。副作用が無いので、再送しても' +
      '二重計上は起きません。run_id は送った内容だけから決まるので、同じ内容なら必ず同じ値に' +
      'なります。通信が切れたときは、返ってきた run_id を自分の台帳と突き合わせてください。',
    not_applicable: [
      '409 Conflict — 処理中の重複を検出するには保存が要ります。持っていないので起きません。',
      '422 Unprocessable Content — 同じキーで異なる内容を検出するにも保存が要ります。同じ理由で起きません。',
    ],
    reference: 'draft-ietf-httpapi-idempotency-key-header-07 (2025-10-15)',
    reference_url: 'https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/',
  };
}

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
    run_id: await runId(payload),
    idempotency: idempotencyNote(c.req.header('idempotency-key')),
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

/**
 * 労災保険率表。事業の種類の番号で引く。
 *
 * 番号は徴収法施行規則別表第1のもので、労働保険関係成立届に書くのと同じ番号。
 * 事業主が既に持っている値で引けるようにしてある。
 */
app.get('/v1/workers-compensation', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['business_type', 'wage_total', 'as_of'] as const);
  if (unknownQ) return unknownQ;

  const asOfRaw = c.req.query('as_of');
  if (asOfRaw !== undefined && !parseDate(asOfRaw))
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');
  const outside = outsideRateWindow(c, 'workers_compensation', asOfRaw ?? null);
  if (outside) return outside;

  const raw = c.req.query('business_type');
  if (raw === undefined) {
    return c.json({
      fiscal_year: WORKERS_COMP_META.fiscal_year,
      effective_from: WORKERS_COMP_META.effective_from,
      applies: RATE_WINDOWS.workers_compensation,
      burden: WORKERS_COMP_META.burden,
      count: WORKERS_COMP_TYPES.length,
      business_types: WORKERS_COMP_TYPES,
      notes: {
        lookup: 'Pass business_type= the 事業の種類の番号 (for example 98) to get one row, and wage_total= to have the premium worked out.',
        payroll: 'GET /v1/payroll?workers_comp_type=98 folds it into totals.employer_cost.',
        excluded: WORKERS_COMP_META.excluded,
      },
      attribution: WORKERS_COMP_ATTRIBUTION,
    });
  }

  const type = workersCompType(raw);
  if (!type)
    return bad(c, `Unknown business_type: "${raw}"`,
      'Use the 事業の種類の番号 from GET /v1/workers-compensation (02-99).',
      'unknown_workers_comp_type');

  const wageRaw = c.req.query('wage_total');
  const wage = wageRaw === undefined ? null : Number(wageRaw);
  if (wageRaw !== undefined && (!Number.isFinite(wage!) || wage! < 0))
    return bad(c, '"wage_total" must be a non-negative number (yen).',
      'The 賃金総額 for the period — the same wage base employment insurance uses.');

  return c.json({
    fiscal_year: WORKERS_COMP_META.fiscal_year,
    effective_from: WORKERS_COMP_META.effective_from,
    applies: RATE_WINDOWS.workers_compensation,
    business_type: type,
    burden: WORKERS_COMP_META.burden,
    ...(wage !== null ? {
      premium: {
        wage_total: wage,
        employee: 0,
        employer: Math.round(wage * type.rate * 100) / 100,
        total: Math.round(wage * type.rate * 100) / 100,
        working: `${wage} * ${type.rate_per_1000}/1000`,
      },
    } : {}),
    notes: {
      burden: 'The whole premium falls on the employer; nothing is deducted from the employee.',
      wage_base: 'Charged on 賃金総額 (徴収法第2条第2項) — the same base as employment insurance, so a commuting allowance counts and a reimbursement does not.',
      excluded: WORKERS_COMP_META.excluded,
    },
    attribution: WORKERS_COMP_ATTRIBUTION,
  });
});

app.get('/v1/leave-exemption', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['end', 'include', 'kind', 'start', 'worked_days'] as const);
  if (unknownQ) return unknownQ;

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
  const unknownQ = rejectUnknownQuery(c, ['current_remuneration', 'fixed_pay_change', 'include', 'months', 'revision_month', 'worker_type', 'year'] as const);
  if (unknownQ) return unknownQ;

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

/**
 * 算定基礎届の提出対象を判定するための入力。
 * 年を渡さなければ今年。基準日が7月1日なので、どの年の定時決定かで結論が変わる。
 */
function parseSubmissionQuery(c: any): { value: any } | { err: any } {
  const yearRaw = c.req.query('year');
  const year = yearRaw === undefined ? new Date().getFullYear() : Number(yearRaw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    return { err: bad(c, '"year" must be a four-digit year.',
      'The determination year. Its 1 July is the reference date the article fixes.') };

  const iso = (key: string) => {
    const raw = c.req.query(key);
    if (raw === undefined) return { ok: true as const, value: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !parseDate(raw))
      return { ok: false as const, value: null };
    return { ok: true as const, value: raw };
  };

  const acquired = iso('acquired_on');
  if (!acquired.ok)
    return { err: bad(c, '"acquired_on" must be a valid ISO date (YYYY-MM-DD).',
      '資格取得日。6月1日から7月1日までの取得は定時決定の対象外です (健康保険法第41条)。') };
  const left = iso('left_on');
  if (!left.ok)
    return { err: bad(c, '"left_on" must be a valid ISO date (YYYY-MM-DD).',
      '退職日。基準日である7月1日に使用されていなければ対象外です。') };

  // 1〜12を受け取り、7〜9だけを除外事由にする。7〜9以外を拒否すると、6月に改定が
  // あった人について「まだ出す」と答えられなくなり、判定が null に落ちてしまう。
  const revRaw = c.req.query('revision_month');
  const revision = revRaw === undefined ? null : Number(revRaw);
  if (revRaw !== undefined && (!Number.isInteger(revision!) || revision! < 1 || revision! > 12))
    return { err: bad(c, '"revision_month" must be a month number from 1 to 12.',
      '定時決定を外すのは「七月から九月までのいずれかの月」からの随時改定だけです (健康保険法第41条)。' +
      'それ以外の月の改定は定時決定を妨げないので、渡せば「提出対象」と返します。') };

  return { value: { year, acquired_on: acquired.value, left_on: left.value, revision_month: revision } };
}

app.get('/v1/standard-remuneration/regular', (c) => {
  // 未知パラメータを黙って捨てると、acquired_on の綴り間違いが「対象」に化ける。
  const unknownQ = rejectUnknownQuery(c, [
    'months', 'worker_type', 'previous_remuneration', 'acquired_month',
    'year', 'acquired_on', 'left_on', 'revision_month',
  ] as const);
  if (unknownQ) return unknownQ;

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

  const sub = parseSubmissionQuery(c);
  if ('err' in sub) return sub.err;

  return c.json({
    ...judgeRegularDecision({
      months: months as [PayMonth, PayMonth, PayMonth],
      worker_type: workerType,
      previous_remuneration: previous,
    }),
    submission: judgeSubmission(sub.value),
    not_required_for: REGULAR_DECISION_EXCLUSIONS,
    ...(acquired !== undefined
      ? { acquisition_decision: acquisitionDecisionPeriod(acquired) }
      : {}),
    guidance: { payment_basis_days: PAYMENT_BASIS_DAYS_GUIDANCE },
    attribution: REVISION_ATTRIBUTION,
  });
});

/**
 * 定時決定をまとめて。
 *
 * 算定基礎届は6月に**全社員分を一度に**出すもので、1人ずつ問う場面がそもそも無い。
 * 健康保険法第41条は「その年の四月、五月及び六月に受けた報酬の総額をその月数で
 * 除して得た額」を報酬月額とし、決まった標準報酬月額をその年の九月から翌年八月まで
 * 適用すると定める。年に一度、全員分、同じ月に。
 *
 * 給与には POST /v1/payroll/batch があるのに判定系には無かった。200人の事業所なら
 * 200回呼ぶことになる。単発の口はあるのに実務が通る口が無い、という同じ形の欠落は
 * これで3度目で、標準報酬月額を batch に渡せなかったのと、batch が生年月日を
 * 受け取れなかったのが前の2つ。
 */
app.post('/v1/standard-remuneration/regular/batch', async (c) => {
  let payload: { employees?: unknown; defaults?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return bad(c, 'Request body must be JSON.',
      'POST {"defaults": {...}, "employees": [{"id": "e1", "months": [{"remuneration": 350000, "payment_basis_days": 30}, ...]}]}');
  }

  const rows = payload?.employees;
  if (!Array.isArray(rows))
    return bad(c, '"employees" must be an array.', 'Each element is one employee to decide.');
  if (rows.length === 0) return bad(c, '"employees" must not be empty.');

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
          'A 算定基礎届 covers everyone at once, so this is the cap most likely to bind in June.',
      'batch_too_large');
  if (rows.some((r) => typeof r !== 'object' || r === null || Array.isArray(r)))
    return bad(c, 'Every element of "employees" must be an object.');

  const defaults = (payload?.defaults ?? {}) as Record<string, unknown>;
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults))
    return bad(c, '"defaults" must be an object.');

  const results: any[] = [];
  const errors: any[] = [];

  rows.forEach((raw, index) => {
    const row = raw as Record<string, unknown>;
    const id = row.id === undefined ? undefined : String(row.id);
    const at = (code: string, error: string) =>
      errors.push({ index, ...(id !== undefined ? { id } : {}), code, error });

    const monthsRaw = row.months ?? (defaults as any).months;
    if (!Array.isArray(monthsRaw) || monthsRaw.length !== 3)
      return at('invalid_request',
        'months must be an array of exactly three entries — April, May and June (健康保険法第41条).');

    const months: PayMonth[] = [];
    for (const [i, mRaw] of monthsRaw.entries()) {
      if (typeof mRaw !== 'object' || mRaw === null || Array.isArray(mRaw))
        return at('invalid_request', `months[${i}] must be an object.`);
      const mo = mRaw as Record<string, unknown>;
      const remuneration = Number(mo.remuneration);
      const days = Number(mo.payment_basis_days);
      if (!Number.isFinite(remuneration) || remuneration < 0)
        return at('invalid_request', `months[${i}].remuneration must be a non-negative number.`);
      if (!Number.isInteger(days) || days < 0 || days > 31)
        return at('invalid_request', `months[${i}].payment_basis_days must be a whole number of days from 0 to 31.`);
      months.push({ remuneration, payment_basis_days: days });
    }

    const wtRaw = row.worker_type ?? (defaults as any).worker_type;
    const workerType = parseWorkerType(wtRaw === undefined ? undefined : String(wtRaw));
    if (workerType === null)
      return at('unknown_worker_type',
        `Unknown worker_type: "${String(wtRaw)}". Use one of ${WORKER_TYPES.join(', ')}.`);

    const prevRaw = row.previous_remuneration ?? (defaults as any).previous_remuneration;
    const previous = prevRaw === undefined || prevRaw === null ? undefined : Number(prevRaw);
    if (previous !== undefined && (!Number.isFinite(previous) || previous < 0))
      return at('invalid_request', 'previous_remuneration must be a non-negative number.');

    // 6月の作業は「誰を出すか」を選り分けること。等級だけ出しても提出物は決まらない。
    const yearRaw = row.year ?? (defaults as any).year;
    const year = yearRaw === undefined || yearRaw === null ? new Date().getFullYear() : Number(yearRaw);
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      return at('invalid_request', 'year must be a four-digit year.');

    const isoOf = (key: string) => {
      const v = (row as any)[key] ?? (defaults as any)[key];
      if (v === undefined || v === null) return { ok: true as const, value: null };
      const str = String(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || !parseDate(str)) return { ok: false as const, value: null };
      return { ok: true as const, value: str };
    };
    const acquired = isoOf('acquired_on');
    if (!acquired.ok) return at('invalid_request', 'acquired_on must be a valid ISO date (YYYY-MM-DD).');
    const leftOn = isoOf('left_on');
    if (!leftOn.ok) return at('invalid_request', 'left_on must be a valid ISO date (YYYY-MM-DD).');

    const revRaw = (row as any).revision_month ?? (defaults as any).revision_month;
    const revision = revRaw === undefined || revRaw === null ? null : Number(revRaw);
    if (revRaw !== undefined && revRaw !== null
        && (!Number.isInteger(revision!) || revision! < 1 || revision! > 12))
      return at('invalid_request',
        'revision_month must be a month number from 1 to 12. Only a revision from July to September displaces the determination (健康保険法第41条).');

    let decision;
    try {
      decision = judgeRegularDecision({
        months: months as [PayMonth, PayMonth, PayMonth],
        worker_type: workerType,
        previous_remuneration: previous,
      });
    } catch (e: any) {
      return at('invalid_request', String(e?.message ?? e));
    }

    // 6月に知りたいのは「誰の等級が動くか」。等級そのものより、動いた事実のほうが
    // 提出物の量を決める。previous_remuneration を渡していない行は判定できないので
    // null にする — false にすると「動かなかった」と読めてしまう。
    const changed = previous === undefined || !('schemes' in decision)
      ? null
      : realGrade('health', previous) !== decision.schemes.health.grade
        || realGrade('pension', previous) !== decision.schemes.pension.grade;

    const submission = judgeSubmission({
      year, acquired_on: acquired.value, left_on: leftOn.value, revision_month: revision,
    });

    results.push({ index, ...(id !== undefined ? { id } : {}), ...decision, changed, submission });
  });

  const decidedRows = results.filter((r) => r.changed !== null);
  return c.json({
    run_id: await runId(payload),
    idempotency: idempotencyNote(c.req.header('idempotency-key')),
    count: rows.length,
    succeeded: results.length,
    failed: errors.length,
    defaults,
    applies: {
      from_month: 9,
      through_month: 8,
      basis: '健康保険法第41条。決まった標準報酬月額はその年の9月から翌年8月まで適用されます。',
    },
    summary: {
      employees: results.length,
      changed: decidedRows.filter((r) => r.changed === true).length,
      unchanged: decidedRows.filter((r) => r.changed === false).length,
      undetermined: results.length - decidedRows.length,
      insurer_determination: results.filter((r) => r.insurer_determination).length,
      // 6月に提出する枚数。等級が動いた人数と提出枚数は別で、後者が作業量を決める。
      to_file: results.filter((r) => r.submission?.required === true).length,
      not_required: results.filter((r) => r.submission?.required === false).length,
      filing_undetermined: results.filter((r) => r.submission?.required === null).length,
    },
    results,
    errors,
    notes: {
      partial: 'A row that fails is reported in "errors" and skipped; the rest still run.',
      changed:
        'changed is null unless previous_remuneration was given — with no grade from last year there is ' +
        'nothing to compare, and reporting false there would read as "did not move".',
      months: 'The three entries are April, May and June in that order. A month under 17 payment-basis ' +
        'days is left out of the average (健康保険法第41条).',
      submission:
        'submission.required judges 健康保険法第41条 from acquired_on, left_on and revision_month. ' +
        'Without any of the three it is null — not knowing and not having to file are different answers. ' +
        'An excluded employee is still graded, so the exclusion can be checked against a figure.',
    },
    attribution: REVISION_ATTRIBUTION,
  });
});

app.get('/v1/standard-remuneration/leave-end', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['acquired_month', 'current_remuneration', 'include', 'kind', 'months', 'next_leave_starts_immediately', 'worker_type'] as const);
  if (unknownQ) return unknownQ;

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
      run_id: await runId(body),
      idempotency: idempotencyNote(c.req.header('idempotency-key')),
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
    run_id: await runId(body),
    idempotency: idempotencyNote(c.req.header('idempotency-key')),
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

/**
 * 被保険者区分そのものを判定する。
 *
 * `worker_type` は支払基礎日数の閾値を17日と11日で切り替える。日本の社会保険で
 * いちばん間違えやすい分類でありながら、このAPIは利用者に決めさせていた。誤れば
 * 定時決定が無警告で誤答になる。材料は揃っているのに判定を渡していなかった。
 */
/**
 * 年次有給休暇の付与日数と、年5日の時季指定義務。
 *
 * 労務の相談でいちばん多い問いだが、条文に数字が書いてあるので判定できる。
 * 20日という上限は条文には無く、10労働日 + 六年以上の加算十労働日 の結果である。
 */
/**
 * 年間の労務コスト。
 *
 * 採用の可否を決めるときに見る数字がこれで、月次×12 + 賞与では出ない。
 * 健康保険法第45条は標準賞与額の**年度の累計額**を573万円で切り、年度を4月1日から
 * 翌年3月31日とする。厚生年金保険法第24条の4は**1回あたり**150万円で切り、年度累計の
 * 定めを置かない。だから同じ賞与でも、健保は年度の何番目かで結果が変わり、厚年は
 * 変わらない。この非対称を自分で足し合わせるのは、間違えやすいわりに得るものが無い。
 *
 * 賞与は渡された順に年度内で処理する。健保の枠は先に来た賞与から埋まる。
 */
/**
 * 被用者保険に入らない人の側。
 *
 * このAPIに `/v1/payroll` しか無かったころ、フリーランスが呼ぶと会社員として
 * 計算した答えが返り、エラーにもならなかった。気づく手がかりが無いまま違う制度の
 * 数字が出るのは、無いより悪い。
 *
 * 国民年金は全国一律なので答えられる。国民健康保険は市町村が条例で定めるので、
 * 全国一律の答えが存在しない。**答えられないほうを、答えられない形で返す。**
 */
app.get('/v1/national-insurance', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['as_of', 'months', 'supplementary', 'include'] as const);
  if (unknownQ) return unknownQ;

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date().toISOString().slice(0, 10) : asOfRaw;
  if (asOfRaw !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) || !parseDate(asOfRaw)))
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');

  // 保険料は毎年度4月に変わる。収録している年度の外を、その年度の額で答えない。
  // 最低賃金と同じ形の防壁で、データが追いつけば自動的に外れる。
  if (asOf < NATIONAL_PENSION.from || asOf > NATIONAL_PENSION.through)
    return c.json({
      error: `The national pension contribution for ${asOf} is not carried here.`,
      code: 'out_of_coverage',
      coverage: { from: NATIONAL_PENSION.from, through: NATIONAL_PENSION.through,
                  fiscal_year: NATIONAL_PENSION.fiscal_year },
      hint:
        '国民年金保険料は年度ごとに変わります。国民年金法第87条は法定額に「保険料改定率」を乗じた額とし、' +
        'その改定率を毎年度「政令で定める」と定めているためです。収録しているのは' +
        `${NATIONAL_PENSION.era_year}年度(${NATIONAL_PENSION.from}〜${NATIONAL_PENSION.through})分で、` +
        'それ以外の日付に現年度の額を返せば、もっともらしい誤りになります。',
      source_url: NATIONAL_PENSION.source_url,
    }, 422);

  const monthsRaw = c.req.query('months');
  const months = monthsRaw === undefined ? 1 : Number(monthsRaw);
  if (monthsRaw !== undefined && (!Number.isInteger(months) || months < 1 || months > 480))
    return bad(c, '"months" must be a whole number of months from 1 to 480.');

  const suppRaw = c.req.query('supplementary');
  if (suppRaw !== undefined && suppRaw !== 'true' && suppRaw !== 'false')
    return bad(c, '"supplementary" must be true or false.',
      '付加保険料。任意で月400円を納めると老齢基礎年金が増えます (国民年金法第87条の2)。');
  const supplementary = suppRaw === 'true';

  const perMonth = NATIONAL_PENSION.monthly + (supplementary ? NATIONAL_PENSION.supplementary_monthly : 0);

  return c.json({
    as_of: asOf,
    national_pension: {
      ...NATIONAL_PENSION,
      supplementary_included: supplementary,
      monthly_total: perMonth,
      months,
      total: perMonth * months,
      flat_rate: true,
    },
    national_health_insurance: NATIONAL_HEALTH,
    employee_insurance: {
      note:
        '被用者保険(健康保険・厚生年金)に入るかどうかは GET /v1/worker-type が判定します。' +
        '入るなら GET /v1/payroll、入らないならこのエンドポイントの側です。' +
        '週20時間・月88,000円・学生でないこと・事業所の規模で決まります (健康保険法第3条第1項第9号)。',
      worker_type: '/v1/worker-type',
      payroll: '/v1/payroll',
    },
    notes: {
      why_no_health_amount:
        '国民健康保険の額を返さないのは未実装だからではありません。国民健康保険法第76条が' +
        '市町村に条例で定めさせているので、全国一律の金額が存在しないためです。',
      exemptions:
        '免除・納付猶予・学生納付特例に該当すれば納付額は変わります。該当するかは所得と世帯の' +
        '事実によるため、ここでは判定していません。',
      prepayment: 'まとめて前納すると割引があります。割引額はこのAPIでは扱っていません。',
    },
    attribution: NATIONAL_INSURANCE_ATTRIBUTION,
  });
});

app.get('/v1/annual-cost', (c) => {
  const unknownQ = rejectUnknownQuery(c, [
    'prefecture', 'pref', 'monthly_salary', 'standard_remuneration', 'age', 'birth_date',
    'business_type', 'column', 'dependants', 'income_tax', 'resident_tax',
    'employment_type', 'workers_comp_type', 'bonuses', 'fiscal_year', 'as_of', 'include',
  ] as const);
  if (unknownQ) return unknownQ;

  const r = needPref(c); if ('err' in r) return r.err;

  const salaryRaw = c.req.query('monthly_salary');
  const salary = salaryRaw === undefined ? NaN : Number(salaryRaw);
  if (salaryRaw === undefined || !Number.isFinite(salary) || salary < 0)
    return bad(c, '"monthly_salary" is required and must be a non-negative number.');

  const ageRaw = c.req.query('age');
  const age = ageRaw === undefined ? null : Number(ageRaw);
  if (ageRaw !== undefined && (!Number.isFinite(age!) || age! < 0 || age! > 120))
    return bad(c, '"age" must be a number between 0 and 120.');
  const birthRaw = c.req.query('birth_date');
  const birth = birthRaw === undefined ? null : parseDate(birthRaw);
  if (birthRaw !== undefined && !birth)
    return bad(c, '"birth_date" must be a valid ISO date (YYYY-MM-DD).');
  if (ageRaw === undefined && birthRaw === undefined)
    return bad(c, 'Either "age" or "birth_date" is required.',
      '介護保険法第9条 makes age the test for whether long-term care is charged at all, so an annual figure without it would be understated for anyone between 40 and 64.',
      'missing_parameter');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');
  const outside = outsideRateWindow(c, 'social_insurance', asOfRaw ?? null);
  if (outside) return outside;

  const btKey = String(c.req.query('business_type') ?? 'general').toLowerCase();
  if (!(empins.business_types as any)[btKey])
    return bad(c, `Unknown business_type: "${btKey}"`);

  const colRaw = String(c.req.query('column') ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return bad(c, `Unknown column: "${colRaw}". Use "kou" or "otsu".`);

  const depRaw = c.req.query('dependants');
  const dependants = depRaw === undefined ? 0 : Number(depRaw);
  if (depRaw !== undefined && (!Number.isInteger(dependants) || dependants < 0))
    return bad(c, '"dependants" must be a whole number of 0 or more.');

  const residentRaw = c.req.query('resident_tax');
  const residentTax = residentRaw === undefined ? 0 : Number(residentRaw);
  if (residentRaw !== undefined && (!Number.isFinite(residentTax) || residentTax < 0))
    return bad(c, '"resident_tax" must be a non-negative number.');

  const smrRaw = c.req.query('standard_remuneration');
  const smr = smrRaw === undefined ? null : Number(smrRaw);
  if (smrRaw !== undefined && (!Number.isFinite(smr!) || smr! < 0))
    return bad(c, '"standard_remuneration" must be a non-negative number.');

  const empRaw = String(c.req.query('employment_type') ?? 'employee');
  if (empRaw !== 'employee' && empRaw !== 'director' && empRaw !== 'director_employee')
    return bad(c, `Unknown employment_type: "${empRaw}".`);

  const wcRaw = c.req.query('workers_comp_type');
  if (wcRaw !== undefined && !workersCompType(wcRaw))
    return bad(c, `Unknown workers_comp_type: "${wcRaw}"`);

  const bonusRaw = c.req.query('bonuses');
  const bonuses: number[] = [];
  if (bonusRaw !== undefined && bonusRaw !== '') {
    for (const part of bonusRaw.split(',')) {
      const v = Number(part.trim());
      if (!Number.isFinite(v) || v < 0)
        return bad(c, `"bonuses" must be a comma-separated list of non-negative numbers; got "${part.trim()}".`,
          'They are applied in the order given, because the health cap is cumulative over the year.');
      bonuses.push(v);
    }
  }

  const fyRaw = c.req.query('fiscal_year');
  const fiscalYear = fyRaw === undefined
    ? (asOf!.getUTCMonth() >= 3 ? asOf!.getUTCFullYear() : asOf!.getUTCFullYear() - 1)
    : Number(fyRaw);
  if (fyRaw !== undefined && (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100))
    return bad(c, '"fiscal_year" must be a four-digit year. The year runs 1 April to 31 March.');

  const slip = computePayslip({
    prefecture: r.pref, monthly_salary: salary, age, birth_date: birth, as_of: asOf!,
    business_type: btKey, employment_type: empRaw as any, standard_remuneration: smr,
    allowances: [], workers_comp_type: wcRaw ?? null,
    column: colRaw as Column, dependants, income_tax: true, resident_tax: residentTax,
  });

  // 健保の枠は年度を通して積み上がる。渡された順に埋める。
  let ytd = 0;
  const wc = wcRaw ? workersCompType(wcRaw) : null;
  const rows = bonuses.map((amount) => {
    const b = bonusInsurance({
      prefecture: r.pref, bonus: amount, fiscal_year_to_date: ytd,
      age, birth_date: birth, as_of: asOf!,
    });
    ytd += b.bases.health;
    const wcEmployer = wc ? Math.round(amount * wc.rate * 100) / 100 : 0;
    return {
      gross: amount,
      health: {
        standard_bonus: b.bases.health,
        capped: b.bases.health_capped,
        annual_used_before: b.caps.health_annual_used_before,
        annual_remaining_after: b.caps.health_annual_remaining_after,
      },
      pension: {
        standard_bonus: b.bases.pension,
        capped: b.bases.pension_capped,
      },
      employee: b.totals.employee,
      employer: b.totals.employer,
      workers_compensation_employer: wcEmployer,
      deductions: b.deductions,
    };
  });

  const sum = (f: (x: typeof rows[number]) => number) =>
    Math.round(rows.reduce((a, x) => a + f(x), 0) * 100) / 100;

  const bonusGross = sum((x) => x.gross);
  const bonusEmployee = sum((x) => x.employee);
  const bonusEmployer = sum((x) => x.employer) + sum((x) => x.workers_compensation_employer);

  const monthly = slip.totals;
  const round2 = (v: number) => Math.round(v * 100) / 100;

  return c.json({
    input: {
      prefecture: r.pref, monthly_salary: salary,
      ...(smr !== null ? { standard_remuneration: smr } : {}),
      ...(age !== null ? { age } : {}),
      ...(birthRaw ? { birth_date: birthRaw } : {}),
      business_type: btKey, employment_type: empRaw,
      ...(wcRaw ? { workers_comp_type: wcRaw } : {}),
      bonuses,
    },
    fiscal_year: {
      year: fiscalYear,
      from: `${fiscalYear}-04-01`,
      to: `${fiscalYear + 1}-03-31`,
      basis: '健康保険法第45条(毎年四月一日から翌年三月三十一日までの累計額)',
    },
    monthly,
    bonuses: rows,
    annual: {
      gross: round2(monthly.gross * 12 + bonusGross),
      social_insurance_employee: round2(monthly.social_insurance_employee * 12 + bonusEmployee),
      social_insurance_employer: round2(monthly.social_insurance_employer * 12 + sum((x) => x.employer)),
      workers_compensation_employer:
        round2(monthly.workers_compensation_employer * 12 + sum((x) => x.workers_compensation_employer)),
      income_tax: round2(monthly.income_tax * 12),
      resident_tax: round2(monthly.resident_tax * 12),
      employer_cost: round2(monthly.employer_cost * 12 + bonusGross + bonusEmployer),
    },
    caps: {
      health_annual: HEALTH_ANNUAL_CAP,
      health_annual_used: ytd,
      health_annual_remaining: Math.max(0, HEALTH_ANNUAL_CAP - ytd),
      health_basis: '健康保険法第45条(標準賞与額の年度の累計額。千円未満切捨て)',
      pension_per_payment: PENSION_PER_PAYMENT_CAP,
      pension_basis: '厚生年金保険法第24条の4(一回あたり。千円未満切捨て。年度累計の定めは無い)',
    },
    notes: {
      why_not_multiplication:
        '年額は月次×12 + 賞与では出ません。健康保険の標準賞与額は年度の累計で573万円に達した' +
        '時点で以後の賞与に保険料がかからなくなり、厚生年金は1回150万円で切れます。' +
        '同じ賞与でも年度の何番目かで健保の結果が変わり、厚年は変わりません。',
      order: '賞与は渡された順に処理します。健康保険の枠は先に来た賞与から埋まります。',
      income_tax:
        '所得税は月次分を12倍しているだけで、賞与の源泉税と年末調整は含みません。' +
        '賞与の源泉税は GET /v1/bonus-tax、年末調整はこのAPIでは扱いません。',
      resident_tax: '住民税は渡された額をそのまま12倍します。前年の所得に対して市区町村が課すもので、ここでは算出しません。',
      workers_compensation:
        '労災保険は賃金総額にかかるので賞与にもかかります(徴収法第2条第2項)。' +
        'workers_comp_type を渡さなければ計上しません。',
    },
    attribution: { ...ATTRIBUTION, bonus: BONUS_INSURANCE_ATTRIBUTION },
  });
});

app.get('/v1/annual-leave', (c) => {
  const unknownQ = rejectUnknownQuery(c, [
    'hired_on', 'as_of', 'attendance_rate', 'weekly_days', 'weekly_hours',
    'annual_days', 'days_taken', 'include',
  ] as const);
  if (unknownQ) return unknownQ;

  const hiredRaw = c.req.query('hired_on');
  const hired = hiredRaw === undefined ? null : parseDate(hiredRaw);
  if (hiredRaw === undefined)
    return bad(c, '"hired_on" is required.',
      '雇入れの日。付与日は雇入れから6か月後で、以降1年ごとです (労働基準法第39条第1項)。',
      'missing_parameter');
  if (!hired) return bad(c, '"hired_on" must be a valid ISO date (YYYY-MM-DD).');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');
  if (asOf! < hired)
    return bad(c, '"as_of" is before "hired_on".',
      '判定日が雇入れの日より前です。');

  const num = (key: string, max?: number) => {
    const raw = c.req.query(key);
    if (raw === undefined) return { value: null as number | null, bad: false };
    const v = Number(raw);
    return { value: v, bad: !Number.isFinite(v) || v < 0 || (max !== undefined && v > max) };
  };
  const rate = num('attendance_rate', 1);
  const weeklyDays = num('weekly_days', 7);
  const weeklyHours = num('weekly_hours', 168);
  const annualDays = num('annual_days', 366);
  const taken = num('days_taken', 366);
  for (const [key, f] of [
    ['attendance_rate', rate], ['weekly_days', weeklyDays], ['weekly_hours', weeklyHours],
    ['annual_days', annualDays], ['days_taken', taken],
  ] as const)
    if (f.bad)
      return bad(c, `"${key}" is out of range.`,
        key === 'attendance_rate'
          ? '出勤率は0から1で渡してください。八割以上で付与が生じます (労働基準法第39条第1項)。'
          : undefined);

  const decision = judgeAnnualLeave({
    hired_on: hired, as_of: asOf!,
    attendance_rate: rate.value, weekly_days: weeklyDays.value,
    weekly_hours: weeklyHours.value, annual_days: annualDays.value,
    days_taken: taken.value,
  });

  return c.json({
    input: {
      hired_on: hiredRaw,
      as_of: (asOf ?? new Date()).toISOString().slice(0, 10),
      ...(rate.value !== null ? { attendance_rate: rate.value } : {}),
      ...(weeklyDays.value !== null ? { weekly_days: weeklyDays.value } : {}),
      ...(weeklyHours.value !== null ? { weekly_hours: weeklyHours.value } : {}),
      ...(annualDays.value !== null ? { annual_days: annualDays.value } : {}),
      ...(taken.value !== null ? { days_taken: taken.value } : {}),
    },
    ...decision,
    reference: {
      full_grant: FULL_GRANT,
      full_grant_service: ['6か月', '1年6か月', '2年6か月', '3年6か月', '4年6か月', '5年6か月', '6年6か月以上'],
      proportional_table: PROPORTIONAL_TABLE,
      attendance_threshold: ATTENDANCE_THRESHOLD,
    },
    notes: {
      twenty:
        '20日という上限は条文に書かれていません。第39条第1項の十労働日に、第2項の表が定める' +
        '六年以上の加算十労働日を足した結果です。',
      attendance:
        '出勤率の算定では、業務上の負傷による休業、産前産後休業、育児介護休業、および年次有給休暇を' +
        '取得した日は出勤したものとみなします。この判断は事業所ごとの事実によるため、' +
        'attendance_rate として算定済みの率を渡してください。',
      proportional:
        '比例付与は週の所定労働時間が30時間未満であることが前提です。30時間以上なら、' +
        '週の所定日数が少なくても通常付与になります。',
      five_day_duty:
        '年5日の時季指定義務は10労働日以上付与された労働者に生じ、付与日から1年以内が期限です。' +
        '労働者の請求や計画的付与で取得した日数は差し引きます。',
    },
    attribution: ANNUAL_LEAVE_ATTRIBUTION,
  });
});

app.get('/v1/worker-type', (c) => {
  const unknownQ = rejectUnknownQuery(c, [
    'weekly_hours', 'normal_weekly_hours', 'monthly_days', 'normal_monthly_days',
    'monthly_wage', 'is_student', 'workplace_insured_count', 'employment_months',
  ] as const);
  if (unknownQ) return unknownQ;

  const num = (key: string, { positive = false } = {}) => {
    const raw = c.req.query(key);
    if (raw === undefined) return { given: false, value: null as number | null, bad: false };
    const value = Number(raw);
    return { given: true, value, bad: !Number.isFinite(value) || value < 0 || (positive && value === 0) };
  };

  const weekly = num('weekly_hours');
  if (!weekly.given)
    return bad(c, '"weekly_hours" is required.',
      '1週間の所定労働時間。四分の三基準(健康保険法第3条第1項第9号本文)も20時間の要件も、まずこれで決まります。',
      'missing_parameter');

  const normalWeekly = num('normal_weekly_hours', { positive: true });
  const monthlyDays = num('monthly_days');
  const normalMonthlyDays = num('normal_monthly_days', { positive: true });
  const wage = num('monthly_wage');
  const headcount = num('workplace_insured_count');
  const months = num('employment_months');

  for (const [key, f] of [
    ['weekly_hours', weekly], ['normal_weekly_hours', normalWeekly],
    ['monthly_days', monthlyDays], ['normal_monthly_days', normalMonthlyDays],
    ['monthly_wage', wage], ['workplace_insured_count', headcount],
    ['employment_months', months],
  ] as const)
    if (f.bad)
      return bad(c, `"${key}" must be a non-negative number` +
        (key.startsWith('normal_') ? ' greater than zero.' : '.'));

  const studentRaw = c.req.query('is_student');
  if (studentRaw !== undefined && studentRaw !== 'true' && studentRaw !== 'false')
    return bad(c, '"is_student" must be true or false.');

  const decision = judgeWorkerType({
    weekly_hours: weekly.value!,
    normal_weekly_hours: normalWeekly.value,
    monthly_days: monthlyDays.value,
    normal_monthly_days: normalMonthlyDays.value,
    monthly_wage: wage.value,
    is_student: studentRaw === 'true',
    workplace_insured_count: headcount.value,
    employment_months: months.value,
  });

  return c.json({
    input: {
      weekly_hours: weekly.value,
      normal_weekly_hours: normalWeekly.value ?? 40,
      ...(monthlyDays.given ? { monthly_days: monthlyDays.value } : {}),
      ...(normalMonthlyDays.given ? { normal_monthly_days: normalMonthlyDays.value } : {}),
      ...(wage.given ? { monthly_wage: wage.value } : {}),
      is_student: studentRaw === 'true',
      ...(headcount.given ? { workplace_insured_count: headcount.value } : {}),
      ...(months.given ? { employment_months: months.value } : {}),
    },
    ...decision,
    notes: {
      wage_test:
        '88,000円の判定に算入しない賃金があります: ' + EXCLUDED_FROM_WAGE_TEST.join('、') +
        '。これらを足して判定すると、本来入らない人が入ります。時間外・休日・深夜の割増賃金も' +
        '残業代として除きます。',
      threshold_use:
        'payment_basis_threshold は GET /v1/standard-remuneration/regular と ' +
        'POST /v1/standard-remuneration/regular/batch の worker_type にそのまま渡せます。',
      headcount:
        '人数要件は段階的に下がります。写した数字は腐るので headcount_schedule を確認してください。',
      not_decidable:
        '「通常の労働者」が誰か、学生に当たるか(卒業見込み・夜間部の例外)は事業所ごとの事実で、' +
        'このAPIでは決められません。渡された値を条文の要件にあてはめた結果を返します。',
    },
    attribution: WORKER_TYPE_ATTRIBUTION,
  });
});

app.get('/v1/eligibility', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include', 'joined_on', 'left_on', 'month'] as const);
  if (unknownQ) return unknownQ;

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

/**
 * 割増賃金。毎月使う計算なのに無かったため、月次給与をこのAPIだけで回すことが
 * できなかった。
 */
const OVERTIME_PARAMS = [
  'base_monthly_pay', 'monthly_scheduled_hours', 'overtime_hours', 'night_hours',
  'holiday_hours', 'holiday_night_hours', 'round', 'include',
] as const;

app.get('/v1/overtime-pay', (c) => {
  const unknown = rejectUnknownQuery(c, OVERTIME_PARAMS);
  if (unknown) return unknown;

  const num = (name: string, required = false) => {
    const raw = c.req.query(name);
    if (raw === undefined) return required ? NaN : 0;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : NaN;
  };

  const base = num('base_monthly_pay', true);
  if (!Number.isFinite(base) || base <= 0)
    return bad(c, '"base_monthly_pay" is required and must be a positive number.',
      'The part of monthly pay that counts toward the premium base. 労働基準法施行規則第21条 lists ' +
      'the seven allowances that may be excluded, and only those — see excludable_allowances in the response.');

  const scheduled = num('monthly_scheduled_hours', true);
  if (!Number.isFinite(scheduled) || scheduled <= 0)
    return bad(c, '"monthly_scheduled_hours" is required and must be a positive number.',
      'Average scheduled hours per month: annual working days × daily hours ÷ 12. ' +
      'It varies by employer, so it cannot be assumed.');

  const hours = {
    overtime_hours: num('overtime_hours'),
    night_hours: num('night_hours'),
    holiday_hours: num('holiday_hours'),
    holiday_night_hours: num('holiday_night_hours'),
  };
  for (const [k, v] of Object.entries(hours))
    if (!Number.isFinite(v)) return bad(c, `"${k}" must be a non-negative number of hours.`);

  if (hours.night_hours > hours.overtime_hours + hours.holiday_hours + 744)
    return bad(c, '"night_hours" exceeds any plausible total.',
      'Night hours are hours that also fall between 22:00 and 05:00, not a separate block of work.');

  const roundRaw = c.req.query('round');
  if (roundRaw !== undefined && !['true', 'false'].includes(roundRaw))
    return bad(c, '"round" must be "true" or "false".');

  return c.json({
    ...overtimePay({
      base_monthly_pay: base,
      monthly_scheduled_hours: scheduled,
      ...hours,
      round: roundRaw !== 'false',
    }),
    attribution: OVERTIME_ATTRIBUTION,
  });
});

const BONUS_INSURANCE_PARAMS = [
  'prefecture', 'pref', 'bonus', 'fiscal_year_to_date', 'age', 'birth_date', 'as_of',
  'paid_on', 'left_on', 'leave_exempt', 'include',
] as const;

/**
 * 通勤手当の非課税限度額。
 *
 * 給与明細を丸ごと計算しないと限度額が分からないのは経路として長すぎる。
 * 「片道12キロなら月いくらまで非課税か」は単独で答えるべき問い。
 *
 * この表は12か月に2度動いている。令和7年11月19日公布の政令が10キロメートル以上の
 * 額を引き上げ、しかも**令和7年4月1日以後に支払われるべき通勤手当に遡って**適用された。
 * 続いて令和8年4月1日に65キロメートル以上の4区分と駐車場等の加算が新設された。
 * 一度写した表が腐るのはこういう形で起きる。
 */
app.get('/v1/commuting-allowance', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['amount', 'distance_km', 'fare', 'parking'] as const);
  if (unknownQ) return unknownQ;

  const num = (key: string) => {
    const raw = c.req.query(key);
    if (raw === undefined) return { raw, value: null as number | null, bad: false };
    const value = Number(raw);
    return { raw, value, bad: !Number.isFinite(value) || value < 0 };
  };

  const amount = num('amount');
  const km = num('distance_km');
  const fare = num('fare');
  const parking = num('parking');

  for (const [key, f] of [['amount', amount], ['distance_km', km], ['fare', fare], ['parking', parking]] as const)
    if (f.bad) return bad(c, `"${key}" must be a non-negative number.`);

  const reference = {
    transit: {
      ceiling: TRANSIT_CEILING,
      label_ja: '交通機関・有料道路の利用者',
      rule: '1か月当たりの合理的な運賃等の額。最高限度は月150,000円。',
    },
    vehicle: {
      label_ja: '交通用具(マイカー・自転車等)の利用者',
      rule: '片道の通勤距離で決まる。片道2キロメートル未満は全額課税。',
      bands: VEHICLE_BANDS,
    },
    parking: {
      cap: PARKING_CAP,
      label_ja: '駐車場等の利用料',
      rule: '交通用具通勤者が負担する駐車場等の利用料は、距離区分の額に月5,000円まで加算される。' +
        '片道2キロメートル未満の者には加算されない。令和8年4月1日以後に支払われるべき通勤手当から。',
    },
    combined: {
      rule: '交通機関と交通用具の併用は「距離区分の額 + 合理的な運賃等の額(+ 駐車場等の加算)」が限度で、' +
        '合計の最高限度は月150,000円。',
    },
  };

  const revisions = [
    {
      effective_from: '2025-04-01',
      promulgated: '2025-11-19',
      summary: '片道10キロメートル以上の各区分を引き上げ。公布は令和7年11月19日だが、' +
        '令和7年4月1日以後に支払われるべき通勤手当に遡って適用された。',
      caution: '令和7年中に月次で処理済みの給与は、年末調整で差額を精算する必要が生じた。',
    },
    {
      effective_from: '2026-04-01',
      summary: '片道65キロメートル以上に4区分(45,700 / 52,700 / 59,600 / 66,400)を新設。' +
        '駐車場等の利用料について月5,000円までの加算を新設。',
    },
  ];

  if (amount.raw === undefined) {
    if (km.raw !== undefined || fare.raw !== undefined || parking.raw !== undefined)
      return bad(c, 'distance_km, fare and parking only mean something alongside amount.',
        'Pass amount= the commuting allowance you actually pay, and the rest decides how much of it is non-taxable. With no parameters at all you get the whole table.',
        'missing_parameter');
    return c.json({ reference, revisions, attribution: COMMUTING_SOURCE });
  }

  if (parking.raw !== undefined && km.raw === undefined)
    return bad(c, 'parking is an addition to the distance band, so it needs distance_km.',
      'The parking addition exists only for a commute by car or bicycle. Someone travelling only by train has no distance band for it to be added to.',
      'missing_parameter');

  const split = commutingExemption({
    amount: amount.value!, distance_km: km.value, fare: fare.value, parking: parking.value,
  });

  return c.json({
    input: {
      amount: amount.value,
      ...(km.value !== null ? { distance_km: km.value } : {}),
      ...(fare.value !== null ? { fare: fare.value } : {}),
      ...(parking.value !== null ? { parking: parking.value } : {}),
    },
    non_taxable: split.non_taxable,
    taxable: split.taxable,
    limit: split.limit,
    band: split.band,
    parking_added: split.parking_added,
    basis: split.basis,
    social_insurance: {
      remuneration: amount.value,
      note: '社会保険では通勤手当の全額が報酬に算入される(健康保険法第3条第5項)。' +
        '非課税かどうかは所得税の話であって、標準報酬月額には影響しない。',
    },
    reference,
    revisions,
    attribution: COMMUTING_SOURCE,
  });
});

app.get('/v1/bonus-insurance', (c) => {
  const unknown = rejectUnknownQuery(c, BONUS_INSURANCE_PARAMS);
  if (unknown) return unknown;
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

  // 賞与にも同じ法理が働く。月次だけ直して賞与を残すと、片方だけ正しい状態になる。
  if (ageRaw === undefined && birthRaw === undefined)
    return bad(c, 'Either "age" or "birth_date" is required.', '介護保険法第9条 makes age the test itself: a 第2号被保険者 is someone 40 or over and under 65. Without it this endpoint would have to assume "under 40", which silently under-collects — 2,430 yen a month on a 300,000 yen salary in Tokyo. Pass age, or birth_date to have the 40, 65, 70 and 75 milestones applied to the exact day.',
      'missing_parameter');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '"as_of" must be a valid ISO date (YYYY-MM-DD).');

  // 資格喪失月の賞与、および休業中の賞与には保険料がかからない。以前はこれらを
  // 受け取っておらず、退職日を渡しても無視して満額を返していた。
  const paidRaw = c.req.query('paid_on');
  const paidOn = paidRaw === undefined ? null : parseDate(paidRaw);
  if (paidRaw !== undefined && !paidOn)
    return bad(c, '"paid_on" must be a valid ISO date (YYYY-MM-DD).',
      'The date the bonus was paid. Needed to tell whether it falls in the month eligibility was lost.');

  const leftRaw = c.req.query('left_on');
  const leftOn = leftRaw === undefined ? null : parseDate(leftRaw);
  if (leftRaw !== undefined && !leftOn)
    return bad(c, '"left_on" must be a valid ISO date (YYYY-MM-DD).',
      'The last day worked. Eligibility is lost the day after, so 30 and 31 March give opposite answers.');
  if (leftOn && !paidOn)
    return bad(c, '"left_on" needs "paid_on" as well.',
      'Whether the bonus is exempt depends on which month it was paid in, not only on when employment ended.');

  const leaveRaw = c.req.query('leave_exempt');
  if (leaveRaw !== undefined && !['true', 'false'].includes(leaveRaw))
    return bad(c, '"leave_exempt" must be "true" or "false".',
      'True when the bonus falls inside a 産前産後休業 or a 育児休業 exceeding one month. ' +
      'GET /v1/leave-exemption decides this from the leave dates.');

  const pref = insurance.prefectures[r.pref];
  return c.json({
    prefecture: r.pref, prefecture_ja: pref.prefecture_ja,
    ...bonusInsurance({
      prefecture: r.pref, bonus, fiscal_year_to_date: ytd,
      age, birth_date: birth, as_of: asOf!,
      paid_on: paidOn, left_on: leftOn, leave_exempt: leaveRaw === 'true',
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
  const unknownQ = rejectUnknownQuery(c, ['as_of', 'birth_date', 'include'] as const);
  if (unknownQ) return unknownQ;

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

const BONUS_TAX_PARAMS = [
  'bonus', 'bonus_insurance', 'previous_month_pay', 'previous_month_insurance',
  'column', 'dependants', 'include',
] as const;

app.get('/v1/bonus-tax', (c) => {
  const unknown = rejectUnknownQuery(c, BONUS_TAX_PARAMS);
  if (unknown) return unknown;

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
  // 賞与の源泉税は「賞与から社会保険料を控除した額」に率を乗じる。既定を0にすると
  // 課税標準が膨らんで税額が過大になる。独立した批評で、賞与50万・東京・40歳の例で
  // 3,063円の差が実測された。しかもこのパラメータはOpenAPIに載っていなかったので、
  // ドキュメントを読んだ人には存在すら分からなかった。
  //
  // 既定値を捨てて必須にする。金額を返すAPIで「渡さなければ黙って0」は、
  // 渡し忘れた人に間違った額を返し続けることを意味する。
  const bonusInsRaw = c.req.query('bonus_insurance');
  if (bonusInsRaw === undefined)
    return bad(c, '"bonus_insurance" is required.',
      'Withholding on a bonus is charged on the bonus *after* its own social insurance ' +
      '(所得税法第186条第2項). Defaulting it to zero inflates the tax — around 3,000 yen on a ' +
      '500,000 yen bonus. GET /v1/bonus-insurance computes the figure; pass 0 only if the ' +
      'employee genuinely pays no social insurance on it.');
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

app.get('/v1/enums', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
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
      { value: 'unknown_parameter', description: 'A query parameter this endpoint does not accept. Rejected rather than ignored, because a silently dropped parameter produces a plausible wrong figure.' },
      { value: 'out_of_coverage', description: 'Valid input, but outside the range this API publishes.' },
      { value: 'not_found', description: 'No such endpoint.' },
      { value: 'internal_error', description: 'Unexpected failure.' },
    ],
    prefectures: 'See GET /v1/prefectures for all 47.',
  }));
});
app.get('/v1/data-freshness', (c) => {
  const unknownQ = rejectUnknownQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
  c.json(freshnessReport(new Date())));
});
app.notFound((c) => c.json({ error: 'Not found', code: 'not_found', hint: 'See GET / for the endpoint list.' }, 404));
app.onError((e, c) => c.json({ error: 'Internal error', code: 'internal_error', detail: String(e?.message ?? e) }, 500));

export default app;
