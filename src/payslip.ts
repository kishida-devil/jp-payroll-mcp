import {
  insurance,
  findGrade, isLtcInsured, pensionStandardRemuneration, roundEmployeeShare,
  employmentInsuranceAt,
  type PrefKey,
} from './lib';
import { withholdingTax, type Column } from './withholding';
import { resolveEarnings, type AllowanceInput, type Earnings } from './allowances';
import { ageStatus } from './age';
import { workersCompPremium, workersCompType } from './workers-comp';

/**
 * One employee's monthly payslip.
 *
 * Shared by the single-employee endpoint and the batch endpoint so the two can
 * never drift. The order matters and is the whole point: social insurance is
 * computed on the standard remuneration, income tax is then charged on pay
 * *after* that insurance, and only then is net pay left.
 */

export type PayslipInput = {
  prefecture: PrefKey;
  monthly_salary: number;
  age: number | null;
  /** Preferred over `age`: lets the milestone rules be applied exactly. */
  birth_date?: Date | null;
  as_of?: Date;
  business_type: string;
  /**
   * 役員は雇用保険の被保険者にならない (雇用保険法第4条、行政手引20005)。
   * 兼務役員は労働者性が認められれば被保険者になるが、その判断は実態によるので
   * ここでは決められない。既定を employee にしているのは、渡さない利用者が
   * 圧倒的に労働者を計算しているため。
   */
  employment_type?: 'employee' | 'director' | 'director_employee';
  /**
   * 算定基礎届・月額変更届で決まっている標準報酬月額。
   *
   * 渡されなければ monthly_salary から引き直すが、**それは本来の姿ではない。**
   * 標準報酬月額は定時決定で決めたら翌年8月まで固定で、毎月の支給額では動かない。
   * 残業の多い月に引き直すと等級が上がり、その月だけ過大に控除される。
   * 月給30万(等級22)の人が残業で369,469円になった月に引き直すと、等級25として
   * 8,445円多く引くことになる。
   *
   * /v1/standard-remuneration/regular が正しい等級を返せるのに、それを渡す口が
   * 無かった。左手が出した答えを右手が受け取れない状態だった。
   */
  standard_remuneration?: number | null;
  /**
   * 基本給に足される支給項目。
   *
   * 通勤手当は社会保険では報酬に含まれ、所得税では非課税限度額まで課されない。
   * `monthly_salary` 単独ではその区別が表現できず、通勤手当を足せば所得税が
   * 過大に、足さなければ社会保険料が過少になる。どちらに寄せても誤りなので、
   * 項目として受け取る以外に正しくする方法がない。
   */
  allowances?: AllowanceInput[];
  /**
   * 労災保険の事業の種類の番号(徴収法施行規則別表第1)。
   * 渡さなければ労災保険料は出さない — 率が 2.5/1000 から 88/1000 まで開くので、
   * 既定値を置くとほぼ必ず誤った額になる。
   */
  workers_comp_type?: string | null;
  column: Column;
  dependants: number;
  income_tax: boolean;
  resident_tax: number;
};

const round2 = (v: number) => Math.round(v * 100) / 100;

