/**
 * 産前産後休業・育児休業等 の社会保険料免除.
 *
 * The two leaves look alike and are not:
 *
 *   産休  健保法159条の3 / 厚年法81条の2の2 — exempt from the month the leave
 *         starts to the month **before** the one containing the day after it ends.
 *         No day-count test, and bonuses are exempt unconditionally.
 *
 *   育休  健保法159条 / 厚年法81条の2 — the same rule as 号1, **plus** 号2 added on
 *         1 October 2022: a leave that starts and ends within one month is still
 *         exempt if it covers **14 days or more**. Bonus premiums, however, are
 *         exempt only when the leave exceeds one month.
 *
 * Two consequences catch implementations out. A leave ending mid-month exempts
 * nothing by itself, because the month before the end month is earlier than the
 * start month. And a one-day leave on the last day of a month *is* exempt, since
 * the day after falls in the next month and 号1 applies — the 14-day test never
 * enters into it.
 *
 * Employment insurance is not exempt at all: 労働保険徴収法11条 charges on wages
 * actually paid, and contains no exemption for either leave.
 */

const DAY = 86_400_000;

const monthKey = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const ym = (k: number) => `${String(Math.floor(k / 12)).padStart(4, '0')}-${String((k % 12) + 1).padStart(2, '0')}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const nextDay = (d: Date) => new Date(d.getTime() + DAY);

export type LeaveKind = 'maternity' | 'childcare';

/** 民法143条2項: one month expires on the day before the corresponding date. */
export function oneMonthExpiry(start: Date): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  const lastOfNext = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
  // No corresponding date (31 Jan -> no 31 Feb): the period ends on the last day.
  const corresponding = new Date(Date.UTC(y, m + 1, Math.min(d, lastOfNext)));
  return d <= lastOfNext ? new Date(corresponding.getTime() - DAY) : corresponding;
}

export const exceedsOneMonth = (start: Date, end: Date) =>
  end.getTime() > oneMonthExpiry(start).getTime();

export type LeaveResult = {
  kind: LeaveKind;
  start: string;
  end: string;
  exempt_months: string[];
  rule: 'spans_months' | 'fourteen_days_in_one_month' | 'none';
  days_in_month?: number;
  working_days_excluded?: number;
  exceeds_one_month: boolean;
  bonus_premium_exempt: boolean;
  exempt_premiums: string[];
  not_exempt: string[];
  statutes: string[];
  explanation: string;
};

export function leaveExemption(args: {
  kind: LeaveKind;
  start: Date;
  end: Date;
  /** 出生時育児休業 only: days worked during the leave, already converted to days. */
  workedDays?: number;
}): LeaveResult {
  const { kind, start, end } = args;
  const worked = args.workedDays ?? 0;
  const afterEnd = nextDay(end);
  const startM = monthKey(start);
  const afterM = monthKey(afterEnd);

  const statutes = kind === 'maternity'
    ? ['健康保険法第159条の3', '厚生年金保険法第81条の2の2']
    : ['健康保険法第159条', '厚生年金保険法第81条の2', '健康保険法施行規則第135条第4項'];

  let months: number[] = [];
  let rule: LeaveResult['rule'] = 'none';
  let daysInMonth: number | undefined;
  let explanation: string;

  if (afterM !== startM) {
    // 号1 — the leave crosses a month boundary.
    rule = 'spans_months';
    for (let k = startM; k <= afterM - 1; k++) months.push(k);
    explanation =
      `休業終了日の翌日(${iso(afterEnd)})は ${ym(afterM)} に属するので、免除されるのは ` +
      `${ym(startM)} から ${ym(afterM - 1)} までです。`;
    if (months.length === 0)
      explanation += ' その期間に日が含まれないため、免除される月はありません。';
  } else if (kind === 'childcare') {
    // 号2 — entirely within one month, exempt only if 14 days or more.
    const span = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
    daysInMonth = span - worked;
    rule = daysInMonth >= 14 ? 'fourteen_days_in_one_month' : 'none';
    if (rule === 'fourteen_days_in_one_month') months = [startM];
    explanation =
      `休業は ${ym(startM)} の中で始まり終わっており、${daysInMonth} 日間です` +
      (worked ? `(暦日 ${span} 日から出生時育児休業中に就業した ${worked} 日を引いた日数です)` : '') +
      `。要件は14日なので、この月は${rule === 'none' ? '免除されません' : '免除されます'}。`;
  } else {
    // 産休 within one month: no day-count rule exists, so nothing is exempt.
    explanation =
      `休業は ${ym(startM)} の中で始まり終わっています。産前産後休業に日数要件はありませんが、`
      + `終了月の前月が開始月より前になるため、免除される月はありません。`;
  }

  const overMonth = exceedsOneMonth(start, end);
  // 産休: bonuses are exempt whenever the month is exempt.
  // 育休: only when the leave exceeds one month (健保法159条1項柱書の括弧書).
  const bonusExempt = months.length > 0 && (kind === 'maternity' || overMonth);

  return {
    kind,
    start: iso(start),
    end: iso(end),
    exempt_months: months.map(ym),
    rule,
    ...(daysInMonth !== undefined ? { days_in_month: daysInMonth } : {}),
    ...(worked ? { working_days_excluded: worked } : {}),
    exceeds_one_month: overMonth,
    bonus_premium_exempt: bonusExempt,
    exempt_premiums: [
      '健康保険料', '介護保険料', '子ども・子育て支援金', '厚生年金保険料', '子ども・子育て拠出金',
    ],
    not_exempt: ['雇用保険料 (労働保険徴収法第11条 — 支払われた賃金に対して課され、免除規定がない)'],
    statutes,
    explanation,
  };
}

export const LEAVE_ATTRIBUTION = {
  source: 'e-Gov 法令検索',
  statutes: [
    { name: '健康保険法第159条 / 第159条の3', url: 'https://laws.e-gov.go.jp/law/211AC0000000070' },
    { name: '厚生年金保険法第81条の2 / 第81条の2の2', url: 'https://laws.e-gov.go.jp/law/329AC0000000115' },
    { name: '健康保険法施行規則第135条', url: 'https://laws.e-gov.go.jp/law/215M10000008036' },
    { name: '子ども・子育て支援法第70条', url: 'https://laws.e-gov.go.jp/law/424AC0000000065' },
    { name: '民法第143条', url: 'https://laws.e-gov.go.jp/law/129AC0000000089' },
  ],
  licence: '公共データ利用規約(第1.0版)',
  note:
    '育児休業の14日要件は、2022年10月1日以後に開始した休業に適用されます(令和3年法律第66号)。従業員負担分と事業主負担分の両方が免除されます。賞与保険料の1か月要件は民法143条2項によりますが、当局の説明は「暦日で判断する」までで、境界は個別の事案で確認する価値があります。',
};
