import data from './data/withholding-r8.json';

/**
 * 給与所得の源泉徴収税額表 月額表 (令和8年分).
 *
 * Two things make this easy to get wrong, and both are why the e-Gov version of
 * the same table cannot be used:
 *
 *  - The published figures include the 2.1% reconstruction surtax. 所得税法別表第二
 *    does not, so it is off by a percent or two everywhere (乙 at 105,000–107,000:
 *    3,700 in the statute, 3,800 in practice).
 *  - Above 740,000 the table stops being a table and becomes anchor points with a
 *    marginal rate. The anchors are not collinear — rounding is baked into each —
 *    so the published anchor values have to be carried, not recomputed.
 */

type Bracket = { from: number; to: number; kou: number[]; otsu: number };
type Anchor = {
  amount: number;
  kou: number[];
  otsu?: number;
  kou_rate_above?: number;
  otsu_rate_above?: number;
};

const BRACKETS = data.brackets as Bracket[];
const ANCHORS = (data.high_income_anchors as Anchor[]).slice().sort((a, b) => a.amount - b.amount);
const RULES = data.rules;
export const WITHHOLDING_META = data.meta;

export const TABLE_MIN = RULES.below_minimum.threshold;
export const TABLE_MAX = BRACKETS[BRACKETS.length - 1].to;
export const MAX_DEPENDANTS_IN_TABLE = RULES.max_dependants_in_table;
export const OVER_SEVEN_DEDUCTION = RULES.dependants_over_seven_deduction;

export type Column = 'kou' | 'otsu';

export type WithholdingResult = {
  taxable_amount: number;
  column: Column;
  dependants: number | null;
  tax: number;
  basis:
    | { kind: 'below_minimum'; threshold: number; rate?: number }
    | { kind: 'table'; bracket: { from: number; to: number } }
    | { kind: 'anchor'; anchor: number; anchor_tax: number; excess: number; rate: number };
  dependants_over_seven?: { count_over: number; deduction_per_person: number; deducted: number };
};

/** 円未満は切り捨て。表の値は既に整数なので、按分計算した分だけが対象。 */
const yen = (n: number) => Math.floor(n);

function fromTable(amount: number): Bracket | null {
  // 表は 105,000 以上 740,000 未満。境界は「以上・未満」。
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

/** 直近下のアンカー。740,000 以上でのみ意味を持つ。 */
function anchorFor(amount: number): Anchor {
  let found = ANCHORS[0];
  for (const a of ANCHORS) {
    if (amount >= a.amount) found = a;
    else break;
  }
  return found;
}

export function withholdingTax(
  amount: number,
  column: Column,
  dependants: number,
): WithholdingResult {
  const base: Pick<WithholdingResult, 'taxable_amount' | 'column' | 'dependants'> = {
    taxable_amount: amount,
    column,
    dependants: column === 'kou' ? dependants : null,
  };

  // --- 105,000円未満 ---
  if (amount < TABLE_MIN) {
    if (column === 'otsu') {
      const rate = RULES.below_minimum.otsu_rate;
      return { ...base, tax: yen(amount * rate), basis: { kind: 'below_minimum', threshold: TABLE_MIN, rate } };
    }
    return { ...base, tax: 0, basis: { kind: 'below_minimum', threshold: TABLE_MIN } };
  }

  let tax: number;
  let basis: WithholdingResult['basis'];

  const bracket = amount < TABLE_MAX ? fromTable(amount) : null;
  if (bracket) {
    tax = column === 'otsu'
      ? bracket.otsu
      : bracket.kou[Math.min(dependants, MAX_DEPENDANTS_IN_TABLE)];
    basis = { kind: 'table', bracket: { from: bracket.from, to: bracket.to } };
  } else if (column === 'otsu') {
    // 乙欄のアンカーは 740,000 と 1,710,000 の2点だけ。甲欄のアンカー(790,000等)
    // から超過額を測ると過小になるので、乙欄自身のアンカーを使う。
    const a = otsuAnchorFor(amount);
    const excess = amount - a.amount;
    const rate = a.otsu_rate_above ?? 0;
    tax = yen((a.otsu ?? 0) + excess * rate);
    basis = { kind: 'anchor', anchor: a.amount, anchor_tax: a.otsu ?? 0, excess, rate };
  } else {
    const a = anchorFor(amount);
    const anchorTax = a.kou[Math.min(dependants, MAX_DEPENDANTS_IN_TABLE)];
    const rate = a.kou_rate_above ?? 0;
    const excess = amount - a.amount;
    tax = yen(anchorTax + excess * rate);
    basis = { kind: 'anchor', anchor: a.amount, anchor_tax: anchorTax, excess, rate };
  }

  // --- 扶養親族等が7人を超える場合は1人につき1,610円控除 ---
  if (column === 'kou' && dependants > MAX_DEPENDANTS_IN_TABLE) {
    const over = dependants - MAX_DEPENDANTS_IN_TABLE;
    const deducted = over * OVER_SEVEN_DEDUCTION;
    return {
      ...base,
      tax: Math.max(0, tax - deducted),
      basis,
      dependants_over_seven: {
        count_over: over,
        deduction_per_person: OVER_SEVEN_DEDUCTION,
        deducted,
      },
    };
  }

  return { ...base, tax, basis };
}

/** 乙欄の値を持つアンカーだけを対象に、直近下のものを返す。 */
const OTSU_ANCHORS = ANCHORS.filter((a) => a.otsu !== undefined && a.otsu_rate_above !== undefined);

function otsuAnchorFor(amount: number): Anchor {
  let found = OTSU_ANCHORS[0];
  for (const a of OTSU_ANCHORS) {
    if (amount >= a.amount) found = a;
    else break;
  }
  return found;
}

export const WITHHOLDING_ATTRIBUTION = {
  source: WITHHOLDING_META.source,
  source_url: WITHHOLDING_META.source_url,
  year: WITHHOLDING_META.year,
  licence: WITHHOLDING_META.licence,
  attribution_ja: WITHHOLDING_META.attribution_ja,
  includes_reconstruction_surtax: WITHHOLDING_META.includes_reconstruction_surtax,
  note: WITHHOLDING_META.note,
  scope:
    'Monthly table (月額表) only. The daily table, bonus table and the year-end adjustment tables are not included.',
};
