import { empins, resolvePrefecture, type PrefKey } from './lib';
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
      prefRaw ? `Unknown prefecture: "${prefRaw}"` : 'prefecture is required, here or in defaults.');

  const salary = Number(row.monthly_salary);
  if (row.monthly_salary === undefined || !Number.isFinite(salary) || salary < 0)
    return fail('invalid_request', 'monthly_salary is required and must be a non-negative number.');

  const ageRaw = row.age ?? defaults.age;
  const age = ageRaw === undefined || ageRaw === null ? null : Number(ageRaw);
  if (age !== null && (!Number.isFinite(age) || age < 0 || age > 120))
    return fail('invalid_request', 'age must be a number between 0 and 120.');

  const btKey = String(row.business_type ?? defaults.business_type ?? 'general').toLowerCase();
  if (!(empins.business_types as any)[btKey])
    return fail('invalid_request', `Unknown business_type: "${btKey}"`);

  const colRaw = String(row.column ?? defaults.column ?? 'kou').toLowerCase();
  if (colRaw !== 'kou' && colRaw !== 'otsu')
    return fail('invalid_request', `Unknown column: "${colRaw}". Use "kou" or "otsu".`);

  const dependants = Number(row.dependants ?? defaults.dependants ?? 0);
  if (!Number.isInteger(dependants) || dependants < 0 || dependants > 50)
    return fail('invalid_request', 'dependants must be an integer between 0 and 50.');

  const incomeTax = readBoolean(row.income_tax ?? defaults.income_tax, true);
  if (incomeTax === null) return fail('invalid_request', 'income_tax must be a boolean.');

  const residentTax = Number(row.resident_tax ?? defaults.resident_tax ?? 0);
  if (!Number.isFinite(residentTax) || residentTax < 0)
    return fail('invalid_request', 'resident_tax must be a non-negative number.');

  // 標準報酬月額は行ごとにしか意味がないので defaults からは取らない。
  let smr: number | null = null;
  if (row.standard_remuneration !== undefined && row.standard_remuneration !== null) {
    smr = Number(row.standard_remuneration);
    if (!Number.isFinite(smr) || smr <= 0)
      return fail('invalid_request',
        'standard_remuneration must be a positive number — the 標準報酬月額 fixed by 算定基礎届 or 月額変更届.');
  }

  const empRaw = String(row.employment_type ?? defaults.employment_type ?? 'employee');
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(empRaw))
    return fail('invalid_request',
      `Unknown employment_type: "${empRaw}". Use employee, director or director_employee.`);

  const wcCandidate = row.workers_comp_type ?? defaults.workers_comp_type;
  const wcRaw = wcCandidate === undefined || wcCandidate === null ? null : String(wcCandidate);
  if (wcRaw !== null && !workersCompType(wcRaw))
    return fail('invalid_request',
      `Unknown workers_comp_type: "${wcRaw}". Use the 事業の種類の番号 from GET /v1/workers-compensation.`);

  // 支給項目。1行だけ落として残りは走らせるので、行の中で検証する。
  let allowances: AllowanceInput[] = [];
  if (row.allowances !== undefined && row.allowances !== null) {
    if (!Array.isArray(row.allowances))
      return fail('invalid_request', 'allowances must be an array of pay items.');
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
    if (detail === 'compact') {
      results.push({
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
      } as any);
      return;
    }
    results.push({ ...id, index, input: parsed.input, ...slip });
  });

  return { results, errors, summary: summarise(slips) };
}
