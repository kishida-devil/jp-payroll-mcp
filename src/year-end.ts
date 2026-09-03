/**
 * 年末調整(令和8年分)。
 *
 * バーは国税庁「令和8年分 年末調整のしかた」。給与所得控除後の給与等の金額は
 * 冊子47〜54ページに印刷された表(src/data/year-end-r8.json、1,103行)を引く。
 * 式で再現できる値だが、実務は印刷された表で行うので表を持つ。式は抽出時の検算。
 *
 * 計算の順序と端数処理は源泉徴収簿の欄番号(⑦〜㉗)のとおり。
 *   ⑨ 給与所得控除後の給与等の金額(表。660万円以上は式、1円未満切捨て)
 *   ⑩ 所得金額調整控除(1円未満切上げ、最高150,000円)
 *   ⑪ = ⑨ − ⑩
 *   ⑫〜⑳ 所得控除、㉑ 合計
 *   ㉒ 課税給与所得金額(1,000円未満切捨て)
 *   ㉓ 算出所得税額(速算表)
 *   ㉕ 年調所得税額 = ㉓ − ㉔住宅借入金等特別控除(マイナスは0)
 *   ㉖ 年調年税額 = ㉕ × 102.1%(100円未満切捨て)
 *   ㉗ = ㉖ − ⑧ 徴収税額(マイナスなら超過額 = 還付)
 *
 * 冊子57〜59ページの設例をテストの実物にしている(年調年税額 41,400円、超過額 115,270円)。
 */
import tableR8 from './data/year-end-r8.json';
import tableR7 from './data/year-end-r7.json';

/** 年分ごとの給与所得控除後の表。住民税は前年分の所得で計算するので令和7年分も持つ。 */
const TABLES: Record<number, any> = { 2025: tableR7, 2026: tableR8 };

export type LifeInsurance = {
  new_general?: number; old_general?: number; care_medical?: number;
  new_pension?: number; old_pension?: number;
};
export type EarthquakeInsurance = { earthquake?: number; old_long_term?: number };
export type Dependants = {
  general?: number; specified?: number; elderly?: number; elderly_cohabiting_parent?: number;
  /** 年齢23歳未満の扶養親族の人数。所得金額調整控除と生命保険料控除の特例に効く。 */
  under_23?: number;
};
export type Disabilities = { general?: number; special?: number; special_cohabiting?: number };
export type Flags = {
  widow?: boolean; single_parent?: boolean; working_student?: boolean;
  /** 本人が特別障害者。所得金額調整控除の要件の1つ。 */
  self_special_disabled?: boolean;
};

export type YearEndInput = {
  total_pay: number;
  withheld_tax: number;
  social_insurance: number;
  social_insurance_declared?: number;
  mutual_aid?: number;
  life_insurance?: LifeInsurance;
  earthquake_insurance?: EarthquakeInsurance;
  spouse?: { income: number; age_70_or_over?: boolean } | null;
  dependants?: Dependants;
  disabilities?: Disabilities;
  flags?: Flags;
  specified_relatives?: number[];
  housing_loan_credit?: number;
  other_income?: number;
  /** 所得金額調整控除を適用するか。省略時は要件から判定する。 */
  income_adjustment?: boolean;
};

// ---- 令和8年分の定数(出典: 年末調整のしかた 55〜56ページ、4ページ) ----

/** 年末調整のための算出所得税額の速算表(55ページ)。 */
const TAX_BRACKETS = [
  { upto: 1_950_000, rate: 0.05, subtract: 0 },
  { upto: 3_300_000, rate: 0.10, subtract: 97_500 },
  { upto: 6_950_000, rate: 0.20, subtract: 427_500 },
  { upto: 9_000_000, rate: 0.23, subtract: 636_000 },
  { upto: 18_000_000, rate: 0.33, subtract: 1_536_000 },
  { upto: 18_050_000, rate: 0.40, subtract: 2_796_000 },
] as const;
const MAX_TAXABLE = 18_050_000;
const MAX_PAY = 20_000_000;

/** 基礎控除額の表(56ページ)。合計所得金額の上限 → 控除額。 */
const BASIC_DEDUCTION = [
  { upto: 4_890_000, amount: 1_040_000 },
  { upto: 6_550_000, amount: 670_000 },
  { upto: 23_500_000, amount: 620_000 },
  { upto: 24_000_000, amount: 480_000 },
  { upto: 24_500_000, amount: 320_000 },
  { upto: 25_000_000, amount: 160_000 },
] as const;

