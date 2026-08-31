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
import openapiGptSpec from './data/openapi-gpt.json';
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
import { landingPage, wantsHtml } from './landing';

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
  // 実測して書き直した箇所。同時20接続で1,200回投げると、429は6件しか返らない。
  // Cloudflareのレート制限は**拠点ごとに**数えるため、接続が散ると各拠点の計数も散る。
  // 「1分300回」と言い切ると、守られない約束をすることになる。
  // 確実に効くのは batch_rows のほうで、こちらは1件の差で拒否できる(10は通り11は落ちる)。
  enforcement:
    'requests_per_minute は目安です。Cloudflareの拠点ごとに数えるため、同時接続が多いと'
    + 'この数を超えて通ることがあります(実測: 同時20接続で1,200回中1,194回が通過)。'
    + '確実な境界は batch_rows のほうで、こちらは1件の差で拒否します。',
};

/**
 * 製品の中で買い手が「払うか」を考える瞬間は、ここ1箇所しかない。
 *
 * その文面に**値段が書いていなかった。**上限に当たった人は、リンクを踏んで
 * 出品ページを開き、Pricing タブを探して初めて4ドルだと知る。
 * 同じ場所に競合が19ドルで並んでいるので、金額を伏せる理由がない。
 * 「いくらか分からない」は、その場で離脱する理由になる。
 */
// RapidAPI の価格表に出ているボタンの名前そのもの。訳すと、リンクを踏んだ人が
// 着いた画面に「Pro」しかなく、言葉が一致しなくなる。だから英語のまま置く。
const PLAN_NAME = 'Pro';

