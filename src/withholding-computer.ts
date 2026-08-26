import spec from './data/withholding-computer-r8.json';

/**
 * 電算機計算の特例 — the closed-form alternative to the monthly table.
 *
 * Payroll software is allowed to compute withholding from formulas rather than
 * looking up 月額表, under a Ministry of Finance notice. It applies only to the
 * 甲 column, and only from 令和8年分 onwards.
 *
 * It does not reproduce the table exactly. The difference is intentional and is
 * settled at the year-end adjustment, so callers should pick one method and stay
 * with it rather than mixing them within a year.
 */

type Tier = { to: number | null; fixed?: number; rate?: number; add?: number; subtract?: number };

const T1 = spec.table1_employment_income_deduction.tiers as Tier[];
const T3 = spec.table3_basic_deduction.tiers as Tier[];
const T4 = spec.table4_tax.tiers as Tier[];
const T2 = spec.table2_spouse_and_dependants;

export const COMPUTER_META = spec.meta;

/** Tiers are "以上/以下", so a value equal to `to` stays in that tier. */
function tierFor(tiers: Tier[], v: number): Tier {
  for (const t of tiers) {
    if (t.to === null || v <= t.to) return t;
  }
  return tiers[tiers.length - 1];
}

/** 第1表. 1円未満は切り上げ。 */
export function employmentIncomeDeduction(a: number): number {
  const t = tierFor(T1, a);
  if (t.fixed !== undefined) return t.fixed;
  return Math.ceil(a * (t.rate ?? 0) + (t.add ?? 0));
}

/** 第3表. */
export function basicDeduction(a: number): number {
  return tierFor(T3, a).fixed ?? 0;
}

/** 第4表. 税額は10円未満四捨五入。 */
export function taxFromTaxableIncome(b: number): { tax: number; rate: number; subtract: number } {
  if (b <= 0) return { tax: 0, rate: 0, subtract: 0 };
  const t = tierFor(T4, b);
  const raw = b * (t.rate ?? 0) - (t.subtract ?? 0);
  return { tax: Math.max(0, Math.round(raw / 10) * 10), rate: t.rate ?? 0, subtract: t.subtract ?? 0 };
}

export type ComputerResult = {
  taxable_amount: number;
  has_spouse: boolean;
  dependants: number;
  deductions: {
    employment_income: number;
    spouse: number;
    dependants: number;
    basic: number;
    total: number;
  };
  monthly_taxable_income: number;
  tax: number;
  formula: { rate: number; subtract: number; rounding: string };
};

export function computerMethod(
  amount: number,
  hasSpouse: boolean,
  dependants: number,
): ComputerResult {
  const employment = employmentIncomeDeduction(amount);
  const spouse = hasSpouse ? T2.spouse_deduction : 0;
  const deps = dependants * T2.dependant_deduction_per_person;
  const basic = basicDeduction(amount);
  const total = employment + spouse + deps + basic;

  // 課税給与所得金額 is floored at zero: deductions cannot create a refund here.
  const b = Math.max(0, amount - total);
  const { tax, rate, subtract } = taxFromTaxableIncome(b);

  return {
    taxable_amount: amount,
    has_spouse: hasSpouse,
    dependants,
    deductions: { employment_income: employment, spouse, dependants: deps, basic, total },
    monthly_taxable_income: b,
    tax,
    formula: { rate, subtract, rounding: 'tax rounded to the nearest 10 yen' },
  };
}

export const COMPUTER_ATTRIBUTION = {
  source: COMPUTER_META.source,
  source_url: COMPUTER_META.source_url,
  statute: COMPUTER_META.statute,
  year: COMPUTER_META.year,
  licence: COMPUTER_META.licence,
  attribution_ja: COMPUTER_META.attribution_ja,
  warning_ja: COMPUTER_META.warning_ja,
  applies_to: COMPUTER_META.applies_to,
  note:
    'The 甲 column only. Results differ slightly from the monthly table by design; the difference is settled at the year-end adjustment. Do not mix the two methods within a year.',
};