/** 配偶者控除額・配偶者特別控除額(55ページ)。列は所得者の合計所得金額 ≤900万 / ≤950万 / ≤1,000万。 */
const SPOUSE_GENERAL = [380_000, 260_000, 130_000] as const;
const SPOUSE_ELDERLY = [480_000, 320_000, 160_000] as const;
const SPOUSE_SPECIAL = [
  { upto: 950_000, amounts: [380_000, 260_000, 130_000] },
  { upto: 1_000_000, amounts: [360_000, 240_000, 120_000] },
  { upto: 1_050_000, amounts: [310_000, 210_000, 110_000] },
  { upto: 1_100_000, amounts: [260_000, 180_000, 90_000] },
  { upto: 1_150_000, amounts: [210_000, 140_000, 70_000] },
  { upto: 1_200_000, amounts: [160_000, 110_000, 60_000] },
  { upto: 1_250_000, amounts: [110_000, 80_000, 40_000] },
  { upto: 1_300_000, amounts: [60_000, 40_000, 20_000] },
  { upto: 1_330_000, amounts: [30_000, 20_000, 10_000] },
] as const;
const SPOUSE_INCOME_THRESHOLD = 620_000;
const OWN_INCOME_LIMIT_FOR_SPOUSE = 10_000_000;

/** 特定親族特別控除額の表(56ページ)。特定親族の合計所得金額の上限 → 控除額。 */
const SPECIFIED_RELATIVE = [
  { upto: 850_000, amount: 630_000 },
  { upto: 900_000, amount: 610_000 },
  { upto: 950_000, amount: 510_000 },
  { upto: 1_000_000, amount: 410_000 },
  { upto: 1_050_000, amount: 310_000 },
  { upto: 1_100_000, amount: 210_000 },
  { upto: 1_150_000, amount: 110_000 },
  { upto: 1_200_000, amount: 60_000 },
  { upto: 1_230_000, amount: 30_000 },
] as const;

/** 扶養控除額等の表(56ページ)。 */
const DEPENDANT_AMOUNTS = {
  general: 380_000, specified: 630_000, elderly: 480_000, elderly_cohabiting_parent: 580_000,
  disabled_general: 270_000, disabled_special: 400_000, disabled_special_cohabiting: 750_000,
  widow: 270_000, single_parent: 350_000, working_student: 270_000,
} as const;

const INCOME_ADJUSTMENT_FROM = 8_500_000;
const INCOME_ADJUSTMENT_CAP_PAY = 10_000_000;
const INCOME_ADJUSTMENT_MAX = 150_000;
const RECONSTRUCTION_RATE = 1.021;

const n0 = (v: number | undefined | null) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const ceil1 = Math.ceil;

// ---- 給与所得控除後の給与等の金額(⑨) ----

export function employmentIncomeAfterDeduction(totalPay: number, year = 2026): { amount: number; how: string } {
  const t = TABLES[year];
  if (!t) throw new Error(`${year}年分の給与所得控除後の表は収録していません。`);
  if (totalPay < t.below_table.zero_below)
    return { amount: 0, how: `${t.below_table.zero_below.toLocaleString()}円未満は0` };
  if (totalPay < t.below_table.subtract_until)
    return { amount: totalPay - t.below_table.subtract, how: `給与等の金額から${t.below_table.subtract.toLocaleString()}円を控除` };
  if (totalPay < t.rows[t.rows.length - 1].to) {
    // 1,103行の二分探索。
    const rows = t.rows as Array<{ from: number; to: number; amount: number }>;
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].to <= totalPay) lo = mid + 1; else hi = mid;
    }
    const r = rows[lo];
    return { amount: r.amount, how: `表の行 ${r.from.toLocaleString()}〜${r.to.toLocaleString()}円` };
  }
  for (const band of t.above_table as Array<{ from: number; to: number; rate: number; subtract: number; note: string }>) {
    if (totalPay < band.to)
      return { amount: Math.floor(totalPay * band.rate - band.subtract), how: band.note };
  }
  return { amount: NaN, how: '20,000,000円以上は年末調整の対象外' };
}

// ---- 生命保険料控除(⑮) ----

const formulaI = (x: number) =>
  x <= 20_000 ? x : x <= 40_000 ? ceil1(x / 2 + 10_000) : x <= 80_000 ? ceil1(x / 4 + 20_000) : 40_000;
