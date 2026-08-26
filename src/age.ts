/**
 * Age thresholds that change what is deducted from a salary.
 *
 * Under 年齢計算ニ関スル法律, age runs from the day of birth and 民法143条 applies,
 * so a person **reaches** an age on the day *before* their birthday. Someone born
 * on the 1st of a month therefore reaches it on the last day of the previous
 * month, and their deductions change a month earlier than intuition suggests.
 * Getting this wrong is a quiet one-month error that only shows up for people
 * born on the 1st.
 *
 *   40 — 介護保険第2号被保険者 begins        介護保険法第9条第2号
 *   65 — no longer 第2号; billed by the municipality instead, not via payroll
 *   70 — 厚生年金保険 資格喪失                厚生年金保険法第9条・第14条第5号
 *   75 — 後期高齢者医療へ移行, 健康保険 資格喪失  高齢者医療確保法第50条 / 健康保険法第3条第7号
 */

const DAY = 86_400_000;

export const AGE_RULES = {
  basis_ja: '年齢計算ニ関スル法律 / 民法第143条',
  reached_on_ja: '満年齢に達するのは誕生日の前日。その日が属する月から適用される。',
  thresholds: [
    { age: 40, effect: 'long_term_care_starts', statute: '介護保険法第9条第2号' },
    { age: 65, effect: 'long_term_care_ends_payroll', statute: '介護保険法第9条第1号' },
    { age: 70, effect: 'pension_ends', statute: '厚生年金保険法第9条・第14条第5号' },
    { age: 75, effect: 'health_insurance_ends', statute: '高齢者医療確保法第50条 / 健康保険法第3条第7号' },
  ],
} as const;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(s: string | null | undefined): Date | null {
  if (!s || !ISO.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The day the person reaches `age`: the day before the birthday in that year.
 * Handles 29 February by letting the Date roll to 1 March and stepping back,
 * which lands on 28 February in a non-leap year — the same answer the statute
 * gives, since the period ends on the day before the corresponding date.
 */
export function dateAgeReached(birth: Date, age: number): Date {
  const anniversary = new Date(Date.UTC(
    birth.getUTCFullYear() + age, birth.getUTCMonth(), birth.getUTCDate(),
  ));
  return new Date(anniversary.getTime() - DAY);
}

/** Whole years completed as of `on`, using the day-before rule. */
export function ageOn(birth: Date, on: Date): number {
  let age = on.getUTCFullYear() - birth.getUTCFullYear();
  if (on.getTime() < dateAgeReached(birth, age).getTime()) age -= 1;
  return age;
}

const monthKey = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

/** Has the person reached `age` by the end of the month containing `on`? */
function reachedInOrBefore(birth: Date, age: number, on: Date): boolean {
  return monthKey(dateAgeReached(birth, age)) <= monthKey(on);
}

export type AgeStatus = {
  birth_date: string;
  as_of: string;
  age: number;
  long_term_care: boolean;
  pension: boolean;
  health_insurance: boolean;
  milestones: Array<{
    age: number;
    effect: string;
    statute: string;
    reached_on: string;
    applies_from_month: string;
    passed: boolean;
  }>;
  notes: string[];
};

export function ageStatus(birth: Date, on: Date): AgeStatus {
  const ltcStarted = reachedInOrBefore(birth, 40, on);
  const ltcEnded = reachedInOrBefore(birth, 65, on);
  const pensionEnded = reachedInOrBefore(birth, 70, on);
  const healthEnded = reachedInOrBefore(birth, 75, on);

  const milestones = AGE_RULES.thresholds.map((t) => {
    const reached = dateAgeReached(birth, t.age);
    return {
      age: t.age,
      effect: t.effect,
      statute: t.statute,
      reached_on: iso(reached),
      applies_from_month: iso(reached).slice(0, 7),
      passed: reachedInOrBefore(birth, t.age, on),
    };
  });

  const notes: string[] = [];
  if (birth.getUTCDate() === 1)
    notes.push(
      'Born on the 1st: each milestone falls on the last day of the previous month, so the change takes effect a month earlier than the birthday month.',
    );
  const thisMonth = milestones.filter((m) => m.applies_from_month === iso(on).slice(0, 7));
  for (const m of thisMonth)
    notes.push(`Age ${m.age} is reached this month (${m.reached_on}); ${m.effect} applies from this month.`);
  if (ltcEnded && !pensionEnded)
    notes.push('From 65 the long-term care premium is billed by the municipality, not deducted from salary.');

  return {
    birth_date: iso(birth),
    as_of: iso(on),
    age: ageOn(birth, on),
    long_term_care: ltcStarted && !ltcEnded,
    pension: !pensionEnded,
    health_insurance: !healthEnded,
    milestones,
    notes,
  };
}
