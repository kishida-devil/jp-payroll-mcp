import {
  insurance, empins,
  findGrade, isLtcInsured, pensionStandardRemuneration, roundEmployeeShare,
  type PrefKey,
} from './lib';
import { withholdingTax, type Column } from './withholding';
import { ageStatus } from './age';

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
  column: Column;
  dependants: number;
  income_tax: boolean;
  resident_tax: number;
};

const round2 = (v: number) => Math.round(v * 100) / 100;

export function computePayslip(input: PayslipInput) {
  const pref = insurance.prefectures[input.prefecture];
  const bt = (empins.business_types as any)[input.business_type];
  const salary = input.monthly_salary;

  const grade = findGrade(salary);
  const pen = pensionStandardRemuneration(grade);
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

  const eiEmployee = roundEmployeeShare(salary * bt.employee_rate);
  const eiEmployer = round2(salary * bt.employer_rate);

  const employeeTotal =
    health.employee + longTermCare.employee + pension.employee + childSupport.employee + eiEmployee;
  const employerTotal =
    health.employer + longTermCare.employer + pension.employer + childSupport.employer +
    eiEmployer + childCareEmployer;

  const afterSocialInsurance = round2(salary - employeeTotal);
  const incomeTax = input.income_tax
    ? withholdingTax(Math.floor(afterSocialInsurance), input.column, input.dependants)
    : null;
  const incomeTaxAmount = incomeTax ? incomeTax.tax : 0;
  const netPay = round2(afterSocialInsurance - incomeTaxAmount - input.resident_tax);

  return {
    ...(status ? { age_status: status } : {}),
    coverage: {
      health_insurance: healthApplies,
      long_term_care: ltc,
      pension: pensionApplies,
      employment_insurance: true,
      basis: status
        ? 'Determined from the birth date using the statutory milestones.'
        : 'Only the 40-64 long-term care band could be applied; pass birth_date for the 65, 70 and 75 milestones.',
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
      },
      child_care_contribution: { employee: 0, employer: round2(childCareEmployer) },
    },
    income_tax: incomeTax,
    totals: {
      gross: salary,
      social_insurance_employee: round2(employeeTotal),
      social_insurance_employer: round2(employerTotal),
      social_insurance_combined: round2(employeeTotal + employerTotal),
      after_social_insurance: afterSocialInsurance,
      income_tax: incomeTaxAmount,
      resident_tax: input.resident_tax,
      net_pay: netPay,
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
    social_insurance: {
      employee: sum((s) => s.totals.social_insurance_employee),
      employer: sum((s) => s.totals.social_insurance_employer),
      combined: sum((s) => s.totals.social_insurance_combined),
    },
    income_tax: sum((s) => s.totals.income_tax),
    resident_tax: sum((s) => s.totals.resident_tax),
    net_pay: sum((s) => s.totals.net_pay),
    employer_cost: round2(
      slips.reduce((a, s) => a + s.totals.gross + s.totals.social_insurance_employer, 0),
    ),
  };
}
