import data from './data/bonus-r8.json';
import type { Column } from './withholding';

/**
 * 賞与に対する源泉徴収税額の算出率の表.
 *
 * Bonuses are not the monthly table with a different number in it — the whole
 * procedure differs. The rate is looked up from **last month's** pay after social
 * insurance, and then applied to **this bonus** after its own social insurance.
 *
 * The table also has three cases where it must not be used at all (note 4 of the
 * published table). The third one — a bonus more than ten times last month's pay
 * — is easy to miss and produces materially wrong tax on large bonuses, so this
 * module detects all three and says so rather than returning a plausible number.
 */

type Band = { rate: number; from: number; to: number | null };

const KOU = data.kou as Band[][];
const OTSU = data.otsu as Band[];
export const BONUS_META = data.meta;
export const BONUS_EXCEPTIONS = data.table_does_not_apply_when;

const MAX_DEPENDANTS = KOU.length - 1;

function rateFrom(bands: Band[], amount: number): Band {
  for (const b of bands) {
    if (amount >= b.from && (b.to === null || amount < b.to)) return b;
  }
  return bands[bands.length - 1];
}

export type BonusResult =
  | {
      applicable: true;
      previous_month_after_insurance: number;
      bonus_after_insurance: number;
      column: Column;
      dependants: number | null;
      rate: number;
      rate_band: { from: number; to: number | null };
      tax: number;
    }
  | {
      applicable: false;
      reason: string;
      reason_code: 'no_previous_month_pay' | 'previous_pay_at_or_below_insurance' | 'bonus_exceeds_ten_times';
      instead: string;
      previous_month_after_insurance: number;
      bonus_after_insurance: number;
      ten_times_limit?: number;
    };

export function bonusWithholding(args: {
  previousMonthPay: number;
  previousMonthInsurance: number;
  bonus: number;
  bonusInsurance: number;
  column: Column;
  dependants: number;
}): BonusResult {
  const prevAfter = args.previousMonthPay - args.previousMonthInsurance;
  const bonusAfter = args.bonus - args.bonusInsurance;

  const notApplicable = (
    reason_code: 'no_previous_month_pay' | 'previous_pay_at_or_below_insurance' | 'bonus_exceeds_ten_times',
    reason: string,
    extra: Record<string, number> = {},
  ): BonusResult => ({
    applicable: false,
    reason,
    reason_code,
    instead: BONUS_EXCEPTIONS.instead_use,
    previous_month_after_insurance: prevAfter,
    bonus_after_insurance: bonusAfter,
    ...extra,
  });

  if (args.previousMonthPay <= 0)
    return notApplicable('no_previous_month_pay',
      'There was no pay in the previous month, so the rate cannot be looked up.');

  if (prevAfter <= 0)
    return notApplicable('previous_pay_at_or_below_insurance',
      'Last month’s pay did not exceed its social insurance, so the rate cannot be looked up.');

  const limit = prevAfter * 10;
  if (bonusAfter > limit)
    return notApplicable('bonus_exceeds_ten_times',
      'The bonus after social insurance is more than ten times last month’s pay after social insurance, so this table must not be used.',
      { ten_times_limit: limit });

  const bands = args.column === 'otsu' ? OTSU : KOU[Math.min(args.dependants, MAX_DEPENDANTS)];
  const band = rateFrom(bands, prevAfter);
  // 賞与の源泉徴収税額に円未満の端数があるときは切り捨てる。
  const tax = Math.floor(bonusAfter * band.rate);

  return {
    applicable: true,
    previous_month_after_insurance: prevAfter,
    bonus_after_insurance: bonusAfter,
    column: args.column,
    dependants: args.column === 'kou' ? args.dependants : null,
    rate: band.rate,
    rate_band: { from: band.from, to: band.to },
    tax,
  };
}

export const BONUS_ATTRIBUTION = {
  source: BONUS_META.source,
  source_url: BONUS_META.source_url,
  statute: BONUS_META.statute,
  year: BONUS_META.year,
  licence: BONUS_META.licence,
  attribution_ja: BONUS_META.attribution_ja,
  method_ja: BONUS_META.method,
  note:
    'The rate comes from last month’s pay after social insurance; the tax is that rate applied to this bonus after its own social insurance. Three cases fall outside the table entirely and are reported rather than approximated.',
};