const formulaII = (x: number) =>
  x <= 30_000 ? x : x <= 60_000 ? ceil1(x / 2 + 15_000) : x <= 120_000 ? ceil1(x / 4 + 30_000) : 60_000;
const formulaIII = (x: number) =>
  x <= 25_000 ? x : x <= 50_000 ? ceil1(x / 2 + 12_500) : x <= 100_000 ? ceil1(x / 4 + 25_000) : 50_000;

export function lifeInsuranceDeduction(li: LifeInsurance | undefined, hasUnder23: boolean) {
  const newGen = n0(li?.new_general), oldGen = n0(li?.old_general);
  const care = n0(li?.care_medical);
  const newPen = n0(li?.new_pension), oldPen = n0(li?.old_pension);

  // 一般: 新は計算式Ⅰ(23歳未満の扶養親族がいれば計算式Ⅱ)、旧は計算式Ⅲ。
  // 両方あるときは合計(上限4万円、特例なら6万円)。ただし旧だけの額のほうが大きければそちら(注1)。
  const genNew = newGen > 0 ? (hasUnder23 ? formulaII(newGen) : formulaI(newGen)) : 0;
  const genOld = oldGen > 0 ? formulaIII(oldGen) : 0;
  const genCap = hasUnder23 ? 60_000 : 40_000;
  const general = newGen > 0 && oldGen > 0
    ? Math.max(Math.min(genNew + genOld, genCap), hasUnder23 && newGen > 0 ? 0 : genOld)
    : newGen > 0 ? genNew : genOld;

  const careMedical = care > 0 ? formulaI(care) : 0;

  const penNew = newPen > 0 ? formulaI(newPen) : 0;
  const penOld = oldPen > 0 ? formulaIII(oldPen) : 0;
  const pension = newPen > 0 && oldPen > 0
    ? Math.max(Math.min(penNew + penOld, 40_000), penOld)
    : newPen > 0 ? penNew : penOld;

  const total = Math.min(general + careMedical + pension, 120_000);
  return {
    general, care_medical: careMedical, pension, total,
    general_cap: genCap, total_cap: 120_000,
    formula_for_new_general: hasUnder23 ? 'II' : 'I',
  };
}

// ---- 地震保険料控除(⑯) ----

export function earthquakeInsuranceDeduction(ei: EarthquakeInsurance | undefined) {
  const eq = n0(ei?.earthquake), old = n0(ei?.old_long_term);
  const eqPart = Math.min(eq, 50_000);
  const oldPart = old <= 10_000 ? old : old <= 20_000 ? ceil1(old / 2 + 5_000) : 15_000;
  return { earthquake: eqPart, old_long_term: oldPart, total: Math.min(eqPart + oldPart, 50_000), cap: 50_000 };
}

// ---- 配偶者(特別)控除(⑰) ----

export function spouseDeduction(spouse: YearEndInput['spouse'], ownIncome: number) {
  if (!spouse) return { amount: 0, kind: null as null | 'spouse' | 'spouse_special', reason: '配偶者の申告なし' };
  if (ownIncome > OWN_INCOME_LIMIT_FOR_SPOUSE)
    return { amount: 0, kind: null, reason: '所得者の合計所得金額が1,000万円を超えるため、配偶者控除・配偶者特別控除は受けられません。' };
  const col = ownIncome <= 9_000_000 ? 0 : ownIncome <= 9_500_000 ? 1 : 2;
  const inc = n0(spouse.income);
  if (inc <= SPOUSE_INCOME_THRESHOLD)
    return { amount: (spouse.age_70_or_over ? SPOUSE_ELDERLY : SPOUSE_GENERAL)[col], kind: 'spouse' as const,
      reason: spouse.age_70_or_over ? '老人控除対象配偶者' : '控除対象配偶者' };
  for (const band of SPOUSE_SPECIAL)
    if (inc <= band.upto) return { amount: band.amounts[col], kind: 'spouse_special' as const, reason: '配偶者特別控除' };
  return { amount: 0, kind: null, reason: '配偶者の合計所得金額が133万円を超えるため対象外' };
}

// ---- 特定親族特別控除(⑱) ----

