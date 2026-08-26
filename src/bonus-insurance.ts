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
};

export function bonusInsurance(input: BonusInsuranceInput) {
  const pref = insurance.prefectures[input.prefecture];
  const standard = standardBonus(input.bonus);

  const status = input.birth_date ? ageStatus(input.birth_date, input.as_of ?? new Date()) : null;
  const ltc = status ? status.long_term_care : isLtcInsured(input.age);
  const pensionApplies = status ? status.pension : true;
  const healthApplies = status ? status.health_insurance : true;

  // Annual cap: only the headroom left in the fiscal year is chargeable.
  const headroom = Math.max(0, HEALTH_ANNUAL_CAP - input.fiscal_year_to_date);
  const healthBase = healthApplies ? Math.min(standard, headroom) : 0;
  const pensionBase = pensionApplies ? Math.min(standard, PENSION_PER_PAYMENT_CAP) : 0;

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
      fiscal_year: '1 April to 31 March',
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
    '標準賞与額は1,000円未満切り捨て。健康保険・介護保険・子ども子育て支援金は年間573万円(4月1日〜翌3月31日の累計)、厚生年金と拠出金は1回あたり150万円が上限。年間上限は過去の支給実績に依存するため、fiscal_year_to_date を渡さないと適用できない。',
};
