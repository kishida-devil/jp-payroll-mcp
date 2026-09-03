/**
 * 個人住民税(道府県民税 + 市町村民税)の見込み額。
 *
 * **額を決めるのは市区町村で、給与担当は特別徴収税額通知書の額を控除する。**
 * ここで返すのは、地方税法の標準税率と各自治体が公表している超過課税・減税から
 * 計算した見込み額であり、決定通知書の代わりではない。応答にそう書く。
 *
 * 前年(1〜12月)の所得に対して翌年度に課税される。income_year=2025 なら令和8年度分。
 *
 * 出典:
 *   税率      地方税法第35条・第38条・第310条・第314条の3(標準税率)、
 *             指定都市は2%/8%(県費負担教職員の税源移譲)。総務省「個人住民税」。
 *   超過課税  総務省「超過課税の状況」(令和7年4月1日現在: 個人均等割37団体、所得割1団体、市2団体)と
 *             各自治体の公表額。src/data/resident-tax.json。
 *   所得控除  地方税法第34条・第314条の2(住民税の額は所得税と違う: 基礎控除43万円、配偶者33万円、
 *             扶養33万円、生命保険料控除 上限7万円、地震保険料控除 上限2.5万円)。
 *   調整控除  地方税法第37条・第314条の6(人的控除の差額の5%、最低2,500円)。
 *   非課税    地方税法第24条の5・第295条、同施行令第47条の3(35万円×人数+10万円+21万円、級地率)。
 *   寄附金    地方税法第37条の2・第314条の7(基本控除10%、ふるさと納税の特例控除は所得割の20%まで)。
 *   住宅ローン 地方税法附則第5条の4の2(所得税から控除しきれない額、課税総所得の5%または7%)。
 *   給与所得  国税庁の年末調整のしかた(令和7年分・8年分)の給与所得控除後の給与等の金額の表。
 */
import rt from './data/resident-tax.json';
import { employmentIncomeAfterDeduction, type Dependants, type Disabilities, type Flags } from './year-end';
import type { PrefKey } from './lib';

export type ResidentTaxInput = {
  prefecture: PrefKey;
  prefecture_ja: string;
  city?: string | null;
  designated_city?: boolean;
  grade_level?: 1 | 2 | 3;
  income_year: 2025 | 2026;
  salary?: number | null;
  total_income?: number | null;
  other_income?: number;
  social_insurance?: number;
  mutual_aid?: number;
  life_insurance?: { new_general?: number; old_general?: number; care_medical?: number; new_pension?: number; old_pension?: number };
  earthquake_insurance?: { earthquake?: number; old_long_term?: number };
  medical_expenses?: number;
  medical_reimbursed?: number;
  casualty_loss?: number;
  disaster_related_expense?: number;
  spouse?: { income: number; age_70_or_over?: boolean } | null;
  dependants?: Dependants & { under_16?: number };
  disabilities?: Disabilities;
  flags?: Flags & { minor?: boolean; single_parent_father?: boolean };
  specified_relatives?: number[];
  income_adjustment?: boolean;
  furusato_donations?: number;
  other_donations?: number;
  housing_loan_unused?: number;
  housing_loan_cap?: 'five_percent' | 'seven_percent';
};

const n0 = (v: number | undefined | null) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const floor100 = (v: number) => Math.floor(v / 100) * 100;
const floor1000 = (v: number) => Math.floor(v / 1000) * 1000;

// ---- 住民税の所得控除(地方税法第34条) ----