export function specifiedRelativeDeduction(incomes: number[] | undefined) {
  const items = (incomes ?? []).map((inc) => {
    const v = n0(inc);
    if (v <= SPOUSE_INCOME_THRESHOLD)
      return { income: v, amount: 0, note: '合計所得金額が62万円以下の19〜22歳は特定扶養親族(扶養控除63万円)として dependants.specified に数えてください。' };
    for (const band of SPECIFIED_RELATIVE) if (v <= band.upto) return { income: v, amount: band.amount };
    return { income: v, amount: 0, note: '合計所得金額が123万円を超えるため対象外' };
  });
  return { items, total: items.reduce((s, x) => s + x.amount, 0) };
}

// ---- 扶養控除額及び障害者等の控除額(⑲) ----

export function dependantsDeduction(d: Dependants | undefined, dis: Disabilities | undefined, f: Flags | undefined) {
  const lines: Array<{ key: string; count: number; each: number; amount: number }> = [];
  const add = (key: string, count: number, each: number) => {
    if (count > 0) lines.push({ key, count, each, amount: count * each });
  };
  add('general', n0(d?.general), DEPENDANT_AMOUNTS.general);
  add('specified', n0(d?.specified), DEPENDANT_AMOUNTS.specified);
  add('elderly', n0(d?.elderly), DEPENDANT_AMOUNTS.elderly);
  add('elderly_cohabiting_parent', n0(d?.elderly_cohabiting_parent), DEPENDANT_AMOUNTS.elderly_cohabiting_parent);
  add('disabled_general', n0(dis?.general), DEPENDANT_AMOUNTS.disabled_general);
  add('disabled_special', n0(dis?.special), DEPENDANT_AMOUNTS.disabled_special);
  add('disabled_special_cohabiting', n0(dis?.special_cohabiting), DEPENDANT_AMOUNTS.disabled_special_cohabiting);
  add('widow', f?.widow ? 1 : 0, DEPENDANT_AMOUNTS.widow);
  add('single_parent', f?.single_parent ? 1 : 0, DEPENDANT_AMOUNTS.single_parent);
  add('working_student', f?.working_student ? 1 : 0, DEPENDANT_AMOUNTS.working_student);
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}

// ---- 基礎控除(⑳) ----

export function basicDeduction(totalIncome: number) {
  for (const band of BASIC_DEDUCTION) if (totalIncome <= band.upto) return band.amount;
  return 0;
}

// ---- 算出所得税額(㉓) ----

export function computedTax(taxable: number) {
  for (const b of TAX_BRACKETS)
    if (taxable <= b.upto) return { amount: Math.floor(taxable * b.rate - b.subtract), rate: b.rate, subtract: b.subtract };
  return { amount: NaN, rate: NaN, subtract: NaN };
}

// ---- 確定申告でしか引けない控除の試算 ----

export type TaxReturnExtras = {
  medical_expenses?: number; medical_reimbursed?: number;
  self_medication?: number;
  donations?: number;
  casualty_loss?: number; disaster_related_expense?: number;
};

/** 確定申告の速算表(所得税法第89条)。年末調整の速算表は1,805万円で終わるが、確定申告は上がある。 */
const RETURN_BRACKETS = [
  { upto: 1_950_000, rate: 0.05, subtract: 0 },
  { upto: 3_300_000, rate: 0.10, subtract: 97_500 },
  { upto: 6_950_000, rate: 0.20, subtract: 427_500 },
  { upto: 9_000_000, rate: 0.23, subtract: 636_000 },
  { upto: 18_000_000, rate: 0.33, subtract: 1_536_000 },
  { upto: 40_000_000, rate: 0.40, subtract: 2_796_000 },
  { upto: Infinity, rate: 0.45, subtract: 4_796_000 },
] as const;

/**
 * 年末調整では引けない控除(医療費・寄附金・雑損)を足したら年税額がいくらになるか。
 * 年末調整の欄には入れない(法律上、確定申告で行うもの)。別枠で「申告したらこうなる」を返す。
 *   医療費控除  所得税法第73条: (支払医療費 − 補填) − min(総所得×5%, 10万円)、最高200万円。
 *               セルフメディケーション税制(措置法第41条の17): 特定一般用医薬品等 − 1.2万円、最高8.8万円。どちらか一方。
 *   寄附金控除  所得税法第78条: min(寄附金, 総所得×40%) − 2,000円。
 *   雑損控除    所得税法第72条: max(損失 − 総所得×10%, 災害関連支出 − 5万円)。
 */
