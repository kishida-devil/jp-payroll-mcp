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
      '前月に給与の支払いが無いため、税率を引けません。');

  if (prevAfter <= 0)
    return notApplicable('previous_pay_at_or_below_insurance',
      '前月の給与が社会保険料を上回らないため、税率を引けません。');

  const limit = prevAfter * 10;
  if (bonusAfter > limit)
    return notApplicable('bonus_exceeds_ten_times',
      '社会保険料控除後の賞与が、前月の控除後給与の10倍を超えています。この表は使えません。',
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
  // 賞与表の注記5。支給期が月の整数倍なら、直前の給与とその社会保険料を
  // その倍数で割って「前月中の金額」とみなす。このAPIは支給期を知らないので割れない——
  // 注記には書いてあるのに、こちらからは何も言っていなかった。
  // 隔月給の人の額をそのまま渡すと、率が一段上になる。
  note:
    '税率は前月の社会保険料控除後の給与から決まります。税額は、その率をこの賞与の社会保険料控除後の額に掛けたものです。3つの場合は表の範囲外になるため、近似せずそのまま報告します。給与の支給期が月の整数倍(隔月給など)と定められている場合は、直前の給与とその社会保険料をその倍数で割った額を previous_month_pay・previous_month_insurance に渡してください(賞与の算出率表の注記5)。割らずに渡すと率が一段上になります。',
};
