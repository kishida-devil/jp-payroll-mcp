import { empins, resolvePrefecture, type PrefKey } from './lib';
import { parseDate } from './age';
import { computePayslip, summarise, type Payslip, type PayslipInput } from './payslip';
import type { Column } from './withholding';
import { allowanceError, readAllowance, type AllowanceInput } from './allowances';
import { workersCompType } from './workers-comp';

/**
 * Batch payroll.
 *
 * A payroll run is hundreds of employees at once; one HTTP call each is slow and
 * burns quota. Two decisions shape this:
 *
 *  - `defaults` exists because most of a company's employees share a prefecture
 *    and business type, and repeating them per row is noise that invites typos.
 *  - A bad row is reported and skipped rather than failing the request. Returning
 *    400 for a 500-employee run because one row has a typo means the caller has
 *    to bisect their own payload to find it.
 */

export const MAX_BATCH = 500;

export type BatchRow = {
  id?: string;
  prefecture?: string;
  monthly_salary?: number;
  age?: number | null;
  /**
   * 生年月日。単発の /v1/payroll では渡せるのに batch では受け取れなかった。
   * 年齢計算ニ関スル法律により、1日生まれの人は誕生日の前日に年齢に達するので
   * 前月から料率が変わる。age だけではその1か月がずれる。
   */
  birth_date?: string | null;
  business_type?: string;
  column?: string;
  dependants?: number;
  income_tax?: boolean;
  resident_tax?: number;
  /**
   * 算定基礎届・月額変更届で決まっている標準報酬月額。
   * 単発の /v1/payroll では渡せるのに batch では渡せず、残業のある月に等級を
   * 引き直して過大控除になっていた。実際の給与計算は batch で回すので、
   * 口が無いのは単発より重い。
   */
  standard_remuneration?: number | null;
  employment_type?: string;
  /** 労災保険の事業の種類の番号。 */
  workers_comp_type?: string;
  /** 基本給に足される支給項目。通勤手当はここに入れる。 */
  allowances?: unknown;
};

export type BatchDefaults = Omit<BatchRow, 'id' | 'monthly_salary' | 'standard_remuneration' | 'allowances'>;

const EMPLOYMENT_TYPES = ['employee', 'director', 'director_employee'] as const;

export type RowError = { index: number; id?: string; code: string; error: string };

