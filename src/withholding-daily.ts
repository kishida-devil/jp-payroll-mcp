import data from './data/withholding-daily-r8.json';

/**
 * 給与所得の源泉徴収税額表 日額表 (令和8年分).
 *
 * Same shape as the monthly table with one addition: the 丙 column, for day
 * labourers and short-term hires. 丙 has its own anchors and its own marginal
 * rates above them — it is not a discount applied to 甲 or 乙 — so it is carried
 * as published rather than derived.
 */

type Bracket = { from: number; to: number; kou: number[]; otsu: number; hei: number };
type Anchor = {
  amount: number;
  kou: number[];
  otsu?: number;
  hei?: number;
  kou_rate_above?: number;
  otsu_rate_above?: number;
  hei_rate_above?: number;
  otsu_base_above?: number;
  hei_base_above?: number;
};

const BRACKETS = data.brackets as Bracket[];
const ANCHORS = (data.high_income_anchors as Anchor[]).slice().sort((a, b) => a.amount - b.amount);
const RULES = data.rules;
export const DAILY_META = data.meta;

export const DAILY_MIN = RULES.below_minimum.threshold;
export const DAILY_MAX = BRACKETS[BRACKETS.length - 1].to;
export const DAILY_MAX_DEPENDANTS = RULES.max_dependants_in_table;
export const DAILY_OVER_SEVEN = RULES.dependants_over_seven_deduction;

export type DailyColumn = 'kou' | 'otsu' | 'hei';

const yen = (n: number) => Math.floor(n);

function bracketFor(amount: number): Bracket | null {
  let lo = 0;
  let hi = BRACKETS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = BRACKETS[mid];
    if (amount < b.from) hi = mid - 1;
    else if (amount >= b.to) lo = mid + 1;
    else return b;
  }
  return null;
}

/**
 * The nearest anchor at or below `amount` that carries a value for this column.
 * 乙 and 丙 have fewer anchors than 甲, and borrowing a 甲 anchor would measure
 * the excess from the wrong place.
 */
function anchorFor(amount: number, column: DailyColumn): Anchor {
  const has = (a: Anchor) =>
    column === 'kou' ? a.kou_rate_above !== undefined || a === ANCHORS[ANCHORS.length - 1]
      : column === 'otsu' ? a.otsu !== undefined
      : a.hei !== undefined;
  const eligible = ANCHORS.filter(has);
  let found = eligible[0] ?? ANCHORS[0];
  for (const a of eligible) {
    if (amount >= a.amount) found = a;
    else break;
  }
  return found;
}

export type DailyResult = {
  taxable_amount: number;
  column: DailyColumn;
  dependants: number | null;
  tax: number;
  basis:
    | { kind: 'below_minimum'; threshold: number }
    | { kind: 'table'; bracket: { from: number; to: number } }
    | { kind: 'anchor'; anchor: number; anchor_tax: number; excess: number; rate: number };
  dependants_over_seven?: { count_over: number; deduction_per_person: number; deducted: number };
};

export function dailyWithholdingTax(
  amount: number,
  column: DailyColumn,
  dependants: number,
): DailyResult {
  const base = {
    taxable_amount: amount,
    column,
    dependants: column === 'kou' ? dependants : null,
  };

  if (amount < DAILY_MIN) {
    if (column === 'otsu') {
      // 乙欄の最下段は表に金額が入る（丙・甲は0）。表の先頭区間の値を使う。
      return { ...base, tax: 0, basis: { kind: 'below_minimum', threshold: DAILY_MIN } };
    }
    return { ...base, tax: 0, basis: { kind: 'below_minimum', threshold: DAILY_MIN } };
  }

  let tax: number;
  let basis: DailyResult['basis'];

  const bracket = amount < DAILY_MAX ? bracketFor(amount) : null;
  if (bracket) {
    tax = column === 'kou'
      ? bracket.kou[Math.min(dependants, DAILY_MAX_DEPENDANTS)]
      : column === 'otsu' ? bracket.otsu : bracket.hei;
    basis = { kind: 'table', bracket: { from: bracket.from, to: bracket.to } };
  } else {
    const a = anchorFor(amount, column);
    const anchorTax = column === 'kou'
      ? a.kou[Math.min(dependants, DAILY_MAX_DEPENDANTS)]
      : column === 'otsu' ? (a.otsu_base_above ?? a.otsu ?? 0)
      : (a.hei_base_above ?? a.hei ?? 0);
    const rate = column === 'kou' ? (a.kou_rate_above ?? 0)
      : column === 'otsu' ? (a.otsu_rate_above ?? 0)
      : (a.hei_rate_above ?? 0);
    const excess = amount - a.amount;
    tax = yen(anchorTax + excess * rate);
    basis = { kind: 'anchor', anchor: a.amount, anchor_tax: anchorTax, excess, rate };
  }

  if (column === 'kou' && dependants > DAILY_MAX_DEPENDANTS) {
    const over = dependants - DAILY_MAX_DEPENDANTS;
    const deducted = over * DAILY_OVER_SEVEN;
    return {
      ...base,
      tax: Math.max(0, tax - deducted),
      basis,
      dependants_over_seven: {
        count_over: over, deduction_per_person: DAILY_OVER_SEVEN, deducted,
      },
    };
  }

  return { ...base, tax, basis };
}

export const DAILY_ATTRIBUTION = {
  source: DAILY_META.source,
  source_url: DAILY_META.source_url,
  year: DAILY_META.year,
  licence: DAILY_META.licence,
  attribution_ja: DAILY_META.attribution_ja,
  columns: DAILY_META.columns,
  note:
    '丙欄は日雇いや短期雇用の人に使うもので、独自の基準額と税率を持ちます。扶養親族等が7人を超えると、甲欄では1人につき50円を控除します。月額表の1,610円ではありません。',
};