export function computePayslip(input: PayslipInput) {
  const pref = insurance.prefectures[input.prefecture];
  // 雇用保険料率は年度で切り替わる(4月1日)。協会けんぽは3月分から切り替わるので、
  // 3月だけ「社保は新年度・雇用保険は旧年度」になる。as_of を見ずに現行の表を
  // 使うと、その月の雇用保険料が月給30万円で150円ずつ過少になる(33件目)。
  const asOfIso = (input.as_of ?? new Date()).toISOString().slice(0, 10);
  const eiTable = employmentInsuranceAt(asOfIso);
  if (!eiTable)
    throw new Error(`${asOfIso} 時点の雇用保険料率は収録されていません。`);
  const bt = eiTable.business_types[input.business_type];
  const salary = input.monthly_salary;

  // 支給項目に分解する。手当が無ければ基本給1行になり、以前と同じ答えになる。
  const earnings: Earnings = resolveEarnings(salary, input.allowances ?? []);

  // 標準報酬月額が渡されていればそれを使う。渡されていなければ**報酬**から引く。
  // 支給額(gross)ではない — 実費弁償は報酬に入らないため。
  const smrBasis = input.standard_remuneration ?? earnings.remuneration_basis;
  const grade = findGrade(smrBasis);
  const pen = pensionStandardRemuneration(grade);
  const smrWasGiven = input.standard_remuneration != null;
  const smr = grade.standard_monthly_remuneration;

  // With a birth date the milestones can be applied exactly; with only an age we
  // can do no better than the 40-64 band, and pension and health cannot be judged.
  const status = input.birth_date
    ? ageStatus(input.birth_date, input.as_of ?? new Date())
    : null;
  const ltc = status ? status.long_term_care : isLtcInsured(input.age);
  const pensionApplies = status ? status.pension : true;
  const healthApplies = status ? status.health_insurance : true;

  // Statutory premiums use the standard monthly remuneration, not actual pay.
  // Employment insurance is the exception and uses actual pay.
  const healthTotal = healthApplies ? smr * pref.health_insurance_rate : 0;
  const ltcTotal = ltc ? smr * pref.long_term_care_rate : 0;
  const pensionTotal = pensionApplies ? pen.smr * pref.pension_rate : 0;
  const childSupportTotal = healthApplies ? smr * pref.child_support_rate : 0;
  const childCareEmployer = pensionApplies ? pen.smr * insurance.meta.child_care_contribution_rate : 0;

  const item = (total: number) => {
    const employee = roundEmployeeShare(total / 2);
    return { total: round2(total), employee, employer: round2(total - employee) };
  };

  const health = item(healthTotal);
  const longTermCare = item(ltcTotal);
  const pension = item(pensionTotal);
  const childSupport = item(childSupportTotal);

  // 役員は雇用保険の被保険者にならない。以前は employment_type を受け取らず、
  // 中小企業の社長が自分の分を計算すると必ず過大になっていた。
  // 雇用保険は賃金総額にかかる(徴収法第2条第2項)。通勤手当は賃金に含まれ、
  // 実費弁償は含まれない。以前は基本給だけを基礎にしていた。
  const eiBasis = earnings.employment_insurance_basis;
  const eiInsured = (input.employment_type ?? 'employee') !== 'director';
  const eiEmployee = eiInsured ? roundEmployeeShare(eiBasis * bt.employee_rate) : 0;
  const eiEmployer = eiInsured ? round2(eiBasis * bt.employer_rate) : 0;

  // 労災保険は全額事業主負担。労働者にかかるものなので、役員は対象外。
  const wcType = workersCompType(input.workers_comp_type);
  const wcInsured = (input.employment_type ?? 'employee') !== 'director';
  const workersComp = wcType && wcInsured ? workersCompPremium(eiBasis, wcType) : null;

  const employeeTotal =
    health.employee + longTermCare.employee + pension.employee + childSupport.employee + eiEmployee;
  const employerTotal =
    health.employer + longTermCare.employer + pension.employer + childSupport.employer +
    eiEmployer + childCareEmployer;

  // 実際に社会保険料を引いたあとの現金。
  const afterSocialInsurance = round2(earnings.gross - employeeTotal);
  // 源泉徴収の課税対象は「社会保険料等控除後の給与等の金額」。非課税の通勤手当は
  // そもそも給与等に入らないので、gross ではなく課税支給額から引く。
  const taxableAfterSocialInsurance = round2(Math.max(0, earnings.taxable - employeeTotal));
  const incomeTax = input.income_tax
    ? withholdingTax(Math.floor(taxableAfterSocialInsurance), input.column, input.dependants)
    : null;
  const incomeTaxAmount = incomeTax ? incomeTax.tax : 0;
  const netPay = round2(afterSocialInsurance - incomeTaxAmount - input.resident_tax);

  return {
    ...(status ? { age_status: status } : {}),
    earnings,
    coverage: {
      health_insurance: healthApplies,
      long_term_care: ltc,
      pension: pensionApplies,
      employment_insurance: eiInsured,
      basis: status
        ? '生年月日から、法定の到達日にもとづいて判定しています。'
        : '介護保険の40〜64歳の区分だけを当てはめました。65歳・70歳・75歳の到達を正確に見るには birth_date を渡してください。',
    },
    standard_remuneration: {
      health_grade: grade.health_grade, health: smr,
      pension_grade: pen.grade, pension: pen.smr, pension_clamped: pen.clamped,
    },
    long_term_care_applicable: ltc,
    deductions: {
      health_insurance: health,
      long_term_care: longTermCare,
      pension,
      child_support: childSupport,
      employment_insurance: {
        employee: eiEmployee, employer: eiEmployer, total: round2(eiEmployee + eiEmployer),
        // どの年度の率を当てたかを応答に残す。3月分と4月分で違う。
        fiscal_year: eiTable.fiscal_year, effective_from: eiTable.effective_from,
        effective_to: eiTable.effective_to,
        rates: { employee: bt.employee_rate, employer: bt.employer_rate },
      },
      child_care_contribution: { employee: 0, employer: round2(childCareEmployer) },
      ...(workersComp ? { workers_compensation: workersComp } : {}),
    },
    income_tax: incomeTax,
    totals: {
      gross: earnings.gross,
      taxable_gross: earnings.taxable,
      non_taxable: earnings.non_taxable,
      remuneration_basis: earnings.remuneration_basis,
      social_insurance_employee: round2(employeeTotal),
      social_insurance_employer: round2(employerTotal),
      social_insurance_combined: round2(employeeTotal + employerTotal),
      after_social_insurance: afterSocialInsurance,
      taxable_after_social_insurance: taxableAfterSocialInsurance,
      income_tax: incomeTaxAmount,
      resident_tax: input.resident_tax,
      net_pay: netPay,
      workers_compensation_employer: workersComp ? workersComp.employer : 0,
      // 事業主が実際に出す総額。支給額 + 社会保険の事業主負担 + 労災保険。
      employer_cost: round2(earnings.gross + employerTotal + (workersComp ? workersComp.employer : 0)),
    },
  };
}

export type Payslip = ReturnType<typeof computePayslip>;

/** What the employer actually remits for the whole run. */
export function summarise(slips: Payslip[]) {
  const sum = (f: (s: Payslip) => number) => round2(slips.reduce((a, s) => a + f(s), 0));
  return {
    employees: slips.length,
    gross: sum((s) => s.totals.gross),
    taxable: sum((s) => s.totals.taxable_gross),
    non_taxable: sum((s) => s.totals.non_taxable),
    social_insurance: {
      employee: sum((s) => s.totals.social_insurance_employee),
      employer: sum((s) => s.totals.social_insurance_employer),
      combined: sum((s) => s.totals.social_insurance_combined),
    },
    workers_compensation_employer: sum((s) => s.totals.workers_compensation_employer),
    income_tax: sum((s) => s.totals.income_tax),
    resident_tax: sum((s) => s.totals.resident_tax),
    net_pay: sum((s) => s.totals.net_pay),
    employer_cost: sum((s) => s.totals.employer_cost),
  };
}