const RT_BASIC = [
  { upto: 24_000_000, amount: 430_000 },
  { upto: 24_500_000, amount: 290_000 },
  { upto: 25_000_000, amount: 150_000 },
] as const;
const RT_SPOUSE_GENERAL = [330_000, 220_000, 110_000] as const;
const RT_SPOUSE_ELDERLY = [380_000, 260_000, 130_000] as const;
const RT_SPOUSE_SPECIAL = [
  { upto: 1_000_000, amounts: [330_000, 220_000, 110_000] },
  { upto: 1_050_000, amounts: [310_000, 210_000, 110_000] },
  { upto: 1_100_000, amounts: [260_000, 180_000, 90_000] },
  { upto: 1_150_000, amounts: [210_000, 140_000, 70_000] },
  { upto: 1_200_000, amounts: [160_000, 110_000, 60_000] },
  { upto: 1_250_000, amounts: [110_000, 80_000, 40_000] },
  { upto: 1_300_000, amounts: [60_000, 40_000, 20_000] },
  { upto: 1_330_000, amounts: [30_000, 20_000, 10_000] },
] as const;
const RT_SPOUSE_INCOME_THRESHOLD = 580_000;
/** 令和8年度からの特定親族特別控除(住民税)。名古屋市「令和8年度以降適用される税制改正」で確認。 */
const RT_SPECIFIED_RELATIVE = [
  { upto: 950_000, amount: 450_000 },
  { upto: 1_000_000, amount: 410_000 },
  { upto: 1_050_000, amount: 310_000 },
  { upto: 1_100_000, amount: 210_000 },
  { upto: 1_150_000, amount: 110_000 },
  { upto: 1_200_000, amount: 60_000 },
  { upto: 1_230_000, amount: 30_000 },
] as const;
const RT_DEP = {
  general: 330_000, specified: 450_000, elderly: 380_000, elderly_cohabiting_parent: 450_000,
  disabled_general: 260_000, disabled_special: 300_000, disabled_special_cohabiting: 530_000,
  widow: 260_000, single_parent: 300_000, working_student: 260_000,
} as const;

/** 調整控除に使う「所得税と住民税の人的控除の差」(地方税法第37条)。 */
const DIFF = {
  basic: 50_000,
  spouse_general: [50_000, 40_000, 20_000], spouse_elderly: [100_000, 60_000, 30_000],
  spouse_special_upto_950k: [50_000, 40_000, 20_000], spouse_special_upto_1m: [30_000, 20_000, 10_000],
  general: 50_000, specified: 180_000, elderly: 100_000, elderly_cohabiting_parent: 130_000,
  disabled_general: 10_000, disabled_special: 100_000, disabled_special_cohabiting: 220_000,
  widow: 10_000, single_parent_mother: 50_000, single_parent_father: 10_000, working_student: 10_000,
} as const;

// 生命保険料控除(住民税): 新 上限2.8万円、旧 上限3.5万円、合計 上限7万円。
const rtNew = (x: number) => x <= 12_000 ? x : x <= 32_000 ? Math.ceil(x / 2 + 6_000) : x <= 56_000 ? Math.ceil(x / 4 + 14_000) : 28_000;
const rtOld = (x: number) => x <= 15_000 ? x : x <= 40_000 ? Math.ceil(x / 2 + 7_500) : x <= 70_000 ? Math.ceil(x / 4 + 17_500) : 35_000;

function rtLifeInsurance(li: ResidentTaxInput['life_insurance']) {
  const pair = (nw: number, old: number) => {
    const a = nw > 0 ? rtNew(nw) : 0, b = old > 0 ? rtOld(old) : 0;
    return nw > 0 && old > 0 ? Math.max(Math.min(a + b, 28_000), b) : nw > 0 ? a : b;
  };
  const general = pair(n0(li?.new_general), n0(li?.old_general));
  const care = n0(li?.care_medical) > 0 ? rtNew(n0(li?.care_medical)) : 0;
  const pension = pair(n0(li?.new_pension), n0(li?.old_pension));
  return { general, care_medical: care, pension, total: Math.min(general + care + pension, 70_000), cap: 70_000 };
}

function rtEarthquake(ei: ResidentTaxInput['earthquake_insurance']) {
  const eq = Math.min(Math.ceil(n0(ei?.earthquake) / 2), 25_000);
  const old = n0(ei?.old_long_term);
  const oldPart = old <= 5_000 ? old : old <= 15_000 ? Math.ceil(old / 2 + 2_500) : 10_000;
  return { earthquake: eq, old_long_term: oldPart, total: Math.min(eq + oldPart, 25_000), cap: 25_000 };
}

// ---- 本体 ----

