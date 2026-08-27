import { insurance, isLtcInsured, roundEmployeeShare, type PrefKey } from './lib';
import { ageStatus } from './age';

/**
 * 賞与に係る社会保険料.
 *
 * Bonuses attract social insurance as well as withholding tax, on a base of their
 * own: 標準賞与額 is the bonus truncated to the thousand yen, then capped. The two
 * caps work differently and are easy to conflate —
 *
 *   health, long-term care and child support: **5,730,000 per fiscal year**,
 *     cumulative from 1 April to 31 March, so it depends on bonuses already paid
 *   pension and the child-care contribution: **1,500,000 per payment**
 *
 * A caller who only knows this month's bonus cannot apply the annual cap, so the
 * year-to-date figure is an input and the response says whether the cap bit.
 *
 * Source: 全国健康保険協会 保険料額表の備考。
 */

const round2 = (v: number) => Math.round(v * 100) / 100;

export const HEALTH_ANNUAL_CAP = insurance.meta.bonus_cap_health_annual;
export const PENSION_PER_PAYMENT_CAP = insurance.meta.bonus_cap_pension_monthly;

/** 標準賞与額: truncate to the thousand yen. */
export const standardBonus = (bonus: number) => Math.floor(bonus / 1000) * 1000;

export type BonusInsuranceInput = {
  prefecture: PrefKey;
  bonus: number;
  /** 標準賞与額 already counted this fiscal year, for the annual health cap. */
  fiscal_year_to_date: number;
  age: number | null;
  birth_date?: Date | null;
  as_of?: Date;
  /** 賞与の支給日。資格喪失や休業と突き合わせるために要る。 */
  paid_on?: Date | null;
  /** 最終出社日。資格喪失日はその翌日 (健保法36条)。 */
  left_on?: Date | null;
  /** 産休・育休で保険料が免除される期間に当たるか。 */
  leave_exempt?: boolean;
};

const monthKey = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

/**
 * 賞与に保険料がかからない場合を判定する。
 *
 * 資格喪失月に支払われた賞与は対象外になる (健保法156条3項)。喪失日は退職日の
 * 翌日なので、**3月30日退職と3月31日退職で結論が逆になる** — 前者は喪失日が
 * 3月31日で3月が喪失月、後者は4月1日で4月が喪失月。1日の差で数万円動く。
 *
 * 以前はこの判定が無く、退職日を渡しても無視して満額を返していた。月次給与側の
 * /v1/eligibility は同じ判定を正しく行っていたので、同じ法理を片方だけ実装して
 * いたことになる。
 */
function exemptReason(input: BonusInsuranceInput): string | null {
  if (input.leave_exempt)
    return '産前産後休業・育児休業等の期間中に支払われた賞与のため、保険料は免除されます ' +
           '(健康保険法第159条・第159条の3、厚生年金保険法第81条の2・第81条の2の2)。' +
           '育児休業については1か月を超える休業の場合に限ります。';

  if (input.paid_on && input.left_on) {
    const lostOn = new Date(input.left_on.getTime() + 86_400_000);
    if (monthKey(lostOn) === monthKey(input.paid_on))
      return `資格喪失日 (${lostOn.toISOString().slice(0, 10)}) が賞与支給月に属するため、` +
             'この賞与に保険料はかかりません (健康保険法第156条第3項)。' +
             '退職日が1日違えば結論は逆になります。';
  }
  return null;
}

export function bonusInsurance(input: BonusInsuranceInput) {
  const pref = insurance.prefectures[input.prefecture];
  const standard = standardBonus(input.bonus);
  const exempt = exemptReason(input);

  const status = input.birth_date ? ageStatus(input.birth_date, input.as_of ?? new Date()) : null;
  const ltc = status ? status.long_term_care : isLtcInsured(input.age);
  const pensionApplies = status ? status.pension : true;
  const healthApplies = status ? status.health_insurance : true;

  // Annual cap: only the headroom left in the fiscal year is chargeable.
  const headroom = Math.max(0, HEALTH_ANNUAL_CAP - input.fiscal_year_to_date);
  const healthBase = exempt ? 0 : healthApplies ? Math.min(standard, headroom) : 0;
  const pensionBase = exempt ? 0 : pensionApplies ? Math.min(standard, PENSION_PER_PAYMENT_CAP) : 0;

  const item = (total: number) => {
    const employee = roundEmployeeShare(total / 2);
    return { total: round2(total), employee, employer: round2(total - employee) };
  };

  const health = item(healthBase * pref.health_insurance_rate);
  const longTermCare = item(ltc ? healthBase * pref.long_term_care_rate : 0);
  const pension = item(pensionBase * pref.pension_rate);
  const childSupport = item(healthBase * pref.child_support_rate);
  const childCareEmployer = round2(pensionBase * insurance.meta.child_care_contribution_rate);

  const employee = health.employee + longTermCare.employee + pension.employee + childSupport.employee;
  const employer = health.employer + longTermCare.employer + pension.employer +
    childSupport.employer + childCareEmployer;

  return {
    bonus: input.bonus,
    standard_bonus: standard,
    exempt: exempt !== null,
    exempt_reason: exempt,
    paid_on: input.paid_on ? input.paid_on.toISOString().slice(0, 10) : null,
    left_on: input.left_on ? input.left_on.toISOString().slice(0, 10) : null,
    bases: {
      health: healthBase,
      pension: pensionBase,
      health_capped: healthApplies && standard > headroom,
      pension_capped: pensionApplies && standard > PENSION_PER_PAYMENT_CAP,
    },
    caps: {
      health_annual: HEALTH_ANNUAL_CAP,
      health_annual_used_before: input.fiscal_year_to_date,
      health_annual_remaining_after: Math.max(0, headroom - healthBase),
      pension_per_payment: PENSION_PER_PAYMENT_CAP,
      fiscal_year: '4月1日から翌年3月31日まで',
    },
    coverage: { health_insurance: healthApplies, long_term_care: ltc, pension: pensionApplies },
    deductions: {
      health_insurance: health,
      long_term_care: longTermCare,
      pension,
      child_support: childSupport,
      child_care_contribution: { employee: 0, employer: childCareEmployer },
    },
    totals: {
      employee: round2(employee),
      employer: round2(employer),
      combined: round2(employee + employer),
    },
  };
}

export const BONUS_INSURANCE_ATTRIBUTION = {
  source: insurance.meta.source,
  source_url: insurance.meta.source_url,
  licence: insurance.meta.license,
  attribution_ja: '出典：全国健康保険協会（協会けんぽ）保険料額表',
  note:
    '標準賞与額は1,000円未満切り捨て。健康保険・介護保険・子ども子育て支援金は年間573万円(4月1日〜翌3月31日の累計)、厚生年金と拠出金は1回あたり150万円が上限。年間上限は過去の支給実績に依存するため、fiscal_year_to_date を渡さないと適用できない。' +
    ' 資格喪失月に支払われた賞与、および産休・育休期間中の賞与には保険料がかからないため、paid_on と left_on、または leave_exempt を渡さないとその判定ができない。',
};
