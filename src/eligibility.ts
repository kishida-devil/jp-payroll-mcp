import { parseDate } from './age';

/**
 * Which months social insurance is charged for when someone joins or leaves.
 *
 * Three statutory rules combine into one counter-intuitive result:
 *
 *   健康保険法第36条    eligibility is lost on the day **after** the last day worked
 *   健康保険法第156条3項 no premium is assessed for the month eligibility is lost
 *   健康保険法第167条    the employer deducts the **previous** month's premium
 *
 * So leaving on 30 March means eligibility is lost on 31 March, March is the
 * month of loss, and no March premium is due. Leaving one day later, on 31
 * March, moves the loss to 1 April — and March becomes payable after all.
 * Payroll teams know this as the 月末退職 rule; implementations that compare
 * only year and month get it backwards.
 *
 * Employment insurance is different again: it is charged on pay actually made,
 * so it applies to any month in which wages are paid, regardless of these dates.
 */

const DAY = 86_400_000;
const monthKey = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const ym = (d: Date) => d.toISOString().slice(0, 7);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export type Eligibility = {
  month: string;
  joined_on: string | null;
  left_on: string | null;
  /** 資格喪失日 = the day after the last day worked. */
  eligibility_lost_on: string | null;
  social_insurance_due: boolean;
  employment_insurance_due: boolean;
  reason: string;
  statutes: string[];
};

export function eligibilityFor(args: {
  month: Date;
  joined?: Date | null;
  left?: Date | null;
}): Eligibility {
  const m = monthKey(args.month);
  const joined = args.joined ?? null;
  const left = args.left ?? null;
  const lostOn = left ? new Date(left.getTime() + DAY) : null;

  const statutes = [
    '健康保険法第36条 (資格喪失は退職日の翌日)',
    '健康保険法第156条第3項 (資格喪失月の保険料は算定しない)',
    '健康保険法第167条 (事業主は前月分の保険料を控除)',
  ];

  const base = {
    month: ym(args.month),
    joined_on: joined ? iso(joined) : null,
    left_on: left ? iso(left) : null,
    eligibility_lost_on: lostOn ? iso(lostOn) : null,
    statutes,
  };

  // Not yet employed.
  if (joined && monthKey(joined) > m)
    return {
      ...base, social_insurance_due: false, employment_insurance_due: false,
      reason: 'Employment had not started in this month.',
    };

  // Already gone: eligibility was lost in an earlier month.
  if (lostOn && monthKey(lostOn) < m)
    return {
      ...base, social_insurance_due: false,
      employment_insurance_due: false,
      reason: 'Eligibility was lost before this month.',
    };

  // The month eligibility is lost: no premium (156条3項).
  if (lostOn && monthKey(lostOn) === m)
    return {
      ...base, social_insurance_due: false,
      // Wages for the final days worked are still wages.
      employment_insurance_due: !!left && monthKey(left) === m,
      reason:
        `Eligibility is lost on ${iso(lostOn)}, which falls in this month, so no social insurance premium is assessed (健康保険法第156条第3項). ` +
        (left && left.getUTCDate() === lastDayOfMonth(left)
          ? 'Note: leaving on the last day of a month pushes the loss into the next month, which is why the previous month is still payable.'
          : 'Leaving one day later, on the last day of the month, would have made this month payable.'),
    };

  // Joined this month, or an ordinary month in between.
  const joinedThisMonth = joined && monthKey(joined) === m;
  return {
    ...base,
    social_insurance_due: true,
    employment_insurance_due: true,
    reason: joinedThisMonth
      ? `Eligibility begins on ${iso(joined!)}; the premium is due for the whole month regardless of the day joined.`
      : 'An ordinary month of employment.',
  };
}

function lastDayOfMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export const ELIGIBILITY_ATTRIBUTION = {
  source: 'e-Gov 法令検索',
  statutes: [
    { name: '健康保険法第36条', url: 'https://laws.e-gov.go.jp/law/211AC0000000070' },
    { name: '健康保険法第156条', url: 'https://laws.e-gov.go.jp/law/211AC0000000070' },
    { name: '健康保険法第167条', url: 'https://laws.e-gov.go.jp/law/211AC0000000070' },
  ],
  licence: '公共データ利用規約(第1.0版)',
  note:
    'Social insurance is charged for the month eligibility begins and every month up to but not including the month it is lost. Employment insurance follows the wages actually paid, so it is judged separately.',
};

export { parseDate };