export function computeResidentTax(input: ResidentTaxInput) {
  const notes: string[] = [];
  const fiscalYear = input.income_year + 1;

  // 給与所得(前年分の表)、または渡された合計所得。
  let employmentIncome = 0;
  let how = '';
  if (input.salary !== undefined && input.salary !== null) {
    const r = employmentIncomeAfterDeduction(input.salary, input.income_year);
    employmentIncome = Number.isNaN(r.amount) ? 0 : r.amount;
    how = r.how;
    if (Number.isNaN(r.amount)) notes.push('給与等の金額が2,000万円以上です。給与所得控除は195万円で計算します(年末調整の対象外という意味で表が終わっているだけで、住民税の給与所得は同じ式です)。');
    if (Number.isNaN(r.amount)) employmentIncome = input.salary - 1_950_000;
  }
  const under23 = n0(input.dependants?.under_23);
  const totalGross = employmentIncome + n0(input.total_income) + n0(input.other_income);

  // 所得金額調整控除(所得税と同じ)。
  const meets = input.salary != null && input.salary > 8_500_000 && (
    under23 > 0 || n0(input.disabilities?.special) > 0 || n0(input.disabilities?.special_cohabiting) > 0 || !!input.flags?.self_special_disabled);
  let adjustment = 0;
  if ((input.income_adjustment ?? meets) && input.salary != null && input.salary > 8_500_000)
    adjustment = Math.min(Math.ceil((Math.min(input.salary, 10_000_000) - 8_500_000) * 0.1), 150_000);
  const totalIncome = totalGross - adjustment;   // 合計所得金額(見込み)

  // 人数(非課税判定用)。同一生計配偶者は所得58万円以下。
  const spouseCounts = !!input.spouse && n0(input.spouse.income) <= RT_SPOUSE_INCOME_THRESHOLD;
  const depCount = n0(input.dependants?.general) + n0(input.dependants?.specified) + n0(input.dependants?.elderly)
    + n0(input.dependants?.elderly_cohabiting_parent) + n0(input.dependants?.under_16);
  const persons = 1 + (spouseCounts ? 1 : 0) + depCount;
  const hasDeps = persons > 1;

  // 非課税限度額。級地は均等割にだけ効く(施行令第47条の3)。
  const level = input.grade_level ?? 1;
  const rate = level === 1 ? 1.0 : level === 2 ? 0.9 : 0.8;
  const perCapitaLimit = hasDeps ? Math.round(350_000 * rate) * persons + 100_000 + Math.round(210_000 * rate) : Math.round(350_000 * rate) + 100_000;
  const incomeLimit = hasDeps ? 350_000 * persons + 100_000 + 320_000 : 450_000;
  const specialStatus = !!(input.flags?.widow || input.flags?.single_parent || input.flags?.minor
    || n0(input.disabilities?.general) + n0(input.disabilities?.special) + n0(input.disabilities?.special_cohabiting) > 0);
  const exemptAll = specialStatus && totalIncome <= 1_350_000;
  const exemptPerCapita = exemptAll || totalIncome <= perCapitaLimit;
  const exemptIncome = exemptAll || totalGross <= incomeLimit;
  if (!input.grade_level) notes.push('均等割の非課税限度額は自治体の級地(1〜3級地)で変わります。grade_level を渡していないので1級地(35万円・21万円)で判定しています。');
  if (specialStatus && exemptAll) notes.push('障害者・未成年者・寡婦・ひとり親で合計所得金額135万円以下のため、均等割・所得割ともに非課税です。');

  // 所得控除(住民税の額)。
  const social = n0(input.social_insurance) + n0(input.mutual_aid);
  const life = rtLifeInsurance(input.life_insurance);
  const quake = rtEarthquake(input.earthquake_insurance);
  const medicalRaw = n0(input.medical_expenses) - n0(input.medical_reimbursed);
  const medical = medicalRaw > 0 ? Math.min(Math.max(medicalRaw - Math.min(totalIncome * 0.05, 100_000), 0), 2_000_000) : 0;
  const casualty = Math.max(n0(input.casualty_loss) - totalIncome * 0.1, n0(input.disaster_related_expense) - 50_000, 0);

  const col = totalIncome <= 9_000_000 ? 0 : totalIncome <= 9_500_000 ? 1 : 2;
  let spouseAmount = 0, spouseDiff = 0, spouseKind: null | 'spouse' | 'spouse_special' = null;
  if (input.spouse && totalIncome <= 10_000_000) {
    const inc = n0(input.spouse.income);
    if (inc <= RT_SPOUSE_INCOME_THRESHOLD) {
      spouseAmount = (input.spouse.age_70_or_over ? RT_SPOUSE_ELDERLY : RT_SPOUSE_GENERAL)[col];
      spouseDiff = (input.spouse.age_70_or_over ? DIFF.spouse_elderly : DIFF.spouse_general)[col];
      spouseKind = 'spouse';
    } else {
      for (const b of RT_SPOUSE_SPECIAL) if (inc <= b.upto) { spouseAmount = b.amounts[col]; spouseKind = 'spouse_special'; break; }
      spouseDiff = inc <= 950_000 ? DIFF.spouse_special_upto_950k[col] : inc <= 1_000_000 ? DIFF.spouse_special_upto_1m[col] : 0;
    }
  }
  const relatives = (input.specified_relatives ?? []).map((v): number => {
    for (const b of RT_SPECIFIED_RELATIVE) if (v > RT_SPOUSE_INCOME_THRESHOLD && v <= b.upto) return b.amount;
    return 0;
  }).reduce((s, x) => s + x, 0);

  const d = input.dependants, dis = input.disabilities, f = input.flags;
  const lines: Array<{ key: string; count: number; each: number; amount: number; diff: number }> = [];
  const add = (key: keyof typeof RT_DEP, count: number, diffEach: number) => {
    if (count > 0) lines.push({ key, count, each: RT_DEP[key], amount: count * RT_DEP[key], diff: count * diffEach });
  };
  add('general', n0(d?.general), DIFF.general);
  add('specified', n0(d?.specified), DIFF.specified);
  add('elderly', n0(d?.elderly), DIFF.elderly);
  add('elderly_cohabiting_parent', n0(d?.elderly_cohabiting_parent), DIFF.elderly_cohabiting_parent);
  add('disabled_general', n0(dis?.general), DIFF.disabled_general);
  add('disabled_special', n0(dis?.special), DIFF.disabled_special);
  add('disabled_special_cohabiting', n0(dis?.special_cohabiting), DIFF.disabled_special_cohabiting);
  add('widow', f?.widow ? 1 : 0, DIFF.widow);
  add('single_parent', f?.single_parent ? 1 : 0, f?.single_parent_father ? DIFF.single_parent_father : DIFF.single_parent_mother);
  add('working_student', f?.working_student ? 1 : 0, DIFF.working_student);
  const depTotal = lines.reduce((s, l) => s + l.amount, 0);
  const depDiff = lines.reduce((s, l) => s + l.diff, 0);

  let basic = 0;
  for (const b of RT_BASIC) if (totalIncome <= b.upto) { basic = b.amount; break; }
  const basicDiff = totalIncome <= 24_000_000 ? DIFF.basic : 0;

  const totalDeductions = social + life.total + quake.total + medical + casualty + spouseAmount + relatives + depTotal + basic;
  const taxable = floor1000(Math.max(0, totalIncome - totalDeductions));

  // 税率。指定都市は 2%/8%。超過課税と減税を当てる。
  const surtax = (rt.prefectural_surtax as any)[input.prefecture] ?? { per_capita: 0, income_rate: 0, name: null };
  const designated = !!input.designated_city || (!!input.city && (rt.designated_cities as string[]).includes(input.city));
  const cityOverride = input.city ? (rt.city_overrides as any)[input.city] : undefined;
  const prefRateBase = designated ? rt.standard.income_rate_designated_city.prefectural : rt.standard.income_rate.prefectural;
  const muniRateBase = designated ? rt.standard.income_rate_designated_city.municipal : rt.standard.income_rate.municipal;
  const prefRate = prefRateBase + n0(surtax.income_rate);
  const muniRate = cityOverride?.municipal_income_rate ?? muniRateBase;

  // 所得割(調整控除前)。
  const prefIncomeTaxRaw = taxable * prefRate;
  const muniIncomeTaxRaw = taxable * muniRate;

  // 調整控除(第37条・第314条の6)。
  const diffTotal = basicDiff + spouseDiff + depDiff;
  let adjustmentCredit = 0;
  if (totalIncome <= 25_000_000 && taxable > 0) {
    adjustmentCredit = taxable <= 2_000_000
      ? Math.min(diffTotal, taxable) * 0.05
      : Math.max((diffTotal - (taxable - 2_000_000)) * 0.05, 2_500);
  }
  const prefShare = designated ? 1 / 5 : 2 / 5;
  const muniShare = 1 - prefShare;
  const prefAfterAdj = Math.max(0, prefIncomeTaxRaw - adjustmentCredit * prefShare);
  const muniAfterAdj = Math.max(0, muniIncomeTaxRaw - adjustmentCredit * muniShare);
  const incomeTaxAfterAdj = prefAfterAdj + muniAfterAdj;

  // 寄附金税額控除(第37条の2・第314条の7)。
  const furusato = n0(input.furusato_donations), otherDon = n0(input.other_donations);
  const donationBase = Math.min(furusato + otherDon, totalIncome * 0.3);
  const basicCredit = donationBase > 2_000 ? (donationBase - 2_000) * 0.10 : 0;
  // 特例控除の所得税率は「課税総所得金額 − 人的控除差調整額」で見る(総務省の計算方法)。
  const rateBase = Math.max(0, taxable - diffTotal);
  const itRate = rateBase <= 1_950_000 ? 0.05 : rateBase <= 3_300_000 ? 0.10 : rateBase <= 6_950_000 ? 0.20
    : rateBase <= 9_000_000 ? 0.23 : rateBase <= 18_000_000 ? 0.33 : rateBase <= 40_000_000 ? 0.40 : 0.45;
  let specialCredit = 0;
  if (furusato > 2_000) {
    specialCredit = Math.min((furusato - 2_000) * (0.9 - itRate * 1.021), incomeTaxAfterAdj * 0.2);
  }
  const donationCredit = basicCredit + specialCredit;

  // 住宅借入金等特別税額控除(附則第5条の4の2)。
  const capRate = input.housing_loan_cap === 'seven_percent' ? 0.07 : 0.05;
  const capMax = input.housing_loan_cap === 'seven_percent' ? 136_500 : 97_500;
  const housingCredit = Math.min(n0(input.housing_loan_unused), Math.min(taxable * capRate, capMax));

  const creditsTotal = donationCredit + housingCredit;
  const prefIncomeTax = exemptIncome ? 0 : floor100(Math.max(0, prefAfterAdj - creditsTotal * prefShare));
  const muniIncomeTax = exemptIncome ? 0 : floor100(Math.max(0, muniAfterAdj - creditsTotal * muniShare));

  // 均等割。
  const prefPerCapita = exemptPerCapita ? 0 : rt.standard.per_capita.prefectural + n0(surtax.per_capita);
  const muniPerCapitaBase = cityOverride?.per_capita_municipal ?? rt.standard.per_capita.municipal;
  const muniPerCapita = exemptPerCapita ? 0 : muniPerCapitaBase + n0(cityOverride?.per_capita_municipal_extra);
  const forest = exemptPerCapita ? 0 : rt.standard.per_capita.forest_environment_tax;

  const annual = prefIncomeTax + muniIncomeTax + prefPerCapita + muniPerCapita + forest;
  // 特別徴収は12回。100円未満の端数は6月分にまとめる(地方税法第321条の5)。
  const monthly = floor100(annual / 12);
  const june = annual - monthly * 11;

  if (surtax.per_capita > 0 || surtax.income_rate > 0)
    notes.push(`${input.prefecture_ja}の超過課税「${surtax.name}」(均等割 +${surtax.per_capita.toLocaleString()}円${surtax.income_rate ? `、所得割 +${(surtax.income_rate * 100).toFixed(3)}%` : ''})を含めています。`);
  if (cityOverride) notes.push(`${input.city}の「${cityOverride.name}」を当てています。`);
  if (input.city && !cityOverride && !designated) notes.push(`${input.city}固有の超過課税は収録していません(総務省の一覧では市町村の超過課税は横浜市と神戸市の2団体)。標準税率で計算しています。`);
  if (!input.city) notes.push('市区町村を渡していないので、市町村民税は標準税率(6%・3,000円)で計算しています。指定都市に住む人は designated_city=true か city を渡してください(2%/8%に変わります。合計10%は同じ)。');

  return {
    estimate: true as const,
    fiscal_year: fiscalYear,
    income_year: input.income_year,
    prefecture: input.prefecture, prefecture_ja: input.prefecture_ja, city: input.city ?? null, designated_city: designated,
    income: {
      salary: input.salary ?? null, employment_income: employmentIncome, how,
      income_adjustment: adjustment, other_income: n0(input.other_income) + n0(input.total_income),
      total_income: totalIncome,
    },
    exemption: {
      per_capita_exempt: exemptPerCapita, income_exempt: exemptIncome,
      per_capita_limit: perCapitaLimit, income_limit: incomeLimit, persons, grade_level: level,
      special_status_135: specialStatus ? exemptAll : null,
    },
    deductions: {
      social_insurance: social, life_insurance: life, earthquake_insurance: quake,
      medical_expenses: medical, casualty_loss: casualty,
      spouse: { amount: spouseAmount, kind: spouseKind }, specified_relatives: relatives,
      dependants: { lines, total: depTotal }, basic, total: totalDeductions,
    },
    taxable_income: taxable,
    rates: {
      prefectural_income: prefRate, municipal_income: muniRate,
      prefectural_per_capita: rt.standard.per_capita.prefectural + n0(surtax.per_capita),
      municipal_per_capita: muniPerCapitaBase + n0(cityOverride?.per_capita_municipal_extra),
      forest_environment_tax: rt.standard.per_capita.forest_environment_tax,
      surtax: surtax.per_capita > 0 || surtax.income_rate > 0 ? { name: surtax.name, per_capita: surtax.per_capita, income_rate: surtax.income_rate } : null,
      city_override: cityOverride ?? null,
    },
    income_levy: {
      before_credits: { prefectural: Math.floor(prefIncomeTaxRaw), municipal: Math.floor(muniIncomeTaxRaw) },
      adjustment_credit: { total: Math.floor(adjustmentCredit), personal_deduction_gap: diffTotal },
      donation_credit: { basic: Math.floor(basicCredit), furusato_special: Math.floor(specialCredit), cap_special: Math.floor(incomeTaxAfterAdj * 0.2), income_tax_rate_used: itRate },
      housing_loan_credit: Math.floor(housingCredit),
      prefectural: prefIncomeTax, municipal: muniIncomeTax, total: prefIncomeTax + muniIncomeTax,
    },
    per_capita_levy: { prefectural: prefPerCapita, municipal: muniPerCapita, forest_environment_tax: forest, total: prefPerCapita + muniPerCapita + forest },
    annual_tax: annual,
    special_collection: { months: 12, june, july_to_may: monthly },
    notes: [
      ...notes,
      '住民税の額を決めるのは市区町村で、事業主は特別徴収税額通知書の額を控除します。これは地方税法の標準税率と公表されている超過課税から計算した見込み額であり、通知書の代わりではありません。',
      '住民税の所得控除は所得税と額が違います(基礎控除43万円、配偶者控除33万円、扶養控除33万円、生命保険料控除は上限7万円)。その差は調整控除で一部戻ります。',
    ],
    statutes: ['地方税法第23条', '地方税法第24条の5', '地方税法第34条', '地方税法第35条', '地方税法第37条', '地方税法第37条の2', '地方税法第38条',
      '地方税法第292条', '地方税法第295条', '地方税法第310条', '地方税法第314条の2', '地方税法第314条の3', '地方税法第314条の6', '地方税法第314条の7', '地方税法第321条の5',
      '森林環境税及び森林環境譲与税に関する法律第4条'],
  };
}