export function taxReturnEstimate(
  extras: TaxReturnExtras, totalIncome: number, afterAdjustment: number,
  yearEndDeductions: number, housingCredit: number, withheld: number,
) {
  const medicalRaw = Math.max(0, n0(extras.medical_expenses) - n0(extras.medical_reimbursed));
  const medical = medicalRaw > 0 ? Math.min(Math.max(medicalRaw - Math.min(totalIncome * 0.05, 100_000), 0), 2_000_000) : 0;
  const selfMed = n0(extras.self_medication) > 12_000 ? Math.min(n0(extras.self_medication) - 12_000, 88_000) : 0;
  const medicalChosen = Math.max(medical, selfMed);
  const donation = n0(extras.donations) > 2_000 ? Math.max(0, Math.min(n0(extras.donations), totalIncome * 0.4) - 2_000) : 0;
  const casualty = Math.max(n0(extras.casualty_loss) - totalIncome * 0.1, n0(extras.disaster_related_expense) - 50_000, 0);
  const extra = medicalChosen + donation + casualty;
  const taxable = Math.floor(Math.max(0, afterAdjustment - yearEndDeductions - extra) / 1000) * 1000;
  const b = RETURN_BRACKETS.find((x) => taxable <= x.upto)!;
  const computed = Math.floor(taxable * b.rate - b.subtract);
  const afterCredit = Math.max(0, computed - housingCredit);
  const annual = Math.floor(afterCredit * RECONSTRUCTION_RATE / 100) * 100;
  return {
    basis: '確定申告をした場合の見込みです。年末調整ではこれらの控除は引けません(所得税法第190条)。',
    extra_deductions: {
      medical_expenses: medical, self_medication: selfMed, medical_applied: medicalChosen,
      medical_note: medical > 0 && selfMed > 0 ? '医療費控除とセルフメディケーション税制は選択適用です。大きい方を当てています。' : undefined,
      donations: donation, casualty_loss: casualty, total: extra,
    },
    taxable_income: taxable, computed_tax: computed, tax_after_credit: afterCredit, annual_tax: annual,
    difference_from_withheld: annual - withheld,
    refund_from_withheld: Math.max(0, withheld - annual),
  };
}

// ---- 本体 ----