const BOOLEAN_TRUE = new Set(['true', '1', 'yes']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no']);

function readBoolean(v: unknown, fallback: boolean): boolean | null {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (BOOLEAN_TRUE.has(s)) return true;
  if (BOOLEAN_FALSE.has(s)) return false;
  return null;
}

/** Validate one row against the defaults. Returns either the input or why it failed. */
export function readRow(
  row: BatchRow,
  defaults: BatchDefaults,
  index: number,
): { ok: true; input: PayslipInput } | { ok: false; error: RowError } {
  const id = typeof row.id === 'string' ? row.id : undefined;
  const fail = (code: string, error: string) => ({ ok: false as const, error: { index, id, code, error } });

  const prefRaw = row.prefecture ?? defaults.prefecture;
  const prefecture = resolvePrefecture(prefRaw ?? null);
  if (!prefecture)
    return fail(prefRaw ? 'unknown_prefecture' : 'missing_parameter',
      prefRaw ? `該当する都道府県がありません: 「${prefRaw}」` : 'prefecture は必須です。この行か defaults に入れてください。');

  // **500人の名簿で3行だけ壊れているとき、「必須です」では直せない。**
  // 都道府県はすでに渡された値を見せている(「該当する都道府県がありません:
  // 「Nowhere」」)。金額と年齢だけが取り残されていた。
  // GET 側は13件目で直したので、こちらも同じ水準に揃える。
  // 名簿からは `300,000`・`３０００００`・`300000円` がそのまま入る。
  const whyBad = (raw: unknown): string => {
    const t = String(raw);
    if (/[０-９]/.test(t)) return '全角の数字が混じっています。';
    if (/,/.test(t)) return '桁区切りのカンマは外してください。';
    if (/[^\d.eE+\-\s]/.test(t)) return '数字以外の文字が混じっています(単位は付けないでください)。';
    return '数として読めません。';
  };

  const salary = Number(row.monthly_salary);
  if (row.monthly_salary === undefined || row.monthly_salary === null)
    return fail('missing_parameter',
      'monthly_salary は必須です。この行か defaults に入れてください。');
  if (!Number.isFinite(salary) || salary < 0)
    return fail('invalid_request',
      `monthly_salary に「${row.monthly_salary}」が渡されました。` +
      `${whyBad(row.monthly_salary)}0以上の半角数字だけで渡してください。`);

  const ageRaw = row.age ?? defaults.age;
  const age = ageRaw === undefined || ageRaw === null ? null : Number(ageRaw);
  if (age !== null && (!Number.isFinite(age) || age < 0 || age > 120))
    return fail('invalid_request',
      `age に「${ageRaw}」が渡されました。` +
      (Number.isFinite(age) ? '0から120の範囲で渡してください。' : whyBad(ageRaw)));

  const birthRaw = row.birth_date ?? defaults.birth_date;
  const birth = birthRaw === undefined || birthRaw === null ? null : parseDate(String(birthRaw));
  if (birthRaw !== undefined && birthRaw !== null && !birth)
    return fail('invalid_request', 'birth_date はYYYY-MM-DD形式の日付で渡してください。');

  // 介護保険法第9条は40歳以上65歳未満を第2号被保険者と定める。年齢が無ければ
  // 徴収するかどうかが決まらず、黙って「40歳未満」と置けば40〜64歳は必ず過少になる。
  // 行ごとに書かせるのは現実的でないので、defaults に置けば全行が継承する。
  if (age === null && birth === null)
    return fail('missing_parameter',
      'age か birth_date のどちらかが必要です(介護保険法第9条: 第2号被保険者は40歳以上65歳未満)。' +
      'defaults に入れると全行に適用されます。');

  const btKey = String(row.business_type ?? defaults.business_type ?? 'general').toLowerCase();
  if (!(empins.business_types as any)[btKey])
    return fail('invalid_request', `該当する business_type がありません: 「${btKey}」`);

  const colRaw = String(row.column ?? defaults.column ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return fail('invalid_request', `該当する column がありません: 「${colRaw}」。「kou」か「otsu」を使ってください。`);

  const dependants = Number(row.dependants ?? defaults.dependants ?? 0);
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return fail('invalid_request', 'dependants は0から50の整数で渡してください。');

  const incomeTax = readBoolean(row.income_tax ?? defaults.income_tax, true);
  if (incomeTax === null) return fail('invalid_request', 'income_tax は真偽値で渡してください。');

  const residentTax = Number(row.resident_tax ?? defaults.resident_tax ?? 0);
  if (!Number.isFinite(residentTax) || residentTax < 0)
    return fail('invalid_request', 'resident_tax は0以上の数で渡してください。');

  // 標準報酬月額は行ごとにしか意味がないので defaults からは取らない。
  let smr: number | null = null;
  if (row.standard_remuneration !== undefined && row.standard_remuneration !== null) {
    smr = Number(row.standard_remuneration);
    if (!Number.isFinite(smr) || smr <= 0)
      return fail('invalid_request',
        'standard_remuneration は正の数で渡してください。算定基礎届または月額変更届で決まっている標準報酬月額です。');
  }

  const empRaw = String(row.employment_type ?? defaults.employment_type ?? 'employee');
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(empRaw))
    return fail('invalid_request',
      `該当する employment_type がありません: 「${empRaw}」。employee・director・director_employee のいずれかを使ってください。`);

  const wcCandidate = row.workers_comp_type ?? defaults.workers_comp_type;
  const wcRaw = wcCandidate === undefined || wcCandidate === null ? null : String(wcCandidate);
  if (wcRaw !== null && !workersCompType(wcRaw))
    return fail('invalid_request',
      `該当する workers_comp_type がありません: 「${wcRaw}」。GET /v1/workers-compensation の事業の種類の番号を使ってください。`);

  // 支給項目。1行だけ落として残りは走らせるので、行の中で検証する。
  let allowances: AllowanceInput[] = [];
  if (row.allowances !== undefined && row.allowances !== null) {
    if (!Array.isArray(row.allowances))
      return fail('invalid_request', 'allowances は支給項目の配列で渡してください。');
    for (let i = 0; i < row.allowances.length; i++) {
      const err = allowanceError(row.allowances[i], i);
      if (err) return fail('invalid_request', err);
    }
    allowances = row.allowances.map(readAllowance);
  }

  return {
    ok: true,
    input: {
      prefecture: prefecture as PrefKey,
      monthly_salary: salary,
      age,
      birth_date: birth,
      business_type: btKey,
      column: colRaw as Column,
      dependants,
      income_tax: incomeTax,
      resident_tax: residentTax,
      standard_remuneration: smr,
      employment_type: empRaw as 'employee' | 'director' | 'director_employee',
      workers_comp_type: wcRaw,
      allowances,
    },
  };
}

export type Detail = 'full' | 'compact';

/**
 * A 500-employee run is roughly half a megabyte at full detail. Callers closing
 * out a payroll month usually want the per-employee figures they will actually
 * pay out, not every premium split — so let them ask for less.
 */
export function runBatch(rows: BatchRow[], defaults: BatchDefaults, detail: Detail = 'full') {
  const results: Array<Record<string, unknown>> = [];
  // full のときも compact 版を並行して組み立てる。size_hint の「compact にしたら
  // 何バイトか」を定数(14.5%)で見積もっていたが、応答に項目を足すたびに比率が
  // ずれて、5%以内の約束を破った。見積もりではなく、その応答の compact 版を
  // 実際に測って返す。行あたりの追加コストは小さなオブジェクト1つ。
  const compact: Array<Record<string, unknown>> = [];
  const errors: RowError[] = [];
  const slips: Payslip[] = [];

  rows.forEach((row, index) => {
    const parsed = readRow(row, defaults, index);
    if (!parsed.ok) {
      errors.push(parsed.error);
      return;
    }
    const slip = computePayslip(parsed.input);
    slips.push(slip);
    const id = typeof row.id === 'string' ? { id: row.id } : {};
    const compactRow = {
      ...id, index,
      prefecture: parsed.input.prefecture,
      gross: slip.totals.gross,
      taxable_gross: slip.totals.taxable_gross,
      non_taxable: slip.totals.non_taxable,
      social_insurance_employee: slip.totals.social_insurance_employee,
      social_insurance_employer: slip.totals.social_insurance_employer,
      workers_compensation_employer: slip.totals.workers_compensation_employer,
      employer_cost: slip.totals.employer_cost,
      income_tax: slip.totals.income_tax,
      resident_tax: slip.totals.resident_tax,
      net_pay: slip.totals.net_pay,
    } as any;
    compact.push(compactRow);
    if (detail === 'compact') {
      results.push(compactRow);
      return;
    }
    results.push({ ...id, index, input: parsed.input, ...slip });
  });

  return { results, compact, errors, summary: summarise(slips) };
}