const UPGRADE = {
  where: 'https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants',
  plan: PLAN_NAME,
  price_usd: 4,
  requests_per_month: 30000,
  what: '上限の引き上げと本来のサイズのバッチが使えます。課金・鍵・割当はそちら側で扱われます。',
  /** 上限に当たった人がその場で判断できるだけのことを、1文で言う。 */
  offer: (rows: number) =>
    `1回 ${rows} 人までのバッチは ${PLAN_NAME} プラン(月4ドル・月30,000回)で使えます: `
    + 'https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants',
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
  // 効いているかどうかを観測できるようにしておく。900回投げても429が出ないという
  // 状態が、設定漏れなのか判定漏れなのか、ログを見なければ切り分けられなかった。
  let rl: 'off' | 'skip' | 'pass' | 'block' = 'off';
  if (channel === 'rapidapi' || local) rl = 'skip';
  else if (!c.env?.FREE_TIER) rl = 'off';
  if (channel !== 'rapidapi' && !local && c.env?.FREE_TIER) {
    const key = c.req.header('cf-connecting-ip') ?? 'anonymous';
    const { success } = await c.env.FREE_TIER.limit({ key });
    rl = success ? 'pass' : 'block';
    if (!success)
      return c.json({
        error: `無料枠の上限に達しました。1分あたり ${FREE_TIER.requests_per_minute} 回が目安です。`,
        code: 'rate_limited',
        // ここも買い手が判断する瞬間なので、金額を伏せない。
        hint: `直接呼ぶ場合とMCP経由に適用されます。本番の量を扱うなら ${PLAN_NAME} プラン`
          + `(月${UPGRADE.price_usd}ドル・月${UPGRADE.requests_per_month.toLocaleString('en-US')}回)へ: `
          + UPGRADE.where + '。' + UPGRADE.what,
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
  // detail=compact — 毎回同じ文言を運ばずに済むようにする。
  //
  // 実測で、全GETの39%が attribution / notes / guidance / statutes だった。判定系ほど
  // 比率が高く、随時改定は88%が定型。出典を消すのではなく「要らない」と言えるように
  // する。既定は従来どおり全部返すので、いま繋いでいる利用者のレスポンスは変わらない。
  //
  // 消したことは黙らない。何を落としたか、どう取り戻すかを omitted に書く。
  // 出典が黙って消えると、数字の根拠を追えなくなる。
  // 綴り間違いで全部返ると、軽くしたつもりで軽くなっていない。
  const detailRaw = c.req.query('detail');
  if (detailRaw !== undefined && detailRaw !== 'compact' && detailRaw !== 'full'
      && c.res.status === 200) {
    c.res = new Response(JSON.stringify({
      error: `該当する detail がありません: 「${detailRaw}」`,
      code: 'invalid_request',
      hint: '毎回同じ内容のフィールドを省くなら「compact」、すべて返すなら「full」(既定)を指定してください。',
    }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    return;
  }

  if (c.req.query('detail') === 'compact' && c.res.status === 200) {
    const type = c.res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const body: any = await c.res.clone().json();
      const DROP = ['attribution', 'notes', 'guidance', 'statutes', 'notice',
                    'not_required_for', 'excludable_allowances', 'reference',
                    'headcount_schedule', 'revisions', 'idempotency'];
      const dropped = DROP.filter((k) => body[k] !== undefined);
      if (dropped.length) {
        for (const k of dropped) delete body[k];
        body.omitted = {
          fields: dropped,
          why: '毎回同じ内容なので省いています。数字と判定は省いていません。',
          how_to_get: 'detail を外すか detail=full を付けると、すべて返ります。',
        };
        c.res = new Response(JSON.stringify(body), {
          status: c.res.status,
          headers: c.res.headers,
        });
      }
    }
  }

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
      // off = バインディングが無い、skip = 課金経路かローカル、pass/block = 判定した
      rl,
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
function rejectBadQuery(c: any, allowed: readonly string[]) {
  // detail はどのエンドポイントでも受ける。個別の許可リストに足していく形にすると、
  // 定数で持っている4本を取りこぼしたように、次に足す人がまた漏らす。
  const seen = Object.keys(c.req.query());

  // 値が空のパラメータは、渡さなかったのとは違う。`?weekly_hours=` はテンプレートが
  // 空を吐いた跡で、`Number('')` は 0 になる。0時間として判定すれば「被保険者でない」
  // という**もっともらしい誤答**が返る。渡さないなら、パラメータごと外してもらう。
  const empty = seen.filter((k) => c.req.query(k) === '');
  if (empty.length)
    return bad(c,
      `値が空のクエリパラメータです: ${empty.map((k) => `「${k}」`).join('、')}`,
      '渡さないなら、そのパラメータごと外してください。空の値を0や既定値として扱うと、'
      + 'テンプレートが空を吐いたときに、エラーではなくもっともらしい誤答が返ります。',
      'empty_parameter');

  // detail と include はどのエンドポイントでも受ける。個別の許可リストに足していく形に
  // すると、定数で持っている4本を取りこぼしたときと同じことが起きる。実際 include は
  // 6本の許可リストから漏れており、仕様書に載せた途端そこだけ嘘になった。
  const unknown = seen.filter((k) => k !== 'detail' && k !== 'include' && !allowed.includes(k));
  if (!unknown.length) return null;
  const near = (k: string) =>
    allowed.find((a) => a.startsWith(k.slice(0, 4)) || k.startsWith(a.slice(0, 4)));
  return bad(c,
    `受け付けないクエリパラメータです: ${unknown.map((u) => `「${u}」`).join('、')}`,
    unknown.map((u) => {
      const s = near(u);
      return s ? `「${s}」の間違いではありませんか。` : null;
    }).filter(Boolean).join(' ') ||
      (allowed.length
        // POST は本文で受けるのでクエリを取らない。空の一覧をそのまま並べると
        // 「ここで受け付けるのは  です」という壊れた案内になる。
        ? `ここで受け付けるのは ${allowed.join('、')} です。黙って無視せず拒否しています。`
        : 'このエンドポイントがクエリで受けるのは detail だけです。ほかは本文(JSON)で渡してください。') +
      '黙って捨てられたパラメータは、もっともらしい誤った数字を生むためです。',
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
    error: `${iso} 時点の${set === 'social_insurance' ? '社会保険' : set === 'employment_insurance' ? '雇用保険' : '労災保険'}料率は公表されていません。`,
    code: 'out_of_coverage',
    coverage: { from: w.from, through: w.through, table: w.label },
    hint: iso < w.from
      ? `このAPIが持っている料率表は1つだけです — ${w.label}。${w.note} ` +
        '過去の日付に現行の料率を返せば、もっともらしい誤った数字になるため、返さずに拒否します。'
      : `${w.note} ${iso} 時点の料率はまだ公表されていません。出典が公表し次第ここに載ります。`,
  }, 422);
}

/**
 * Errors carry a stable `code` alongside the prose. Integrators need to branch on
 * "the caller sent something wrong" versus "the date is outside what we publish",
 * and matching on English sentences breaks the moment the wording improves.
 */
const bad = (c: any, message: string, hint?: string, code = 'invalid_request') =>
  c.json({ error: message, code, ...(hint ? { hint } : {}) }, 400);

/**
 * 生年月日が、年齢として意味のある範囲にあるか。
 *
 * `age` は 0〜120 で弾いていたのに、**同じことを意味する `birth_date` は形式しか
 * 見ていなかった。**`birth_date=2099-01-01` は 200 を返し、給与明細を組み立て、
 * `/v1/age-milestones` は `age: -73` と答えたうえで健康保険と厚生年金を
 * 「加入」と判定していた。1999 を 2099 と打ち間違えれば、それらしい明細が出る。
 *
 * 片方だけ厳しい検証は、緩いほうから入られる。同じ範囲に揃える。
 */
const badBirthDate = (c: any, birth: Date | null): any => {
  if (!birth) return null;
  // 基準日は as_of。過去の給与を組み直す人がいるので、「今日」で判定すると
  // 正しい呼び出しを弾く。as_of は各ハンドラでこの検査より後に読まれるので、
  // ここで自分で読む。壊れた as_of は、それぞれのハンドラが別途弾く。
  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw ? parseDate(asOfRaw) : null;
  const ref = asOf ?? new Date();
  if (birth.getTime() > ref.getTime())
    return bad(c, '「birth_date」が未来の日付です。',
      `${birth.toISOString().slice(0, 10)} は基準日 ${ref.toISOString().slice(0, 10)} より後です。` +
      '年号の打ち間違い(1999 を 2099 など)でよく起きます。' +
      'age は0から120で受けているので、生年月日も同じ範囲でしか受けません。');
  const years = (ref.getTime() - birth.getTime()) / (365.2425 * 24 * 3600 * 1000);
  if (years > 120)
    return bad(c, '「birth_date」が古すぎます。',
      `基準日時点で ${Math.floor(years)} 歳になります。age は0から120で受けています。`);
  return null;
};

const needPref = (c: any) => {
  const raw = c.req.query('prefecture') ?? c.req.query('pref');
  const pref = resolvePrefecture(raw ?? null);
  if (!pref) {
    // 接尾辞だけが違うなら、正しい形を示す。「大阪県」と書いた人が知りたいのは
    // 「そんな県は無い」ではなく「大阪府と書けばよい」のほう。
    const meant = suggestPrefecture(raw ?? null);
    return {
      err: bad(c, raw ? `該当する都道府県がありません: 「${raw}」` : '必須のクエリパラメータ prefecture がありません',
        meant
          ? `「${meant}」の間違いではありませんか。都道府県の接尾辞は1つしか正しくありません — 都は東京、道は北海道、府は京都と大阪、残る43が県です。`
          : '英語名(「Tokyo」)、日本語(「東京」「東京都」)、JISコード1〜47のいずれかで渡してください。一覧は GET /v1/prefectures です。',
        raw ? 'unknown_prefecture' : 'missing_parameter'),
    };
  }
  return { pref };
};

/**
 * 検索の入口。
 *
 * robots.txt は Cloudflare の既定(content-signals のコメントだけ)が出ていて、
 * 指示が1行も無く Sitemap も無かった。妨げてはいないが案内もしていない。
 */
app.get('/robots.txt', (c) => {
  c.header('Content-Type', 'text/plain; charset=utf-8');
  return c.body([
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${new URL('/sitemap.xml', c.req.url).toString()}`,
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', (c) => {
  const origin = new URL(c.req.url).origin;
  const paths = ['/', '/openapi.json', '/v1/data-freshness'];
  c.header('Content-Type', 'application/xml; charset=utf-8');
  return c.body(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    paths.map((p) => `<url><loc>${origin}${p}</loc></url>`).join('') +
    '</urlset>');
});

app.get('/favicon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="12" fill="#0b5cd5"/>' +
    '<text x="32" y="45" font-size="38" text-anchor="middle" fill="#fff" ' +
    'font-family="system-ui,sans-serif">給</text></svg>');
});

app.get('/', (c) => {
  const unknownQ = rejectBadQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;

  // ここは記事もREADMEも出品も指している着地点なのに、ブラウザで開くと
  // 9,772バイトの生JSONが出ていた。人が見て製品だと分からない。
  // **Accept を見て出し分ける。**curl の既定は Accept: */* なので JSON のまま。
  if (wantsHtml(c.req.header('accept'))) {
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(landingPage());
  }

  return c.json({
    name: '日本の給与・労務データAPI',
    description:
      '日本の給与・社会保険・労働法の公表データを1つのAPIに。47都道府県の社会保険料率と雇用保険料率、50等級の標準報酬月額表、24年分の最低賃金、祝日と営業日計算、1989年以降の消費税率、法人番号とインボイス登録番号の検査。すべて政府の公開データから機械的に抽出し、公表されている数字と突き合わせて確認しています。',
    version: '2.10.0',
    endpoints: {
      'GET /v1/prefectures': '47都道府県。JISコードと日本語名つき',
      'GET /v1/insurance-rates?prefecture=Tokyo': '健康保険・介護保険・厚生年金・子ども子育て拠出金の料率',
      'GET /v1/standard-remuneration?remuneration=350000': '標準報酬月額の等級照会',
      'GET /v1/standard-remuneration/table': 'Full 50-grade table',
      'GET /v1/employment-insurance?business_type=general': '事業の種類ごとの雇用保険料率',
      'GET /v1/minimum-wage?prefecture=Tokyo&date=2020-01-01': 'その日に効力を持つ最低賃金',
      'GET /v1/minimum-wage/history?prefecture=Tokyo': '平成14年度以降の全履歴',
      'GET /v1/payroll?prefecture=Tokyo&monthly_salary=350000&age=40&dependants=2': '月次の給与明細。社会保険料・源泉所得税・手取りを1回で',
      'GET /v1/holidays?year=2026': '1年分の祝日(from=&to= で範囲指定も可)',
      'GET /v1/holidays/check?date=2026-01-01': 'その日が祝日・週末・営業日のどれかを判定する',
      'GET /v1/business-days?from=2026-01-01&to=2026-03-31': '範囲内の営業日数を数える',
      'GET /v1/business-days/shift?date=2026-01-01&days=1': 'N営業日ぶん前後に動かす',
      'calendar=bank': '営業日系のエンドポイントに &calendar=bank を付けると銀行の休日(銀行法施行令第5条)になります。12月31日から1月3日も休みです',
      'GET /v1/consumption-tax?date=2015-01-01&amount=1000': 'その時点で有効な消費税率。金額を渡せば適用した額も返す',
      'GET /v1/consumption-tax/history': '1989年以降のすべての税率改定',
      'GET /v1/corporate-number/validate?number=8700110005901': '法人番号のチェックディジットを検査する(Peppol ICD 0188)',
      'GET /v1/corporate-number/check-digit?base=700110005901': '12桁の基礎番号からチェックディジットを計算する',
      'GET /v1/invoice-number/validate?number=T8700110005901': '適格請求書発行事業者の登録番号を検査する',
      'POST /v1/invoice-number/validate/batch': '登録番号をまとめて形式検査 — 分かるのは形式だけで、登録・取消・失効は国税庁の公表サイトでしか分からない',
      'GET /v1/withholding-tax?taxable_amount=300000&dependants=2': '源泉徴収税額表(月額表)による所得税',
      'GET /v1/withholding-tax/daily?taxable_amount=12000&column=hei': '日額表による源泉所得税。丙欄を含む',
      'GET /v1/withholding-tax/computer?taxable_amount=300000&dependants=2': '同じ税額を電算機計算の特例で求める',
      'POST /v1/payroll/batch': `1回の呼び出しで最大 ${MAX_BATCH} 人分の給与明細と合計を返します(無料枠は1回 ${FREE_TIER.batch_rows} 人まで)`,
      'GET /v1/leave-exemption?kind=childcare&start=2026-03-15&end=2026-03-28': '産休・育休がどの月の社会保険料を免除するか',
      'GET /v1/national-insurance?months=12': '国民年金は全国一律なので額を返す。国民健康保険は市町村の条例なので全国一律の額が存在せず、返さない理由を返す',
      'GET /v1/annual-cost?prefecture=Tokyo&monthly_salary=400000&age=40&bonuses=800000,800000': '年間の労務コスト — 健保の賞与上限は年度累計573万、厚年は1回150万なので、月次×12では出ない',
      'GET /v1/annual-leave?hired_on=2020-04-01&attendance_rate=0.9': '年次有給休暇の付与日数と年5日の時季指定義務 — 勤続で10→20日、週30時間未満は比例付与 (労基法39条)',
      'GET /v1/worker-type?weekly_hours=25&monthly_wage=100000&workplace_insured_count=51&employment_months=12': '被保険者区分の判定 — 四分の三基準と20時間/88,000円/学生/51人。誤ると定時決定の支払基礎日数が17日と11日で入れ替わる',
      'GET /v1/eligibility?month=2026-03&left_on=2026-03-30': '入社月・退職月に社会保険料がかかるかどうか',
      'GET /v1/age-milestones?birth_date=1986-04-01': '40歳・65歳・70歳・75歳の到達日と、それぞれ何が変わるか',
      'GET /v1/bonus-insurance?prefecture=Tokyo&bonus=800000&age=40': '賞与の社会保険料。年度累計と1回あたりの上限つき',
      'GET /v1/bonus-tax?bonus=500000&previous_month_pay=350000&previous_month_insurance=55750&dependants=2': '賞与にかかる源泉所得税(賞与の算出率表)',
      'GET /v1/overtime-pay?base_monthly_pay=300000&monthly_scheduled_hours=160&overtime_hours=20&night_hours=5': '割増賃金 — 時間外25%、月60時間超50%、法定休日35%、深夜はこれに25%上乗せ(労基法37条)',
      'GET /v1/workers-compensation?business_type=98&wage_total=3600000': '労災保険料 — 全額が事業主負担。率は事業の種類によって1,000分の2.5から88まで開く',
      'GET /v1/commuting-allowance?amount=12000&distance_km=12&parking=3000': '通勤手当の非課税限度額 — 社会保険は全額を報酬に算入し、所得税は限度額を超えた分にだけかかる。この表は12か月で2度、うち1度は遡って改定された',
      'GET /v1/standard-remuneration/revision?current_remuneration=300000&months=350000:31,352000:30,349000:31&fixed_pay_change=increase': '随時改定(月額変更)に当たるかを判定する。健康保険と厚生年金を別々に見る',
      'GET /v1/standard-remuneration/regular?months=350000:30,352000:31,349000:30': '4〜6月の給与から定時決定(算定基礎)を求める',
      'GET /v1/standard-remuneration/leave-end?kind=childcare&current_remuneration=300000&months=260000:31,258000:30,262000:31': '産休・育休からの復帰時の改定(1等級差で足りる)',
      'POST /v1/standard-remuneration/regular/batch': '算定基礎届を全従業員まとめて1回で。6月は全員が一斉に決まる唯一の月です(健保法41条)',
      'POST /v1/standard-remuneration/annual-average': '季節的な業務 — どちらの決定でも年間平均による保険者算定を使う',
      'GET /v1/statute?ref=健康保険法第43条': 'このAPIが引用している条項の全文。健保法43条や厚年法81条の2のような略称も解決します',
      'GET /v1/statute/index': '収録しているすべての条項と、その法令',
      'include=statute_text': 'どのエンドポイントにも付けられます。引用した条項の本文が添えられます',
      'GET /v1/enums': '受け付けるすべての列挙値とエラーコード。作るときに読むための参照',
      'GET /openapi.json?profile=gpt': 'Custom GPT Actions の30オペレーション上限に収めた仕様書。落とした14本は info.description に理由ごと記載',
      'GET /v1/data-freshness': '各データが何を収録していて、次にいつ変わるか',
    },
    free_tier: {
      ...FREE_TIER,
      applies_to: '直接呼ぶ場合とMCP経由、およびRapidAPIの無料BASICプランに適用されます。RapidAPIの有料プランはRapidAPI側で計測されます。',
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
  const unknownQ = rejectBadQuery(c, ['include', 'ref'] as const);
  if (unknownQ) return unknownQ;

  const ref = c.req.query('ref');
  if (!ref)
    return bad(c, '「ref」は必須です。',
      '「健康保険法第43条」のような条項の指定です。収録されている条項は GET /v1/statute/index で一覧できます。' +
      '略称(健保法43条)や項単位の指定(第43条第1項)も、その条に解決します。');

  const detail = statuteDetail(ref);
  if (!detail)
    return bad(c, `「${ref}」の条文は収録されていません。`,
      'このAPIが実際に引用している条項だけを収録しています。GET /v1/statute/index を参照してください。' +
      'ここに無い条文は e-Gov 法令検索に全文があります: https://laws.e-gov.go.jp/',
      'out_of_coverage');

  return c.json({ ...detail, attribution: STATUTE_ATTRIBUTION });
});

app.get('/v1/statute/index', (c) => {
  const unknownQ = rejectBadQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
  c.json({
    count: STATUTE_INDEX.length,
    laws: STATUTE_LAWS,
    provisions: STATUTE_INDEX,
    note:
      'このAPIが引用している条項をすべて、本文つきで並べています。判定エンドポイントに '
      + '?include=statute_text を付けると、答えに本文が添えられます。',
    attribution: STATUTE_ATTRIBUTION,
  }));
});
/**
 * OpenAPI 仕様書。
 *
 * `?profile=gpt` で絞った版を返す。Custom GPT Actions には **最大30オペレーション**
 * という上限があり、超えると読み込み自体が失敗する。いま44あるので、そのままでは
 * この配布経路がまるごと使えない。絞った版では会話で呼ばれないもの — 一覧・バルク・
 * ビルド時の参照・同じ数字の別解法 — を落としてある。何を落としたかは info.description
 * に理由ごと書いてあるので、探した人が「無い」ではなく「なぜ無いか」に辿り着ける。
 */
app.get('/openapi.json', (c) => {
  const unknownQ = rejectBadQuery(c, ['profile', 'include'] as const);
  if (unknownQ) return unknownQ;

  const profile = c.req.query('profile');
  if (profile !== undefined && profile !== 'gpt' && profile !== 'full')
    return bad(c, `該当する profile がありません: 「${profile}」`,
      'Custom GPT Actions の30オペレーション上限に収めた仕様書は「gpt」を指定してください。省略すると全エンドポイントを収めた仕様書になります。');

  c.header('Content-Type', 'application/json; charset=utf-8');
  return c.body(JSON.stringify(profile === 'gpt' ? openapiGptSpec : openapiSpec));
});

app.get('/v1/prefectures', (c) => {
  const unknownQ = rejectBadQuery(c, ['include'] as const);
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
  const unknownQ = rejectBadQuery(c, ['prefecture', 'pref', 'as_of'] as const);
  if (unknownQ) return unknownQ;
  const r = needPref(c); if ('err' in r) return r.err;

  const asOfRaw = c.req.query('as_of');
  if (asOfRaw !== undefined && !parseDate(asOfRaw))
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');
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
      split: '健康保険・介護保険・厚生年金・子ども子育て拠出金は、従業員と事業主で折半します。',
      long_term_care: '介護保険料がかかるのは40歳以上65歳未満(介護保険第2号被保険者)だけです。',
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
  const unknownQ = rejectBadQuery(c, ['include'] as const);
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
  const unknownQ = rejectBadQuery(c, ['include', 'remuneration'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('remuneration') ?? c.req.query('monthly_salary');
  const rem = Number(raw);
  if (!raw || !Number.isFinite(rem) || rem < 0)
    return bad(c, 'クエリパラメータ「remuneration」は0以上の数(月額の円)で渡してください。');
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
  const unknownQ = rejectBadQuery(c, ['business_type', 'as_of'] as const);
  if (unknownQ) return unknownQ;
  const t = (c.req.query('business_type') ?? 'general').toLowerCase();
  const bt = (empins.business_types as any)[t];
  if (!bt)
    return bad(c, `該当する business_type がありません: 「${t}」`,
      `次のいずれかです: ${Object.keys(empins.business_types).join(', ')}`);

  const asOfRaw = c.req.query('as_of');
  if (asOfRaw !== undefined && !parseDate(asOfRaw))
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');
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
    error: `${iso} 時点で効力を持つ最低賃金は、このデータセットに収録されていません。`,
    code: 'out_of_coverage',
    coverage: {
      through: newest, covers: d.covers, next_revision_expected: due,
      // 断るだけでは、利用者は自分で調べ直すことになる。改定の進み具合は
      // freshness.json が持っているので、そのまま渡す。新しい事実は足さない —
      // ここに数字を書けば、その数字自身が古びる。
      // status と残り日数は freshnessReport が計算している。同じ計算を書き直すと
      // 片方だけ直した状態が生まれるので、そちらの結果を引く。
      ...(() => {
        const row = freshnessReport(new Date()).datasets.find((x) => x.key === 'minimum_wage');
        return row
          ? {
            status: row.status,
            ...(row.days_until_revision !== undefined && row.days_until_revision !== null
              ? { days_until_revision: row.days_until_revision } : {}),
            ...((row as any).note ? { revision_status: (row as any).note } : {}),
          }
          : {};
      })(),
    },
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
  const unknownQ = rejectBadQuery(c, ['date', 'include', 'pref', 'prefecture'] as const);
  if (unknownQ) return unknownQ;

  const r = needPref(c); if ('err' in r) return r.err;
  const date = c.req.query('date') ?? null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return bad(c, 'クエリパラメータ「date」はYYYY-MM-DD形式で渡してください。');

  // 日付を渡さない既定は「今日」。今日が改定日を越えていれば同じ扱いにする。
  const asked = date ?? new Date().toISOString().slice(0, 10);
  const beyond = minimumWageBeyondData(c, asked);
  if (beyond) return beyond;

  const row = minimumWageAt(r.pref, date);
  if (!row)
    return c.json({
      error: `${date} 以前の ${r.pref} の最低賃金は収録されていません。`,
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
  const unknownQ = rejectBadQuery(c, ['include', 'pref', 'prefecture'] as const);
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
  const unknown = rejectBadQuery(c, PAYROLL_PARAMS);
  if (unknown) return unknown;

  const r = needPref(c); if ('err' in r) return r.err;

  const salaryRaw = c.req.query('monthly_salary');
  const salary = Number(salaryRaw);
  if (!salaryRaw || !Number.isFinite(salary) || salary < 0)
    return bad(c, 'クエリパラメータ「monthly_salary」は必須で、0以上の数(円)で渡してください。');

  const ageRaw = c.req.query('age');
  const age = ageRaw === undefined ? null : Number(ageRaw);
  if (ageRaw !== undefined && (!Number.isFinite(age!) || age! < 0 || age! > 120))
    return bad(c, 'クエリパラメータ「age」は0から120の数で渡してください。');

  const btKey = (c.req.query('business_type') ?? 'general').toLowerCase();
  if (!(empins.business_types as any)[btKey])
    return bad(c, `該当する business_type がありません: 「${btKey}」`,
      `次のいずれかです: ${Object.keys(empins.business_types).join(', ')}`);

  // 源泉所得税まで通すかどうか。既定で通す — 課税対象額は「社会保険料等控除後の
  // 給与等の金額」であって総支給額ではなく、そこを呼び出し側に計算させるのが
  // この種の実装で最も多い誤りだから。
  const taxRaw = (c.req.query('income_tax') ?? 'true').toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(taxRaw))
    return bad(c, `「income_tax」は真偽値で渡してください。渡されたのは「${taxRaw}」でした。`);
  const withTax = ['true', '1', 'yes'].includes(taxRaw);

  const colRaw = (c.req.query('column') ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return bad(c, `該当する column がありません: 「${colRaw}」`,
      '扶養控除等申告書が提出されていれば「kou」(甲欄)、されていなければ「otsu」(乙欄)です。');

  const depRaw = c.req.query('dependants') ?? '0';
  const dependants = Number(depRaw);
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '「dependants」は0から50の整数で渡してください。');

  const residentRaw = c.req.query('resident_tax') ?? '0';
  const residentTax = Number(residentRaw);
  if (!Number.isFinite(residentTax) || residentTax < 0)
    return bad(c, '「resident_tax」は0以上の数で渡してください。',
      '住民税は市区町村が課して事業主に通知するもので、このAPIでは算出できません。渡された額を差し引くことはします。');

  const birthRaw = c.req.query('birth_date');
  const birth = birthRaw === undefined ? null : parseDate(birthRaw);
  if (birthRaw !== undefined && !birth)
    return bad(c, '「birth_date」はYYYY-MM-DD形式の日付で渡してください。',
      '生年月日を渡すと、40歳・65歳・70歳・75歳の到達日を正確に当てはめます。');
  { const e = badBirthDate(c, birth); if (e) return e; }

  // 年齢は「あると精度が上がる」ものではなく、徴収するかどうかを決める要件そのもの。
  // 渡さなければ介護保険なしで計算して200を返していたが、それは「40歳未満」という
  // 仮定を黙って置くことで、40〜64歳なら必ず過少になる。非専門の利用者ほど
  // 年齢が要ることを知らないので、いちばん間違えやすい人が黙って間違える。
  if (ageRaw === undefined && birthRaw === undefined)
    return bad(c, '「age」か「birth_date」のどちらかが必要です。', '介護保険法第9条は年齢そのものを基準にしています。第2号被保険者は40歳以上65歳未満です。年齢が無ければこのエンドポイントは「40歳未満」と仮定するほかなく、黙って徴収不足になります。東京で月給30万円なら月2,430円です。age を渡すか、birth_date を渡して40歳・65歳・70歳・75歳の到達日を正確に当てはめてください。',
      'missing_parameter');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');
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
    return bad(c, '「standard_remuneration」は正の数で渡してください。',
      '算定基礎届または月額変更届で決まっている標準報酬月額です。分かっているなら必ず渡してください。'
      + '渡さないと、送られた支給額から等級を引き直すことになり、残業のある月は必ず誤ります。'
      + 'GET /v1/standard-remuneration/regular が決定します。');

  const empRaw = c.req.query('employment_type');
  const EMPLOYMENT_TYPES = ['employee', 'director', 'director_employee'] as const;
  if (empRaw !== undefined && !(EMPLOYMENT_TYPES as readonly string[]).includes(empRaw))
    return bad(c, `該当する employment_type がありません: 「${empRaw}」`,
      '「employee」「director」(役員 — 雇用保険の適用外、雇用保険法第4条)、' +
      'または「director_employee」(兼務役員 — 従業員としての実態があれば適用)のいずれかです。既定は employee です。');
  const empType = (empRaw ?? 'employee') as 'employee' | 'director' | 'director_employee';

  // 通勤手当。社会保険では報酬に含み、所得税では非課税限度額まで課さない。
  // 距離を渡せば交通用具の距離区分表、渡さなければ交通機関として月15万円が限度。
  const commRaw = c.req.query('commuting_allowance');
  const commuting = commRaw === undefined ? null : Number(commRaw);
  if (commRaw !== undefined && (!Number.isFinite(commuting!) || commuting! < 0))
    return bad(c, '「commuting_allowance」は0以上の数(月あたりの円)で渡してください。');

  const kmRaw = c.req.query('commuting_distance_km');
  const km = kmRaw === undefined ? null : Number(kmRaw);
  if (kmRaw !== undefined && (!Number.isFinite(km!) || km! < 0))
    return bad(c, '「commuting_distance_km」は0以上の数(片道キロメートル)で渡してください。',
      '車や自転車で通う人に渡してください。非課税限度額が、150,000円の交通機関の上限ではなく距離の表(国税庁 No.2585)から決まります。');

  const fareRaw = c.req.query('commuting_fare');
  const fare = fareRaw === undefined ? null : Number(fareRaw);
  if (fareRaw !== undefined && (!Number.isFinite(fare!) || fare! < 0))
    return bad(c, '「commuting_fare」は0以上の数(月あたりの円)で渡してください。',
      '交通用具通勤に加えて支払う合理的な運賃・有料道路料金です。commuting_distance_km と併せると、距離区分の額に運賃を足した額が限度額になり、150,000円で頭打ちです。');

  // 駐車場等の利用料は距離区分の額への「加算」なので、距離が無ければ成り立たない。
  const parkRaw = c.req.query('commuting_parking');
  const parking = parkRaw === undefined ? null : Number(parkRaw);
  if (parkRaw !== undefined && (!Number.isFinite(parking!) || parking! < 0))
    return bad(c, '「commuting_parking」は0以上の数(月あたりの円)で渡してください。',
      '交通用具通勤で本人が負担する駐車場代です。距離区分の額に、月5,000円を上限として加算されます。');

  if (commRaw === undefined && (kmRaw !== undefined || fareRaw !== undefined || parkRaw !== undefined))
    return bad(c, 'commuting_distance_km・commuting_fare・commuting_parking は commuting_allowance と一緒でなければ意味を持ちません。',
      '実際に支払っている手当を渡してください。距離・運賃・駐車場代が、そのうち非課税になる額を決めます。',
      'missing_parameter');

  if (parkRaw !== undefined && kmRaw === undefined)
    return bad(c, 'commuting_parking は距離区分の額への加算なので、commuting_distance_km が必要です。',
      '駐車場代の加算は交通用具通勤の制度です。交通機関だけで通う人には、加算する距離区分がありません。',
      'missing_parameter');

  // 労災保険は全額事業主負担。事業の種類ごとに率が35倍開くので既定値は置かない。
  const wcRaw = c.req.query('workers_comp_type');
  if (wcRaw !== undefined && !workersCompType(wcRaw))
    return bad(c, `該当する workers_comp_type がありません: 「${wcRaw}」`,
      'GET /v1/workers-compensation の事業の種類の番号を使ってください。例えば卸売業・小売業、飲食店又は宿泊業は98です。',
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
        note: '社会保険料を引いたあとの額にかかります。総支給額にかかるのではありません。',
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
      basis: '社会保険料は標準報酬月額にかかります。雇用保険料と源泉所得税は実際の支給額にかかります。',
      income_tax: withTax
        ? '源泉所得税は社会保険料控除後の額から計算します。その控除はこのエンドポイントが行うので、総支給額を渡してください。income_tax=false を渡せば計算しません。'
        : '源泉所得税を出していません。含めるには income_tax=true を渡してください。',
      workers_compensation: wcRaw !== undefined
        ? '労災保険料は全額が事業主負担で、totals.employer_cost に含まれます。'
        : '労災保険は workers_comp_type を渡さないかぎり含みません。率は業種によって1,000分の2.5から88まで開くため、安全な既定値がありません。渡すまでは totals.employer_cost がその分だけ不足します。',
      resident_tax: residentTax
        ? '住民税は渡された額です。ここでは算出しません。'
        : '住民税は市区町村が課すもので、ここでは算出しません。resident_tax= を渡せば差し引きます。',
      batch: 'POST /v1/payroll/batch は多人数をまとめて処理し、支給項目を名前つきの配列で受け取ります。',
      commuting: commuting !== null
        ? '通勤手当は社会保険では全額が報酬に入りますが、所得税は非課税限度額を超えた分にだけかかります。earnings.items にその内訳が入ります。'
        : 'commuting_allowance を渡すと、その手当を社会保険の報酬に算入したうえで、法定の限度額まで所得税を非課税として扱います。',
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
  note: '振替休日と国民の休日は、内閣府の公表では区別されず「休日」の一語で記録されています。substitute のフラグでその2つを示します。',
};

/** ?calendar=standard|bank — bank adds 12/31-1/3 per 銀行法施行令第5条. */
const readCalendar = (c: any): Calendar | null => {
  const raw = (c.req.query('calendar') ?? 'standard').toLowerCase();
  return raw === 'standard' || raw === 'bank' ? raw : null;
};
const badCalendar = (c: any) =>
  bad(c, `該当する calendar がありません: 「${c.req.query('calendar')}」`, '「standard」か「bank」を使ってください。');

const outOfCoverage = (c: any, iso: string) =>
  c.json({
    error: `${iso} は公表されている範囲の外です。`,
    code: 'out_of_coverage',
    coverage: COVERAGE,
    hint: '内閣府が公表しているのはこの範囲だけです。先の年は毎年2月に追加されます。',
  }, 422);

app.get('/v1/holidays', (c) => {
  const unknownQ = rejectBadQuery(c, ['from', 'include', 'to', 'year'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('year');
  const from = c.req.query('from');
  const to = c.req.query('to');

  if (from || to) {
    if (!from || !to) return bad(c, '範囲で問い合わせるときは「from」と「to」の両方が必要です。');
    if (!parseISO(from) || !parseISO(to)) return bad(c, '「from」と「to」はYYYY-MM-DD形式の日付で渡してください。');
    if (from > to) return bad(c, '「from」は「to」より後にできません。');
    if (!inCoverage(from)) return outOfCoverage(c, from);
    if (!inCoverage(to)) return outOfCoverage(c, to);
    const list = holidaysBetween(from, to);
    return c.json({ from, to, count: list.length, holidays: list, attribution: HOLIDAY_ATTRIBUTION });
  }

  const year = Number(raw);
  if (!raw || !Number.isInteger(year))
    return bad(c, 'クエリパラメータ「year」は必須です。', '期間で取るなら from= と to= を使ってください。');
  if (year < HOLIDAY_META.year_from || year > HOLIDAY_META.year_to)
    return outOfCoverage(c, String(year));
  const list = holidaysInYear(year);
  return c.json({ year, count: list.length, holidays: list, attribution: HOLIDAY_ATTRIBUTION });
});

app.get('/v1/holidays/check', (c) => {
  const unknownQ = rejectBadQuery(c, ['calendar', 'date', 'include'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('date');
  const d = parseISO(raw);
  if (!d) return bad(c, 'クエリパラメータ「date」は必須で、YYYY-MM-DD形式の日付で渡してください。');
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
  const unknownQ = rejectBadQuery(c, ['calendar', 'end', 'from', 'include', 'start', 'to'] as const);
  if (unknownQ) return unknownQ;

  const from = c.req.query('from') ?? c.req.query('start');
  const to = c.req.query('to') ?? c.req.query('end');
  const a = parseISO(from);
  const b = parseISO(to);
  if (!a || !b) return bad(c, '「from」と「to」は必須で、YYYY-MM-DD形式の日付で渡してください。');
  if (from! > to!) return bad(c, '「from」は「to」より後にできません。');
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
  const unknownQ = rejectBadQuery(c, ['calendar', 'date', 'days', 'include'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('date');
  const d = parseISO(raw);
  if (!d) return bad(c, 'クエリパラメータ「date」は必須で、YYYY-MM-DD形式の日付で渡してください。');
  if (!inCoverage(toISO(d))) return outOfCoverage(c, toISO(d));
  const nRaw = c.req.query('days') ?? '1';
  const n = Number(nRaw);
  if (!Number.isInteger(n) || Math.abs(n) > 10_000)
    return bad(c, '「days」は-10000から10000の整数で渡してください。',
      '正の数で先へ、負の数で前へ動きます。1 は翌営業日です。');
  const cal = readCalendar(c);
  if (!cal) return badCalendar(c);
  const result = shiftBusinessDays(d, n, cal);
  if (!result) return outOfCoverage(c, '計算後の日付');
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
  const unknownQ = rejectBadQuery(c, ['amount', 'date', 'include', 'reduced'] as const);
  if (unknownQ) return unknownQ;

  const dateRaw = c.req.query('date');
  if (dateRaw && !parseISO(dateRaw))
    return bad(c, '「date」はYYYY-MM-DD形式の日付で渡してください。');
  const on = dateRaw ?? null;

  const period = on
    ? ctax.history.find((h) => on >= h.effective_from && (h.effective_to === null || on <= h.effective_to))
    : ctax.history[ctax.history.length - 1];

  if (!period)
    return c.json({
      error: `${on} の時点では消費税は施行されていません。`,
      code: 'out_of_coverage',
      hint: '日本の消費税は1989年4月1日に導入されました。',
      introduced: ctax.history[0].effective_from,
    }, 422);

  const amountRaw = c.req.query('amount');
  const reduced = ['1', 'true', 'yes'].includes((c.req.query('reduced') ?? '').toLowerCase());
  const rate = reduced ? period.reduced : period.standard;

  if (reduced && !rate)
    return c.json({
      error: 'その日には軽減税率はありません。',
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
      return bad(c, '「amount」は0以上の数(円、税抜)で渡してください。');
    // Consumption tax is truncated to the yen on the invoice total.
    const tax = Math.floor(amount * rate!.total);
    body.calculation = {
      amount_excluding_tax: amount,
      tax,
      amount_including_tax: amount + tax,
      rounding: '税額の円未満を切り捨てる',
    };
  }

  return c.json(body);
});

app.get('/v1/consumption-tax/history', (c) => {
  const unknownQ = rejectBadQuery(c, ['include'] as const);
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
  const unknownQ = rejectBadQuery(c, ['include', 'number'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('number');
  if (!raw) return bad(c, 'クエリパラメータ「number」は必須です。', '13桁の法人番号です。例: 8700110005901');
  const r = validateCorporateNumber(raw);
  return c.json({ input: raw, ...r, attribution: CORPORATE_NUMBER_ATTRIBUTION });
});

app.get('/v1/corporate-number/check-digit', (c) => {
  const unknownQ = rejectBadQuery(c, ['base', 'include'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('base');
  if (!raw) return bad(c, 'クエリパラメータ「base」は必須です。', '12桁の会社法人等番号です。例: 700110005901');
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
  const unknownQ = rejectBadQuery(c, ['include', 'number'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('number');
  if (!raw)
    return bad(c, 'クエリパラメータ「number」は必須です。',
      'T8700110005901 のような登録番号です。');
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
  // GET と同じ検査を通す。第8反復で「触った9本だけ」を直したのと同じ形で、
  // POST 4本がこの検査を通っておらず、`?zzz=1` を黙って無視していた。
  const unknownQ = rejectBadQuery(c, [] as const);
  if (unknownQ) return unknownQ;
  let payload: { numbers?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return bad(c, 'リクエストボディはJSONで送ってください。', 'POST {"numbers": ["T8700110005901", ...]}');
  }

  const list = payload?.numbers;
  if (!Array.isArray(list))
    return bad(c, '「numbers」は登録番号の配列で渡してください。');
  if (list.length === 0) return bad(c, '「numbers」が空です。');
  if (list.length > MAX_INVOICE_BATCH)
    return bad(c, `1回のバッチは ${MAX_INVOICE_BATCH} 件までです。渡されたのは ${list.length} 件でした。`,
      '何回かに分けるか、国税庁が公表している全件データを使ってください。',
      'batch_too_large');
  if (list.some((n) => typeof n !== 'string'))
    return bad(c, '「numbers」の各要素は文字列で渡してください。');

  const results = (list as string[]).map((n, index) => ({ index, ...validateInvoiceNumber(n) }));
  const passed = results.filter((r) => r.check_digit_valid).length;

  return c.json({
    run_id: await runId(c.req.path, payload),
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
  const unknownQ = rejectBadQuery(c, ['amount', 'column', 'dependants', 'include', 'taxable_amount'] as const);
  if (unknownQ) return unknownQ;

  const amountRaw = c.req.query('taxable_amount') ?? c.req.query('amount');
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount < 0)
    return bad(c, 'クエリパラメータ「taxable_amount」は必須で、0以上の数で渡してください。',
      '社会保険料等控除後の給与等の金額です。');

  const colRaw = (c.req.query('column') ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return bad(c, `該当する column がありません: 「${colRaw}」`,
      '扶養控除等申告書が提出されていれば「kou」(甲欄)、されていなければ「otsu」(乙欄)です。');
  const column = colRaw as Column;

  const depRaw = c.req.query('dependants') ?? '0';
  const dependants = Number(depRaw);
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '「dependants」は0から50の整数で渡してください。',
      '扶養親族等の数です。乙欄では使いません。');

  const r = withholdingTax(amount, column, dependants);
  return c.json({
    ...r,
    notes: {
      input: 'taxable_amount は社会保険料控除後の額です。総支給額ではありません。',
      table_range: { from: TABLE_MIN, to: TABLE_MAX },
      over_seven: `税額表は扶養親族等 ${MAX_DEPENDANTS_IN_TABLE} 人までです。それを超える分は1人につき1,610円を控除します。`,
      excludes: '住民税と年末調整はこのAPIの対象外です。',
    },
    attribution: WITHHOLDING_ATTRIBUTION,
  });
});

app.get('/v1/withholding-tax/daily', (c) => {
  const unknownQ = rejectBadQuery(c, ['amount', 'column', 'dependants', 'include', 'taxable_amount'] as const);
  if (unknownQ) return unknownQ;

  const raw = c.req.query('taxable_amount') ?? c.req.query('amount');
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount < 0)
    return bad(c, 'クエリパラメータ「taxable_amount」は必須で、0以上の数で渡してください。',
      '社会保険料を控除したあとの日額です。');

  const colRaw = (c.req.query('column') ?? 'kou').toLowerCase();
  if (!['kou', 'otsu', 'hei'].includes(colRaw))
    return bad(c, `該当する column がありません: 「${colRaw}」`,
      '「kou」「otsu」または「hei」(丙欄、日雇いや短期雇用の人)のいずれかです。');

  const dependants = Number(c.req.query('dependants') ?? '0');
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '「dependants」は0から50の整数で渡してください。');

  return c.json({
    ...dailyWithholdingTax(amount, colRaw as DailyColumn, dependants),
    notes: {
      input: 'taxable_amount は社会保険料控除後の日額です。',
      table_range: { from: DAILY_MIN, to: DAILY_MAX },
      over_seven: `扶養親族等が ${DAILY_MAX_DEPENDANTS} 人を超えると、甲欄では1人につき50円を控除します。`,
      hei: '丙欄は日雇いや短期雇用の人のためのもので、独自の税率を持ちます。',
    },
    attribution: DAILY_ATTRIBUTION,
  });
});

/**
 * 月額表との差が目立ち始める水準。
 *
 * 実測: 課税支給額850,000円・扶養2人で1,839円、1,200,000円・扶養4人で16,893円、
 * 2,000,000円・扶養4人で26,006円。扶養が0人ならどの水準でも差は数百円に収まる。
 */
const COMPUTER_DIVERGENCE = { from_amount: 850000 };

app.get('/v1/withholding-tax/computer', (c) => {
  const unknownQ = rejectBadQuery(c, ['amount', 'dependants', 'include', 'spouse', 'taxable_amount'] as const);
  if (unknownQ) return unknownQ;

  const amountRaw = c.req.query('taxable_amount') ?? c.req.query('amount');
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount < 0)
    return bad(c, 'クエリパラメータ「taxable_amount」は必須で、0以上の数で渡してください。',
      '社会保険料を控除したあとの月額です。');

  const spouseRaw = (c.req.query('spouse') ?? 'false').toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(spouseRaw))
    return bad(c, `「spouse」は真偽値で渡してください。渡されたのは「${spouseRaw}」でした。`);
  const hasSpouse = ['true', '1', 'yes'].includes(spouseRaw);

  const depRaw = c.req.query('dependants') ?? '0';
  const dependants = Number(depRaw);
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '「dependants」は0から50の整数で渡してください。',
      '源泉控除対象親族の数です。本人が障害者・寡婦・ひとり親・勤労学生に当たる場合、それぞれ1人として数えます。');

  const result = computerMethod(amount, hasSpouse, dependants);
  return c.json({
    ...result,
    method: 'computer',
    // 「月額表とわずかに異なる」では足りない。実測した差を出しておく。
    // 高額かつ扶養が多いと月2万円以上ちがい、それは毎月の手取りに出る。
    notes: [
      '甲欄だけに使えます。乙欄・丙欄と日額表にこの方式はありません。',
      '月額表とは結果が一致しません。差は年末調整で精算されるので、'
        + '同じ年のうちに両方式を混ぜないでください。',
      amount >= COMPUTER_DIVERGENCE.from_amount && dependants + (hasSpouse ? 1 : 0) > 0
        ? `この水準では差が大きくなります。実測で、課税支給額2,000,000円・扶養4人のとき`
          + `月額表より26,006円低くなりました。月額表は上限を超えた分を45.945%で伸ばし、`
          + `この方式は所得から控除するため税率区分をまたぐためです。`
        : `課税支給額100万円未満・扶養3人以下では、実測した差は平均458円、最大6,997円でした。`,
    ],
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

async function runId(route: string, payload: unknown): Promise<string> {
  // 経路を混ぜる。入れないと、同じ本文を別のエンドポイントに送ったときに同じIDが出る。
  // run_id で台帳を突き合わせている人には、給与バッチと登録番号の検査が同じ実行に見える。
  const bytes = new TextEncoder().encode(JSON.stringify([route, canonicalise(payload)]));
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
      '二重計上は起きません。run_id は呼んだ経路と送った内容から決まるので、同じ呼び出しなら必ず同じ値に' +
      'なります。通信が切れたときは、返ってきた run_id を自分の台帳と突き合わせてください。',
    not_applicable: [
      '409 Conflict — 処理中の重複を検出するには保存が要ります。持っていないので起きません。',
      '422 Unprocessable Content — 同じキーで異なる内容を検出するにも保存が要ります。同じ理由で起きません。',
    ],
    reference: 'draft-ietf-httpapi-idempotency-key-header-07 (2025-10-15)',
    reference_url: 'https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/',
  };
}

/**
 * 大きな応答に、実測サイズと `detail=compact` にした場合の見込みを添える。
 *
 * 500人バッチの実測: 既定 1,045KB / compact 139KB(87%減)。比率はそこから取っている。
 * 応答の末尾の `notes` に書いてあっても、1MBの向こう側は読まれない。
 * **いちばん必要な人がいちばん読めない場所にある**ので、上位に置く。
 *
 * 返す直前に測る。推測した数字を返さない。
 */
function withSizeHint<T extends Record<string, unknown>>(body: T, detail: string): T {
  if (detail === 'compact') return body;
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  if (bytes < 200_000) return body;
  return {
    ...body,
    size_hint: {
      bytes,
      compact_estimate_bytes: Math.round(bytes * 0.133),
      how: '?detail=compact',
      note: 'この応答の大きさです。内訳を使わないなら ?detail=compact で'
        + 'およそ13%まで小さくなります(500人の実測で 1,045KB → 139KB)。'
        + '落とした項目と取り戻し方は omitted に載ります。',
    },
  };
}

app.post('/v1/payroll/batch', async (c) => {
  // GET と同じ検査を通す。第8反復で「触った9本だけ」を直したのと同じ形で、
  // POST 4本がこの検査を通っておらず、`?zzz=1` を黙って無視していた。
  const unknownQ = rejectBadQuery(c, [] as const);
  if (unknownQ) return unknownQ;
  let payload: { employees?: unknown; defaults?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return bad(c, 'リクエストボディはJSONで送ってください。',
      'POST {"defaults": {...}, "employees": [{...}]}');
  }

  const rows = payload?.employees;
  if (!Array.isArray(rows))
    return bad(c, '「employees」は配列で渡してください。', '配列の各要素が、この実行における1人分です。');
  if (rows.length === 0)
    return bad(c, '「employees」が空です。');
  // The free tier can run a batch — just a small one. Gating the endpoint
  // entirely would hide the feature from the people most likely to want it;
  // capping it lets them see exactly what it returns before deciding to pay.
  const { paid } = entitlement(c);
  const cap = paid ? MAX_BATCH : FREE_TIER.batch_rows;
  if (rows.length > cap)
    return bad(c,
      paid
        ? `1回のバッチは ${MAX_BATCH} 人までです。渡されたのは ${rows.length} 人でした。`
        : `無料枠では1回のバッチにつき ${FREE_TIER.batch_rows} 人までです。渡されたのは ${rows.length} 人でした。`,
      paid
        ? '何回かに分けて実行してください。'
        : `${UPGRADE.offer(MAX_BATCH)}。`
          + '無料枠の他の呼び出しに回数の制限はありません。この上限はバッチの人数だけにかかります。',
      'batch_too_large');
  if (rows.some((r) => typeof r !== 'object' || r === null || Array.isArray(r)))
    return bad(c, '「employees」の各要素はオブジェクトで渡してください。');

  const defaults = (payload?.defaults ?? {}) as BatchDefaults;
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults))
    return bad(c, '「defaults」はオブジェクトで渡してください。');

  const detailRaw = (c.req.query('detail') ?? 'full').toLowerCase();
  if (detailRaw !== 'full' && detailRaw !== 'compact')
    return bad(c, `該当する detail がありません: 「${detailRaw}」`,
      '保険料の内訳まで見るなら「full」、支払額だけなら「compact」を指定してください。');

  const { results, errors, summary } = runBatch(rows as BatchRow[], defaults, detailRaw as Detail);
  return c.json(withSizeHint({
    run_id: await runId(c.req.path, payload),
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
      partial: '失敗した行は「errors」に入れて飛ばします。残りはそのまま処理します。',
      order: '各結果は、入力の何行目かを持っています。',
      detail: '?detail=compact を付けると支払額だけになります。大きな実行ではおよそ10分の1の大きさです。',
      employer_cost: 'summary.employer_cost は総支給額に事業主負担の社会保険料を足したものです。',
      resident_tax: '住民税は渡された額をそのまま使います。ここでは算出しません。',
    },
    attribution: { ...ATTRIBUTION, withholding_tax: WITHHOLDING_ATTRIBUTION },
  }, detailRaw));
});

/**
 * 労災保険率表。事業の種類の番号で引く。
 *
 * 番号は徴収法施行規則別表第1のもので、労働保険関係成立届に書くのと同じ番号。
 * 事業主が既に持っている値で引けるようにしてある。
 */
app.get('/v1/workers-compensation', (c) => {
  const unknownQ = rejectBadQuery(c, ['business_type', 'wage_total', 'as_of'] as const);
  if (unknownQ) return unknownQ;

  const asOfRaw = c.req.query('as_of');
  if (asOfRaw !== undefined && !parseDate(asOfRaw))
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');
  const outside = outsideRateWindow(c, 'workers_compensation', asOfRaw ?? null);
  if (outside) return outside;

  const raw = c.req.query('business_type');
  if (raw === undefined) {
    // 賃金総額だけ渡されたら、料率表を返して黙って捨てるのではなく断る。
    // 「賃金総額360万の保険料は」と聞いた人に一覧が返るのは、答えたことにならない。
    // 率は事業の種類で35倍開くので、こちらで選ぶこともできない。
    if (c.req.query('wage_total') !== undefined)
      return bad(c, 'wage_total だけでは保険料を計算できません。business_type も渡してください。',
        '労災保険率は事業の種類ごとに1,000分の2.5から88まで開くため、種類を決めずに'
        + '保険料は出せません。事業の種類の番号は business_type を渡さずに呼べば一覧できます。',
        'missing_parameter');
    return c.json({
      fiscal_year: WORKERS_COMP_META.fiscal_year,
      effective_from: WORKERS_COMP_META.effective_from,
      applies: RATE_WINDOWS.workers_compensation,
      burden: WORKERS_COMP_META.burden,
      count: WORKERS_COMP_TYPES.length,
      business_types: WORKERS_COMP_TYPES,
      notes: {
        lookup: 'business_type= に事業の種類の番号(例: 98)を渡すとその1件だけを返します。wage_total= を渡すと保険料を計算します。',
        payroll: 'GET /v1/payroll?workers_comp_type=98 で totals.employer_cost に算入されます。',
        excluded: WORKERS_COMP_META.excluded,
      },
      attribution: WORKERS_COMP_ATTRIBUTION,
    });
  }

  const type = workersCompType(raw);
  if (!type)
    return bad(c, `該当する business_type がありません: 「${raw}」`,
      'GET /v1/workers-compensation の事業の種類の番号(02〜99)を使ってください。',
      'unknown_workers_comp_type');

  const wageRaw = c.req.query('wage_total');
  const wage = wageRaw === undefined ? null : Number(wageRaw);
  if (wageRaw !== undefined && (!Number.isFinite(wage!) || wage! < 0))
    return bad(c, '「wage_total」は0以上の数(円)で渡してください。',
      'その期間の賃金総額です。雇用保険と同じ算定基礎を使います。');

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
      burden: '保険料は全額が事業主負担です。従業員からは引きません。',
      wage_base: '賃金総額(徴収法第2条第2項)にかかります。雇用保険と同じ算定基礎なので、通勤手当は含み、実費弁償は含みません。',
      excluded: WORKERS_COMP_META.excluded,
    },
    attribution: WORKERS_COMP_ATTRIBUTION,
  });
});

app.get('/v1/leave-exemption', (c) => {
  const unknownQ = rejectBadQuery(c, ['end', 'include', 'kind', 'start', 'worked_days'] as const);
  if (unknownQ) return unknownQ;

  // 既定値を置かない。育休には14日要件があり産休には無いので、同じ日付でも
  // 免除される月が変わる。書き忘れた人に「免除されます」と答えるのが、
  // このAPIがいちばん避けたい形の誤り。
  const kindGiven = c.req.query('kind');
  if (kindGiven === undefined)
    return bad(c, 'クエリパラメータ「kind」は必須です。',
      '産前産後休業は「maternity」、育児休業等は「childcare」です。既定値を置いていません。'
      + '育児休業には同一月14日以上という要件があり(健保法159条1項2号)、産前産後休業には'
      + 'ありません。同じ日付でも免除される月が変わるため、どちらかを決めてもらう必要があります。',
      'missing_parameter');
  const kindRaw = kindGiven.toLowerCase();
  if (kindRaw !== 'maternity' && kindRaw !== 'childcare')
    return bad(c, `該当する kind がありません: 「${kindRaw}」`,
      '産前産後休業は「maternity」、育児休業等は「childcare」です。');

  const start = parseDate(c.req.query('start'));
  if (!start)
    return bad(c, '「start」は必須で、YYYY-MM-DD形式の日付で渡してください。');
  const end = parseDate(c.req.query('end'));
  if (!end)
    return bad(c, '「end」は必須で、YYYY-MM-DD形式の日付で渡してください。');
  if (end.getTime() < start.getTime())
    return bad(c, '「end」は「start」より前にできません。');

  const workedRaw = c.req.query('worked_days') ?? '0';
  const workedDays = Number(workedRaw);
  if (!Number.isInteger(workedDays) || workedDays < 0 || workedDays > 31)
    return bad(c, '「worked_days」は0から31の整数で渡してください。',
      '出生時育児休業中に就業した日数だけです。時間単位は floor(時間 ÷ 1日の所定労働時間) で日数に換算します。');
  if (workedDays > 0 && kindRaw === 'maternity')
    return bad(c, 'worked_days は出生時育児休業にだけ使います。産前産後休業には使いません。');

  return c.json({
    ...leaveExemption({ kind: kindRaw as LeaveKind, start, end, workedDays }),
    notes: {
      priority: '産前産後休業が優先します。健保法159条1項は、159条の3で既に免除されている人を対象から外しています。',
      consecutive: '間に就業日を挟まない2回の育児休業は1回として扱います(健保法159条2項)。',
      shares: '従業員負担分と事業主負担分の両方が免除されます。',
    },
    attribution: LEAVE_ATTRIBUTION,
  });
});

const WORKER_TYPES = ['general', 'part_time_short_hours', 'short_time_insured'] as const;

/** `350000:31,352000:30,349000:31` — amount:payment_basis_days, three months. */
function parseMonths(raw: string | undefined): PayMonth[] | string {
  if (!raw) return '「months」は必須です。';
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 3) return `「months」はちょうど3か月分が必要です。渡されたのは ${parts.length} 件でした。`;
  const out: PayMonth[] = [];
  for (const [i, p] of parts.entries()) {
    const [a, d] = p.split(':');
    const remuneration = Number(a);
    const days = Number(d);
    if (!Number.isFinite(remuneration) || remuneration < 0)
      return `${i + 1}か月目: 「${a}」は報酬月額として読めません。`;
    if (!Number.isInteger(days) || days < 0 || days > 31)
      return `${i + 1}か月目: 支払基礎日数は0から31の整数で渡してください。渡されたのは「${d}」でした。`;
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
  bad(c, `該当する worker_type がありません: 「${String(raw)}」`,
    `次のいずれかを使ってください: ${WORKER_TYPES.join(', ')}。支払基礎日数の要件は17日です。ただし` +
    '特定適用事業所の短時間労働者は11日です。');

app.get('/v1/standard-remuneration/revision', (c) => {
  const unknownQ = rejectBadQuery(c, ['current_remuneration', 'fixed_pay_change', 'include', 'months', 'worker_type'] as const);
  if (unknownQ) return unknownQ;

  const current = Number(c.req.query('current_remuneration'));
  if (!Number.isFinite(current) || current < 0)
    return bad(c, '「current_remuneration」は必須で、0以上の数で渡してください。',
      '現在の等級の基礎になった報酬月額を渡してください。標準報酬月額ではありません。上下限の例外は実際の報酬で決まります。');

  const months = parseMonths(c.req.query('months'));
  if (typeof months === 'string')
    return bad(c, months, '形式: months=350000:31,352000:30,349000:31 (報酬月額:支払基礎日数)');

  const workerType = parseWorkerType(c.req.query('worker_type'));
  if (workerType === null) return badWorkerType(c, c.req.query('worker_type'));

  const changeRaw = (c.req.query('fixed_pay_change') ?? '').toLowerCase();
  if (!['increase', 'decrease', 'none'].includes(changeRaw))
    return bad(c, '「fixed_pay_change」は必須です。',
      '「increase」「decrease」「none」のいずれかです。固定的賃金だけが対象で、残業代だけでは随時改定になりません。応答の guidance.fixed_pay も参照してください。');

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
    return { err: bad(c, '「year」は4桁の年で渡してください。',
      '定時決定の対象年です。その年の7月1日が条文の定める基準日になります。') };

  const iso = (key: string) => {
    const raw = c.req.query(key);
    if (raw === undefined) return { ok: true as const, value: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !parseDate(raw))
      return { ok: false as const, value: null };
    return { ok: true as const, value: raw };
  };

  const acquired = iso('acquired_on');
  if (!acquired.ok)
    return { err: bad(c, '「acquired_on」はYYYY-MM-DD形式の日付で渡してください。',
      '資格取得日。6月1日から7月1日までの取得は定時決定の対象外です (健康保険法第41条)。') };
  const left = iso('left_on');
  if (!left.ok)
    return { err: bad(c, '「left_on」はYYYY-MM-DD形式の日付で渡してください。',
      '退職日。基準日である7月1日に使用されていなければ対象外です。') };

  // 1〜12を受け取り、7〜9だけを除外事由にする。7〜9以外を拒否すると、6月に改定が
  // あった人について「まだ出す」と答えられなくなり、判定が null に落ちてしまう。
  const revRaw = c.req.query('revision_month');
  const revision = revRaw === undefined ? null : Number(revRaw);
  if (revRaw !== undefined && (!Number.isInteger(revision!) || revision! < 1 || revision! > 12))
    return { err: bad(c, '「revision_month」は1から12の月番号で渡してください。',
      '定時決定を外すのは「七月から九月までのいずれかの月」からの随時改定だけです (健康保険法第41条)。' +
      'それ以外の月の改定は定時決定を妨げないので、渡せば「提出対象」と返します。') };

  return { value: { year, acquired_on: acquired.value, left_on: left.value, revision_month: revision } };
}

app.get('/v1/standard-remuneration/regular', (c) => {
  // 未知パラメータを黙って捨てると、acquired_on の綴り間違いが「対象」に化ける。
  const unknownQ = rejectBadQuery(c, ['months', 'worker_type', 'previous_remuneration', 'acquired_month',
    'year', 'acquired_on', 'left_on', 'revision_month',
  ] as const);
  if (unknownQ) return unknownQ;

  const months = parseMonths(c.req.query('months'));
  if (typeof months === 'string')
    return bad(c, months, '形式: months=350000:30,352000:31,349000:30 (4月・5月・6月の順)');

  const workerType = parseWorkerType(c.req.query('worker_type'));
  if (workerType === null) return badWorkerType(c, c.req.query('worker_type'));

  const prevRaw = c.req.query('previous_remuneration');
  const previous = prevRaw === undefined ? undefined : Number(prevRaw);
  if (previous !== undefined && (!Number.isFinite(previous) || previous < 0))
    return bad(c, '「previous_remuneration」は0以上の数で渡してください。',
      'どの月も要件を満たさないときに、引き継がれる等級を示すためだけに使います。');

  const acquiredRaw = c.req.query('acquired_month');
  const acquired = acquiredRaw === undefined ? undefined : Number(acquiredRaw);
  if (acquired !== undefined && (!Number.isInteger(acquired) || acquired < 1 || acquired > 12))
    return bad(c, '「acquired_month」は1から12の月番号で渡してください。');

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
  // GET と同じ検査を通す。第8反復で「触った9本だけ」を直したのと同じ形で、
  // POST 4本がこの検査を通っておらず、`?zzz=1` を黙って無視していた。
  const unknownQ = rejectBadQuery(c, [] as const);
  if (unknownQ) return unknownQ;
  let payload: { employees?: unknown; defaults?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return bad(c, 'リクエストボディはJSONで送ってください。',
      'POST {"defaults": {...}, "employees": [{"id": "e1", "months": [{"remuneration": 350000, "payment_basis_days": 30}, ...]}]}');
  }

  const rows = payload?.employees;
  if (!Array.isArray(rows))
    return bad(c, '「employees」は配列で渡してください。', '配列の各要素が、決定する従業員1人です。');
  if (rows.length === 0) return bad(c, '「employees」が空です。');

  const { paid } = entitlement(c);
  const cap = paid ? MAX_BATCH : FREE_TIER.batch_rows;
  if (rows.length > cap)
    return bad(c,
      paid
        ? `1回のバッチは ${MAX_BATCH} 人までです。渡されたのは ${rows.length} 人でした。`
        : `無料枠では1回のバッチにつき ${FREE_TIER.batch_rows} 人までです。渡されたのは ${rows.length} 人でした。`,
      paid
        ? '何回かに分けて実行してください。'
        : `${UPGRADE.offer(MAX_BATCH)}。` +
          '算定基礎届は全員を一度に対象とするため、6月にいちばん効きやすい上限です。',
      'batch_too_large');
  if (rows.some((r) => typeof r !== 'object' || r === null || Array.isArray(r)))
    return bad(c, '「employees」の各要素はオブジェクトで渡してください。');

  const defaults = (payload?.defaults ?? {}) as Record<string, unknown>;
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults))
    return bad(c, '「defaults」はオブジェクトで渡してください。');

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
        'months は4月・5月・6月のちょうど3件の配列で渡してください(健康保険法第41条)。');

    const months: PayMonth[] = [];
    for (const [i, mRaw] of monthsRaw.entries()) {
      if (typeof mRaw !== 'object' || mRaw === null || Array.isArray(mRaw))
        return at('invalid_request', `months[${i}] はオブジェクトで渡してください。`);
      const mo = mRaw as Record<string, unknown>;
      const remuneration = Number(mo.remuneration);
      const days = Number(mo.payment_basis_days);
      if (!Number.isFinite(remuneration) || remuneration < 0)
        return at('invalid_request', `months[${i}].remuneration は0以上の数で渡してください。`);
      if (!Number.isInteger(days) || days < 0 || days > 31)
        return at('invalid_request', `months[${i}].payment_basis_days は0から31の整数(日数)で渡してください。`);
      months.push({ remuneration, payment_basis_days: days });
    }

    const wtRaw = row.worker_type ?? (defaults as any).worker_type;
    const workerType = parseWorkerType(wtRaw === undefined ? undefined : String(wtRaw));
    if (workerType === null)
      return at('unknown_worker_type',
        `該当する worker_type がありません: 「${String(wtRaw)}」 次のいずれかを使ってください: ${WORKER_TYPES.join(', ')}.`);

    const prevRaw = row.previous_remuneration ?? (defaults as any).previous_remuneration;
    const previous = prevRaw === undefined || prevRaw === null ? undefined : Number(prevRaw);
    if (previous !== undefined && (!Number.isFinite(previous) || previous < 0))
      return at('invalid_request', 'previous_remuneration は0以上の数で渡してください。');

    // 6月の作業は「誰を出すか」を選り分けること。等級だけ出しても提出物は決まらない。
    const yearRaw = row.year ?? (defaults as any).year;
    const year = yearRaw === undefined || yearRaw === null ? new Date().getFullYear() : Number(yearRaw);
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      return at('invalid_request', 'year は4桁の年で渡してください。');

    const isoOf = (key: string) => {
      const v = (row as any)[key] ?? (defaults as any)[key];
      if (v === undefined || v === null) return { ok: true as const, value: null };
      const str = String(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || !parseDate(str)) return { ok: false as const, value: null };
      return { ok: true as const, value: str };
    };
    const acquired = isoOf('acquired_on');
    if (!acquired.ok) return at('invalid_request', 'acquired_on はYYYY-MM-DD形式の日付で渡してください。');
    const leftOn = isoOf('left_on');
    if (!leftOn.ok) return at('invalid_request', 'left_on はYYYY-MM-DD形式の日付で渡してください。');

    const revRaw = (row as any).revision_month ?? (defaults as any).revision_month;
    const revision = revRaw === undefined || revRaw === null ? null : Number(revRaw);
    if (revRaw !== undefined && revRaw !== null
        && (!Number.isInteger(revision!) || revision! < 1 || revision! > 12))
      return at('invalid_request',
        'revision_month は1から12の月で渡してください。定時決定を覆すのは7月から9月の随時改定だけです(健康保険法第41条)。');

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
  return c.json(withSizeHint({
    run_id: await runId(c.req.path, payload),
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
      partial: '失敗した行は「errors」に入れて飛ばします。残りはそのまま処理します。',
      changed:
        'previous_remuneration を渡さなければ changed は null です。前年の等級が無ければ比べる相手が'
        + '無く、false を返すと「動かなかった」と読めてしまうためです。',
      months: '3つの要素は4月・5月・6月の順です。支払基礎日数が17日未満の月は' +
        '平均から除きます(健康保険法第41条)。',
      submission:
        'submission.required は acquired_on・left_on・revision_month から健康保険法第41条を判定します。' +
        '3つのいずれも渡されなければ null です。分からないことと、出さなくてよいことは別の答えです。' +
        '適用除外の人にも等級は付けます。除外の判断を数字と突き合わせて確かめられるようにするためです。',
    },
    attribution: REVISION_ATTRIBUTION,
  }, c.req.query('detail') ?? 'full'));
});

app.get('/v1/standard-remuneration/leave-end', (c) => {
  const unknownQ = rejectBadQuery(c, ['current_remuneration', 'include', 'kind', 'months', 'next_leave_starts_immediately', 'worker_type'] as const);
  if (unknownQ) return unknownQ;

  // 既定値を置かない。数字は同じでも、引用する条文が 43条の2 と 43条の3 で変わる。
  // 産休の判定に育休の条文が添えられていたら、出典に当たった人が別の条を読むことになる。
  const kindGiven = c.req.query('kind');
  if (kindGiven === undefined)
    return bad(c, 'クエリパラメータ「kind」は必須です。',
      '産前産後休業終了時改定は「maternity」(健保法43条の3)、育児休業等終了時改定は'
      + '「childcare」(健保法43条の2)です。等級の判定は同じですが、根拠条文が変わります。',
      'missing_parameter');
  const kindRaw = kindGiven.toLowerCase();
  if (kindRaw !== 'maternity' && kindRaw !== 'childcare')
    return bad(c, `該当する kind がありません: 「${kindRaw}」`,
      '産前産後休業終了時改定は「maternity」、育児休業等終了時改定は「childcare」です。');

  const current = Number(c.req.query('current_remuneration'));
  if (!Number.isFinite(current) || current < 0)
    return bad(c, '「current_remuneration」は必須で、0以上の数で渡してください。');

  const months = parseMonths(c.req.query('months'));
  if (typeof months === 'string')
    return bad(c, months,
      '休業終了日の翌日が属する月から3か月です。形式: months=260000:31,258000:30,262000:31.');

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
  // GET と同じ検査を通す。第8反復で「触った9本だけ」を直したのと同じ形で、
  // POST 4本がこの検査を通っておらず、`?zzz=1` を黙って無視していた。
  const unknownQ = rejectBadQuery(c, [] as const);
  if (unknownQ) return unknownQ;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return bad(c, '本文が正しいJSONではありません。', 'Send Content-Type: application/json.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return bad(c, '本文はJSONオブジェクトで渡してください。');

  const type = String(body.type ?? '').toLowerCase();
  if (type !== 'regular' && type !== 'revision')
    return bad(c, '「type」は必須です。',
      '定時決定の年間平均(前年7月〜当年6月)は「regular」、随時改定の年間平均(変動月前9か月＋以後3か月)は「revision」です。');

  if (!Array.isArray(body.months) || body.months.length !== 12)
    return bad(c, '「months」はちょうど12件の配列で渡してください。',
      type === 'regular'
        ? '前年7月から当年6月までの順に、各要素は {"remuneration": n, "payment_basis_days": n} です。'
        : '賃金の変動前9か月と変動後3か月です。各要素は {"fixed": n, "non_fixed": n, "payment_basis_days": n}.');

  const months: AnnualMonth[] = [];
  for (const [i, m] of body.months.entries()) {
    if (!m || typeof m !== 'object')
      return bad(c, `months[${i}] はオブジェクトで渡してください。`);
    const days = Number(m.payment_basis_days);
    if (!Number.isInteger(days) || days < 0 || days > 31)
      return bad(c, `months[${i}].payment_basis_days は0から31の整数で渡してください。`);
    if (type === 'regular') {
      const r = Number(m.remuneration);
      if (!Number.isFinite(r) || r < 0)
        return bad(c, `months[${i}].remuneration は0以上の数で渡してください。`);
      months.push({ month: m.month, remuneration: r, payment_basis_days: days });
    } else {
      const fixed = Number(m.fixed);
      const nonFixed = Number(m.non_fixed);
      if (!Number.isFinite(fixed) || fixed < 0)
        return bad(c, `months[${i}].fixed は0以上の数で渡してください。`,
          '固定的賃金は基本給と固定手当です。年間平均では変動後の3か月だけで平均します。');
      if (!Number.isFinite(nonFixed) || nonFixed < 0)
        return bad(c, `months[${i}].non_fixed は0以上の数で渡してください。`,
          '非固定的賃金は残業代などです。12か月すべてで平均します。');
      months.push({ month: m.month, fixed, non_fixed: nonFixed, payment_basis_days: days });
    }
  }

  const workerType = parseWorkerType(body.worker_type);
  if (workerType === null) return badWorkerType(c, body.worker_type);

  const recurring = body.recurring_annually === true;
  const consent = body.employee_consent === true;

  if (type === 'regular')
    return c.json({
      run_id: await runId(c.req.path, body),
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
    return bad(c, 'type が「revision」のときは「current_remuneration」が必要です。');
  const change = String(body.fixed_pay_change ?? '').toLowerCase();
  if (change !== 'increase' && change !== 'decrease')
    return bad(c, 'type が「revision」のとき、「fixed_pay_change」は「increase」か「decrease」でなければなりません。',
      '年間平均は固定的賃金が実際に変わった場合にだけ使えます。「none」では該当しません。');

  return c.json({
    run_id: await runId(c.req.path, body),
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
  const unknownQ = rejectBadQuery(c, ['as_of', 'months', 'supplementary', 'include'] as const);
  if (unknownQ) return unknownQ;

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date().toISOString().slice(0, 10) : asOfRaw;
  if (asOfRaw !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) || !parseDate(asOfRaw)))
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');

  // 保険料は毎年度4月に変わる。収録している年度の外を、その年度の額で答えない。
  // 最低賃金と同じ形の防壁で、データが追いつけば自動的に外れる。
  if (asOf < NATIONAL_PENSION.from || asOf > NATIONAL_PENSION.through)
    return c.json({
      error: `${asOf} 時点の国民年金保険料は収録していません。`,
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
    return bad(c, '「months」は1から480までの整数(月数)で渡してください。');

  const suppRaw = c.req.query('supplementary');
  if (suppRaw !== undefined && suppRaw !== 'true' && suppRaw !== 'false')
    return bad(c, '「supplementary」は true か false で渡してください。',
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
  const unknownQ = rejectBadQuery(c, ['prefecture', 'pref', 'monthly_salary', 'standard_remuneration', 'age', 'birth_date',
    'business_type', 'column', 'dependants', 'income_tax', 'resident_tax',
    'employment_type', 'workers_comp_type', 'bonuses', 'fiscal_year', 'as_of', 'include',
  ] as const);
  if (unknownQ) return unknownQ;

  const r = needPref(c); if ('err' in r) return r.err;

  const salaryRaw = c.req.query('monthly_salary');
  const salary = salaryRaw === undefined ? NaN : Number(salaryRaw);
  if (salaryRaw === undefined || !Number.isFinite(salary) || salary < 0)
    return bad(c, '「monthly_salary」は必須で、0以上の数で渡してください。');

  const ageRaw = c.req.query('age');
  const age = ageRaw === undefined ? null : Number(ageRaw);
  if (ageRaw !== undefined && (!Number.isFinite(age!) || age! < 0 || age! > 120))
    return bad(c, '「age」は0から120の数で渡してください。');
  const birthRaw = c.req.query('birth_date');
  const birth = birthRaw === undefined ? null : parseDate(birthRaw);
  if (birthRaw !== undefined && !birth)
    return bad(c, '「birth_date」はYYYY-MM-DD形式の日付で渡してください。');
  { const e = badBirthDate(c, birth); if (e) return e; }
  if (ageRaw === undefined && birthRaw === undefined)
    return bad(c, '「age」か「birth_date」のどちらかが必要です。',
      '介護保険法第9条は年齢そのものを、介護保険料がかかるかどうかの基準にしています。年齢が無ければ、40歳以上65歳未満の人について年額が過小になります。',
      'missing_parameter');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');
  const outside = outsideRateWindow(c, 'social_insurance', asOfRaw ?? null);
  if (outside) return outside;

  const btKey = String(c.req.query('business_type') ?? 'general').toLowerCase();
  if (!(empins.business_types as any)[btKey])
    return bad(c, `該当する business_type がありません: 「${btKey}」`);

  const colRaw = String(c.req.query('column') ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return bad(c, `該当する column がありません: 「${colRaw}」。「kou」か「otsu」を使ってください。`);

  const depRaw = c.req.query('dependants');
  const dependants = depRaw === undefined ? 0 : Number(depRaw);
  if (depRaw !== undefined && (!Number.isInteger(dependants) || dependants < 0))
    return bad(c, '「dependants」は0以上の整数で渡してください。');

  const residentRaw = c.req.query('resident_tax');
  const residentTax = residentRaw === undefined ? 0 : Number(residentRaw);
  if (residentRaw !== undefined && (!Number.isFinite(residentTax) || residentTax < 0))
    return bad(c, '「resident_tax」は0以上の数で渡してください。');

  // 許可リストには載っていたが、computePayslip に true を直接渡していたので効かなかった。
  // 事業主の負担だけを見たい呼び出しがあるので、payroll と同じように受ける。
  const taxRaw = (c.req.query('income_tax') ?? 'true').toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(taxRaw))
    return bad(c, `「income_tax」は真偽値で渡してください。渡されたのは「${taxRaw}」でした。`);
  const wantIncomeTax = ['true', '1', 'yes'].includes(taxRaw);

  const smrRaw = c.req.query('standard_remuneration');
  const smr = smrRaw === undefined ? null : Number(smrRaw);
  if (smrRaw !== undefined && (!Number.isFinite(smr!) || smr! < 0))
    return bad(c, '「standard_remuneration」は0以上の数で渡してください。');

  const empRaw = String(c.req.query('employment_type') ?? 'employee');
  if (empRaw !== 'employee' && empRaw !== 'director' && empRaw !== 'director_employee')
    return bad(c, `該当する employment_type がありません: 「${empRaw}」`);

  const wcRaw = c.req.query('workers_comp_type');
  if (wcRaw !== undefined && !workersCompType(wcRaw))
    return bad(c, `該当する workers_comp_type がありません: 「${wcRaw}」`);

  const bonusRaw = c.req.query('bonuses');
  const bonuses: number[] = [];
  if (bonusRaw !== undefined && bonusRaw !== '') {
    for (const part of bonusRaw.split(',')) {
      const v = Number(part.trim());
      if (!Number.isFinite(v) || v < 0)
        return bad(c, `「bonuses」は0以上の数をカンマ区切りで渡してください。渡されたのは「${part.trim()}」でした。`,
          '渡された順に処理します。健康保険の上限が年度累計のためです。');
      bonuses.push(v);
    }
  }

  const fyRaw = c.req.query('fiscal_year');
  const fiscalYear = fyRaw === undefined
    ? (asOf!.getUTCMonth() >= 3 ? asOf!.getUTCFullYear() : asOf!.getUTCFullYear() - 1)
    : Number(fyRaw);
  if (fyRaw !== undefined && (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100))
    return bad(c, '「fiscal_year」は4桁の年で渡してください。年度は4月1日から翌年3月31日までです。');

  const slip = computePayslip({
    prefecture: r.pref, monthly_salary: salary, age, birth_date: birth, as_of: asOf!,
    business_type: btKey, employment_type: empRaw as any, standard_remuneration: smr,
    allowances: [], workers_comp_type: wcRaw ?? null,
    column: colRaw as Column, dependants, income_tax: wantIncomeTax, resident_tax: residentTax,
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
  const unknownQ = rejectBadQuery(c, ['hired_on', 'as_of', 'attendance_rate', 'weekly_days', 'weekly_hours',
    'annual_days', 'days_taken', 'include',
  ] as const);
  if (unknownQ) return unknownQ;

  const hiredRaw = c.req.query('hired_on');
  const hired = hiredRaw === undefined ? null : parseDate(hiredRaw);
  if (hiredRaw === undefined)
    return bad(c, '「hired_on」は必須です。',
      '雇入れの日。付与日は雇入れから6か月後で、以降1年ごとです (労働基準法第39条第1項)。',
      'missing_parameter');
  if (!hired) return bad(c, '「hired_on」はYYYY-MM-DD形式の日付で渡してください。');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');
  if (asOf! < hired)
    return bad(c, '「as_of」が「hired_on」より前です。',
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
      return bad(c, `「${key}」が範囲外です。`,
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
  const unknownQ = rejectBadQuery(c, ['weekly_hours', 'normal_weekly_hours', 'monthly_days', 'normal_monthly_days',
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
    return bad(c, '「weekly_hours」は必須です。',
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
      return bad(c, key.startsWith('normal_')
        ? `「${key}」は0より大きい数で渡してください。`
        : `「${key}」は0以上の数で渡してください。`);

  const studentRaw = c.req.query('is_student');
  if (studentRaw !== undefined && studentRaw !== 'true' && studentRaw !== 'false')
    return bad(c, '「is_student」は true か false で渡してください。');

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
  const unknownQ = rejectBadQuery(c, ['include', 'joined_on', 'left_on', 'month'] as const);
  if (unknownQ) return unknownQ;

  const monthRaw = c.req.query('month');
  const month = monthRaw
    ? parseDate(/^\d{4}-\d{2}$/.test(monthRaw) ? `${monthRaw}-01` : monthRaw)
    : new Date();
  if (!month)
    return bad(c, '「month」はYYYY-MM、または日付まで含めた形で渡してください。');

  const joinedRaw = c.req.query('joined_on');
  const joined = joinedRaw === undefined ? null : parseDate(joinedRaw);
  if (joinedRaw !== undefined && !joined)
    return bad(c, '「joined_on」はYYYY-MM-DD形式の日付で渡してください。');

  const leftRaw = c.req.query('left_on');
  const left = leftRaw === undefined ? null : parseDate(leftRaw);
  if (leftRaw !== undefined && !left)
    return bad(c, '「left_on」はYYYY-MM-DD形式の日付で渡してください。',
      'これは最後に勤務した日です。資格を喪失する日ではありません。');

  if (joined && left && left.getTime() < joined.getTime())
    return bad(c, '「left_on」は「joined_on」より前にできません。');

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
  const unknown = rejectBadQuery(c, OVERTIME_PARAMS);
  if (unknown) return unknown;

  const num = (name: string, required = false) => {
    const raw = c.req.query(name);
    if (raw === undefined) return required ? NaN : 0;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : NaN;
  };

  const base = num('base_monthly_pay', true);
  if (!Number.isFinite(base) || base <= 0)
    return bad(c, '「base_monthly_pay」は必須で、正の数で渡してください。',
      '月給のうち割増賃金の算定基礎に入る部分です。労働基準法施行規則第21条が除外できる7種類を'
      + '限定列挙しており、それ以外は除外できません。レスポンスの excludable_allowances を見てください。');

  const scheduled = num('monthly_scheduled_hours', true);
  if (!Number.isFinite(scheduled) || scheduled <= 0)
    return bad(c, '「monthly_scheduled_hours」は必須で、正の数で渡してください。',
      '月平均所定労働時間です。年間所定労働日数 × 1日の所定労働時間 ÷ 12 で求めます。 ' +
      '事業所ごとに異なるため、既定値を置けません。');

  const hours = {
    overtime_hours: num('overtime_hours'),
    night_hours: num('night_hours'),
    holiday_hours: num('holiday_hours'),
    holiday_night_hours: num('holiday_night_hours'),
  };
  for (const [k, v] of Object.entries(hours))
    if (!Number.isFinite(v)) return bad(c, `「${k}」は0以上の時間数で渡してください。`);

  if (hours.night_hours > hours.overtime_hours + hours.holiday_hours + 744)
    return bad(c, '「night_hours」が現実的な範囲を超えています。',
      '深夜時間数は、22時から5時に重なる時間のことです。別枠の労働ではありません。');

  const roundRaw = c.req.query('round');
  if (roundRaw !== undefined && !['true', 'false'].includes(roundRaw))
    return bad(c, '「round」は「true」か「false」で渡してください。');

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
  const unknownQ = rejectBadQuery(c, ['amount', 'distance_km', 'fare', 'parking'] as const);
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
    if (f.bad) return bad(c, `「${key}」は0以上の数で渡してください。`);

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
      return bad(c, 'distance_km・fare・parking は amount と一緒でなければ意味を持ちません。',
        'amount= に実際に支払っている通勤手当を渡してください。残りのパラメータが、そのうち非課税になる額を決めます。何も渡さなければ表全体を返します。',
        'missing_parameter');
    return c.json({ reference, revisions, attribution: COMMUTING_SOURCE });
  }

  if (parking.raw !== undefined && km.raw === undefined)
    return bad(c, 'parking は距離区分の額への加算なので、distance_km が必要です。',
      '駐車場代の加算は交通用具通勤の制度です。交通機関だけで通う人には、加算する距離区分がありません。',
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
  const unknown = rejectBadQuery(c, BONUS_INSURANCE_PARAMS);
  if (unknown) return unknown;
  const r = needPref(c); if ('err' in r) return r.err;

  const bonusRaw = c.req.query('bonus');
  const bonus = Number(bonusRaw);
  if (!bonusRaw || !Number.isFinite(bonus) || bonus < 0)
    return bad(c, 'クエリパラメータ「bonus」は必須で、0以上の数(円)で渡してください。');

  const ytdRaw = c.req.query('fiscal_year_to_date') ?? '0';
  const ytd = Number(ytdRaw);
  if (!Number.isFinite(ytd) || ytd < 0)
    return bad(c, '「fiscal_year_to_date」は0以上の数で渡してください。',
      '4月1日以降に既に計上した標準賞与額です。健康保険の年度上限を当てはめるために必要です。');

  const ageRaw = c.req.query('age');
  const age = ageRaw === undefined ? null : Number(ageRaw);
  if (ageRaw !== undefined && (!Number.isFinite(age!) || age! < 0 || age! > 120))
    return bad(c, '「age」は0から120の数で渡してください。');

  const birthRaw = c.req.query('birth_date');
  const birth = birthRaw === undefined ? null : parseDate(birthRaw);
  if (birthRaw !== undefined && !birth)
    return bad(c, '「birth_date」はYYYY-MM-DD形式の日付で渡してください。');
  { const e = badBirthDate(c, birth); if (e) return e; }

  // 賞与にも同じ法理が働く。月次だけ直して賞与を残すと、片方だけ正しい状態になる。
  if (ageRaw === undefined && birthRaw === undefined)
    return bad(c, '「age」か「birth_date」のどちらかが必要です。', '介護保険法第9条は年齢そのものを基準にしています。第2号被保険者は40歳以上65歳未満です。年齢が無ければこのエンドポイントは「40歳未満」と仮定するほかなく、黙って徴収不足になります。東京で月給30万円なら月2,430円です。age を渡すか、birth_date を渡して40歳・65歳・70歳・75歳の到達日を正確に当てはめてください。',
      'missing_parameter');

  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');

  // 資格喪失月の賞与、および休業中の賞与には保険料がかからない。以前はこれらを
  // 受け取っておらず、退職日を渡しても無視して満額を返していた。
  const paidRaw = c.req.query('paid_on');
  const paidOn = paidRaw === undefined ? null : parseDate(paidRaw);
  if (paidRaw !== undefined && !paidOn)
    return bad(c, '「paid_on」はYYYY-MM-DD形式の日付で渡してください。',
      '賞与を支払った日です。資格喪失月に当たるかどうかの判定に使います。');

  const leftRaw = c.req.query('left_on');
  const leftOn = leftRaw === undefined ? null : parseDate(leftRaw);
  if (leftRaw !== undefined && !leftOn)
    return bad(c, '「left_on」はYYYY-MM-DD形式の日付で渡してください。',
      '最後に勤務した日です。資格喪失はその翌日なので、3月30日と3月31日では結論が逆になります。');
  if (leftOn && !paidOn)
    return bad(c, '「left_on」には「paid_on」も必要です。',
      '賞与が免除されるかは、支払われた月がどこかで決まります。退職時期だけでは決まりません。');

  const leaveRaw = c.req.query('leave_exempt');
  if (leaveRaw !== undefined && !['true', 'false'].includes(leaveRaw))
    return bad(c, '「leave_exempt」は「true」か「false」で渡してください。',
      '賞与が産前産後休業中、または1か月を超える育児休業中に当たるとき true です。' +
      'これは GET /v1/leave-exemption が休業日から判定します。');

  const pref = insurance.prefectures[r.pref];
  return c.json({
    prefecture: r.pref, prefecture_ja: pref.prefecture_ja,
    ...bonusInsurance({
      prefecture: r.pref, bonus, fiscal_year_to_date: ytd,
      age, birth_date: birth, as_of: asOf!,
      paid_on: paidOn, left_on: leftOn, leave_exempt: leaveRaw === 'true',
    }),
    notes: {
      base: '標準賞与額は賞与の千円未満を切り捨てた額です。',
      annual_cap: '健康保険側の上限は年度累計なので、fiscal_year_to_date を渡さないと当てはめられません。',
      withholding: '賞与の所得税は別の計算です。/v1/bonus-tax を参照してください。',
    },
    attribution: BONUS_INSURANCE_ATTRIBUTION,
  });
});

app.get('/v1/age-milestones', (c) => {
  const unknownQ = rejectBadQuery(c, ['as_of', 'birth_date', 'include'] as const);
  if (unknownQ) return unknownQ;

  const birth = parseDate(c.req.query('birth_date'));
  { const e = badBirthDate(c, birth); if (e) return e; }
  if (!birth)
    return bad(c, 'クエリパラメータ「birth_date」は必須で、YYYY-MM-DD形式の日付で渡してください。');
  const asOfRaw = c.req.query('as_of');
  const asOf = asOfRaw === undefined ? new Date() : parseDate(asOfRaw);
  if (asOfRaw !== undefined && !asOf)
    return bad(c, '「as_of」はYYYY-MM-DD形式の日付で渡してください。');

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
  const unknown = rejectBadQuery(c, BONUS_TAX_PARAMS);
  if (unknown) return unknown;

  const n = (k: string) => {
    const raw = c.req.query(k);
    if (raw === undefined) return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  };

  const bonus = n('bonus');
  if (bonus === undefined || Number.isNaN(bonus) || bonus < 0)
    return bad(c, 'クエリパラメータ「bonus」は必須で、0以上の数(円)で渡してください。');

  const prev = n('previous_month_pay');
  if (prev === undefined || Number.isNaN(prev) || prev < 0)
    return bad(c, 'クエリパラメータ「previous_month_pay」は必須で、0以上の数で渡してください。',
      '税率は前月の給与から引きます。賞与の額からではありません。');

  const prevIns = n('previous_month_insurance') ?? 0;
  if (Number.isNaN(prevIns) || prevIns < 0)
    return bad(c, '「previous_month_insurance」は0以上の数で渡してください。');
  // 賞与の源泉税は「賞与から社会保険料を控除した額」に率を乗じる。既定を0にすると
  // 課税標準が膨らんで税額が過大になる。独立した批評で、賞与50万・東京・40歳の例で
  // 3,063円の差が実測された。しかもこのパラメータはOpenAPIに載っていなかったので、
  // ドキュメントを読んだ人には存在すら分からなかった。
  //
  // 既定値を捨てて必須にする。金額を返すAPIで「渡さなければ黙って0」は、
  // 渡し忘れた人に間違った額を返し続けることを意味する。
  const bonusInsRaw = c.req.query('bonus_insurance');
  if (bonusInsRaw === undefined)
    return bad(c, '「bonus_insurance」は必須です。',
      '賞与の源泉徴収は、その賞与の社会保険料を控除した後の額にかかります' +
      '(所得税法第186条第2項)。0を既定にすると税額が過大になります。50万円の賞与でおよそ3,000円です。'
      + 'GET /v1/bonus-insurance がその額を計算します。0を渡してよいのは、その賞与に社会保険料が'
      + '実際にかからない場合だけです。');
  const bonusIns = n('bonus_insurance') ?? 0;
  if (Number.isNaN(bonusIns) || bonusIns < 0)
    return bad(c, '「bonus_insurance」は0以上の数で渡してください。');

  const colRaw = (c.req.query('column') ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return bad(c, `該当する column がありません: 「${colRaw}」`, '「kou」か「otsu」を使ってください。');

  const dependants = Number(c.req.query('dependants') ?? '0');
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return bad(c, '「dependants」は0から50の整数で渡してください。');

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
      procedure: '税率は前月の社会保険料控除後の給与から決まります。それをこの賞与の社会保険料控除後の額に掛けます。',
      rounding: '税額は円未満を切り捨てます。',
      not_the_monthly_table: '賞与に月額表は使いません。ここで使えば誤りになります。',
    },
    attribution: BONUS_ATTRIBUTION,
  });
});

app.get('/v1/enums', (c) => {
  const unknownQ = rejectBadQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
  c.json({
    note: 'このAPIが受け付ける値の集合をすべて並べています。400を返されてから知るのではなく、作るときに読めるようにするためのものです。',
    business_type: Object.entries(empins.business_types).map(([k, v]: [string, any]) => ({
      value: k, label_ja: v.label_ja,
    })),
    column: [
      { value: 'kou', label_ja: '甲欄', description: '扶養控除等申告書が提出されています。' },
      { value: 'otsu', label_ja: '乙欄', description: '扶養控除等申告書が提出されていません。' },
    ],
    // The daily table has a third column the monthly table does not.
    daily_column: [
      { value: 'kou', label_ja: '甲欄', description: '扶養控除等申告書が提出されています。' },
      { value: 'otsu', label_ja: '乙欄', description: '扶養控除等申告書が提出されていません。' },
      { value: 'hei', label_ja: '丙欄', description: '日々雇い入れられる人。扶養親族等の控除はありません。' },
    ],
    worker_type: [
      { value: 'general', label_ja: '一般の被保険者', payment_basis_days: 17 },
      {
        value: 'part_time_short_hours', label_ja: '短時間就労者 (パート等)', payment_basis_days: 17,
        description: '通常の労働者より短い時間で働くものの、四分の三基準は満たす人。'
          + '定時決定に限り、17日以上の月が無いときは15〜16日の月を使えます。',
      },
      {
        value: 'short_time_insured', label_ja: '特定適用事業所の短時間労働者', payment_basis_days: 11,
        description: '健康保険法施行規則第24条の2。11日の要件は定時決定・随時改定・休業終了時改定のいずれにも及びます。',
      },
    ],
    fixed_pay_change: [
      { value: 'increase', label_ja: '昇給', description: '固定的賃金が上がった。' },
      { value: 'decrease', label_ja: '降給', description: '固定的賃金が下がった。' },
      { value: 'none', label_ja: '変動なし', description: '非固定的賃金だけが動いた場合です。随時改定にはなりません。' },
    ],
    leave_kind: [
      { value: 'maternity', label_ja: '産前産後休業' },
      { value: 'childcare', label_ja: '育児休業等' },
    ],
    annual_average_type: [
      { value: 'regular', label_ja: '定時決定の年間平均', description: '4〜6月と、6月までの12か月を比べます。' },
      { value: 'revision', label_ja: '随時改定の年間平均', description: '3か月の固定的賃金に、12か月の非固定的賃金を足します。' },
    ],
    detail: [
      { value: 'full', description: '給与明細の全項目。' },
      { value: 'compact', description: '支払額のみ。おおよそ10分の1の大きさになります。' },
    ],
    include: [
      {
        value: 'statute_text',
        description:
          'レスポンスが引用している条項の本文を `statute_text` に添えます。どのエンドポイントでも '
          + '使えます。既定では付きません。多くの利用者が欲しいのは答えであって条文本文ではないためです。',
      },
    ],
    calendar: [
      { value: 'standard', description: '土日と祝日。' },
      { value: 'bank', description: 'Also closed 12/31-1/3, per 銀行法施行令第5条.' },
    ],
    error_codes: [
      { value: 'invalid_request', description: 'パラメータが欠けている、形式が違う、または範囲外です。' },
      { value: 'missing_parameter', description: '必須のパラメータが渡されていません。' },
      { value: 'unknown_prefecture', description: '都道府県を特定できませんでした。' },
      { value: 'unknown_parameter', description: 'このエンドポイントが受け付けないクエリパラメータです。黙って捨てずに拒否します。捨てられたパラメータは、もっともらしい誤った数字を生むためです。' },
      { value: 'out_of_coverage', description: '入力は正しいものの、このAPIが公表している範囲の外です。' },
      { value: 'not_found', description: 'そのエンドポイントはありません。' },
      { value: 'internal_error', description: '想定していない失敗です。' },
    ],
    prefectures: '47件すべては GET /v1/prefectures を見てください。',
  }));
});
app.get('/v1/data-freshness', (c) => {
  const unknownQ = rejectBadQuery(c, ['include'] as const);
  if (unknownQ) return unknownQ;
  return (
  c.json(freshnessReport(new Date())));
});
app.notFound((c) => c.json({ error: 'そのエンドポイントはありません。', code: 'not_found', hint: 'エンドポイントの一覧は GET / を見てください。' }, 404));
app.onError((e, c) => c.json({ error: 'サーバ側で処理に失敗しました。', code: 'internal_error', detail: String(e?.message ?? e) }, 500));

export default app;