export function computeYearEndAdjustment(input: YearEndInput) {
  const totalPay = input.total_pay;
  const notes: string[] = [];

  if (totalPay >= MAX_PAY) {
    return {
      eligible: false as const,
      reason: `給与等の総額が${MAX_PAY.toLocaleString()}円以上の人は年末調整の対象になりません(所得税法第190条)。確定申告で精算します。`,
      total_pay: totalPay,
    };
  }

  // ⑨
  const after = employmentIncomeAfterDeduction(totalPay);

  // ⑩ 所得金額調整控除
  const under23 = n0(input.dependants?.under_23);
  const meets = totalPay > INCOME_ADJUSTMENT_FROM && (
    under23 > 0 || n0(input.disabilities?.special) > 0 || n0(input.disabilities?.special_cohabiting) > 0
    || !!input.flags?.self_special_disabled);
  const applyAdjustment = input.income_adjustment ?? meets;
  let adjustment = 0;
  if (applyAdjustment && totalPay > INCOME_ADJUSTMENT_FROM) {
    adjustment = Math.min(ceil1((Math.min(totalPay, INCOME_ADJUSTMENT_CAP_PAY) - INCOME_ADJUSTMENT_FROM) * 0.1), INCOME_ADJUSTMENT_MAX);
  }
  if (input.income_adjustment === undefined && totalPay > INCOME_ADJUSTMENT_FROM && !meets)
    notes.push('給与等の総額が850万円を超えていますが、23歳未満の扶養親族・特別障害者の要件が渡されていないため、所得金額調整控除は適用していません。該当するなら income_adjustment=true か、dependants.under_23 を渡してください。');

  // ⑪
  const afterAdjustment = after.amount - adjustment;
  const totalIncome = afterAdjustment + n0(input.other_income);

  // ⑫〜⑳
  const socialInsurance = n0(input.social_insurance) + n0(input.social_insurance_declared) + n0(input.mutual_aid);
  const life = lifeInsuranceDeduction(input.life_insurance, under23 > 0);
  const quake = earthquakeInsuranceDeduction(input.earthquake_insurance);
  const spouse = spouseDeduction(input.spouse ?? null, totalIncome);
  const relatives = specifiedRelativeDeduction(input.specified_relatives);
  const deps = dependantsDeduction(input.dependants, input.disabilities, input.flags);
  const basic = basicDeduction(totalIncome);
  if (totalIncome > 25_000_000) notes.push('合計所得金額が2,500万円を超えるため基礎控除はありません。');

  // ㉑
  const totalDeductions = socialInsurance + life.total + quake.total + spouse.amount + relatives.total + deps.total + basic;

  // ㉒
  const taxableRaw = Math.max(0, afterAdjustment - totalDeductions);
  const taxable = Math.floor(taxableRaw / 1000) * 1000;
  if (taxable > MAX_TAXABLE) {
    return {
      eligible: false as const,
      reason: `課税給与所得金額が${MAX_TAXABLE.toLocaleString()}円を超えるため年末調整の対象になりません。`,
      total_pay: totalPay, taxable_income: taxable,
    };
  }

  // ㉓〜㉗
  const tax = computedTax(taxable);
  const housing = n0(input.housing_loan_credit);
  const afterCredit = Math.max(0, tax.amount - housing);
  const annualTax = Math.floor(afterCredit * RECONSTRUCTION_RATE / 100) * 100;
  const difference = annualTax - n0(input.withheld_tax);
  if (housing > tax.amount)
    notes.push(`住宅借入金等特別控除額 ${housing.toLocaleString()}円が算出所得税額を超えています。控除しきれない分は源泉徴収票の「住宅借入金等特別控除可能額」に記載します。`);

  return {
    eligible: true as const,
    year: 2026,
    steps: {
      total_pay: { box: '⑦', amount: totalPay, label: '給与等の総額' },
      withheld_tax: { box: '⑧', amount: n0(input.withheld_tax), label: '徴収税額の合計' },
      after_employment_deduction: { box: '⑨', amount: after.amount, label: '給与所得控除後の給与等の金額', how: after.how },
      income_adjustment: { box: '⑩', amount: adjustment, label: '所得金額調整控除額', applied: adjustment > 0 },
      after_adjustment: { box: '⑪', amount: afterAdjustment, label: '給与所得控除後の給与等の金額(調整控除後)' },
      social_insurance: { box: '⑫〜⑭', amount: socialInsurance, label: '社会保険料等控除額' },
      life_insurance: { box: '⑮', amount: life.total, label: '生命保険料の控除額', detail: life },
      earthquake_insurance: { box: '⑯', amount: quake.total, label: '地震保険料の控除額', detail: quake },
      spouse: { box: '⑰', amount: spouse.amount, label: '配偶者(特別)控除額', kind: spouse.kind, reason: spouse.reason },
      specified_relatives: { box: '⑱', amount: relatives.total, label: '特定親族特別控除額', items: relatives.items },
      dependants: { box: '⑲', amount: deps.total, label: '扶養控除額及び障害者等の控除額の合計額', lines: deps.lines },
      basic: { box: '⑳', amount: basic, label: '基礎控除額', total_income: totalIncome },
      total_deductions: { box: '㉑', amount: totalDeductions, label: '所得控除額の合計額' },
      taxable_income: { box: '㉒', amount: taxable, label: '差引課税給与所得金額(1,000円未満切捨て)', before_rounding: taxableRaw },
      computed_tax: { box: '㉓', amount: tax.amount, label: '算出所得税額', rate: tax.rate, subtract: tax.subtract },
      housing_loan_credit: { box: '㉔', amount: housing, label: '住宅借入金等特別控除額' },
      tax_after_credit: { box: '㉕', amount: afterCredit, label: '年調所得税額' },
      annual_tax: { box: '㉖', amount: annualTax, label: '年調年税額(×102.1%、100円未満切捨て)' },
      difference: { box: '㉗', amount: difference, label: '差引超過額又は不足額(年調年税額 − 徴収税額)' },
    },
    result: {
      annual_tax: annualTax,
      difference,
      settlement: difference < 0 ? 'refund' : difference > 0 ? 'collect' : 'none',
      refund: difference < 0 ? -difference : 0,
      collect: difference > 0 ? difference : 0,
    },
    notes,
    statutes: [
      '所得税法第190条', '所得税法第28条', '所得税法別表第五', '所得税法第86条', '租税特別措置法第41条の16の2',
      '所得税法第83条', '所得税法第83条の2', '所得税法第84条', '所得税法第84条の2', '所得税法第76条', '所得税法第77条',
      '租税特別措置法第41条の3の11', '東日本大震災からの復興のための施策を実施するために必要な財源の確保に関する特別措置法第28条',
    ],
  };
}
