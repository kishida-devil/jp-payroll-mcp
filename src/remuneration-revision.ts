import { insurance, findGrade } from './lib';

/**
 * 標準報酬月額の決定と改定 — 定時決定, 随時改定, 休業終了時改定, 年間平均.
 *
 * The statute is much thinner than the practice. 健康保険法第43条 says only that
 * the three-month average must differ "著しく" from the current figure. **Neither
 * the two-grade test nor the requirement that fixed pay changed appears anywhere
 * in the Act or its regulations** — both live in 昭和36年1月26日 保発第4号, a
 * ministerial notice. Everything here cites whichever of the two actually says it.
 *
 * ## The virtual-grade model
 *
 * 保発第4号 記2(1) イ〜オ carve out four cases where a *single* grade is enough,
 * at the very top and bottom of each table. They are usually implemented as four
 * hard-coded special cases. They do not need to be: the thresholds the notice
 * names are exactly one band beyond the last real grade —
 *
 *   健保  53,000 未満 → virtual grade 0     1,415,000 以上 → virtual grade 51
 *   厚年  83,000 未満 → virtual grade 0       665,000 以上 → virtual grade 33
 *
 * — so extending each table by one virtual band at each end and applying the
 * ordinary two-grade test reproduces all four exceptions exactly, and reproduces
 * them for both schemes from one piece of code. Each of イ〜オ comes out at a gap
 * of precisely 2. The same four thresholds turn out to govern the 1等級差 special
 * case in the 定時決定 annual-average rules too, which is good evidence the model
 * is the right shape rather than a coincidence. The tests check all of it against
 * the tables 日本年金機構 publishes.
 *
 * The response still names which of ア〜オ applied, so a filing can be audited
 * against the notice rather than against this abstraction.
 *
 * ## The current-side subtlety
 *
 * For イ〜オ the *current* side is judged on 報酬月額 — the actual pay the current
 * grade was derived from — not on 標準報酬月額. Someone on 健保第50級 sits in that
 * grade anywhere from 1,355,000 upward, but only qualifies under エ if their pay
 * was 1,415,000 or more. So this module takes the prior 報酬月額, not the prior
 * grade.
 */

const GRADES = insurance.grades;
const PENSION_GRADES = GRADES.filter((g) => g.pension_grade !== null);

export type Scheme = 'health' | 'pension';

/** The virtual bands one step beyond each table. 保発第4号 記2(1) イ〜オ. */
const VIRTUAL = {
  health: { low: 53_000, high: 1_415_000, top: 50, virtual_top: 51 },
  pension: { low: 83_000, high: 665_000, top: 32, virtual_top: 33 },
} as const;

/** Real grade for a 報酬月額, clamped into the scheme's table. */
export function realGrade(scheme: Scheme, remuneration: number): number {
  const row = findGrade(remuneration);
  if (scheme === 'health') return row.health_grade;
  if (row.pension_grade !== null) return row.pension_grade;
  // Below or above the pension table: clamp to its first or last band.
  return row.standard_monthly_remuneration < PENSION_GRADES[0].standard_monthly_remuneration
    ? PENSION_GRADES[0].pension_grade!
    : PENSION_GRADES[PENSION_GRADES.length - 1].pension_grade!;
}

/** Grade on the extended scale: 0 below the table, top+1 above it. */
export function virtualGrade(scheme: Scheme, remuneration: number): number {
  const v = VIRTUAL[scheme];
  if (remuneration < v.low) return 0;
  if (remuneration >= v.high) return v.virtual_top;
  return realGrade(scheme, remuneration);
}

export function standardRemuneration(scheme: Scheme, remuneration: number): number {
  const grade = realGrade(scheme, remuneration);
  const row = scheme === 'health'
    ? GRADES.find((g) => g.health_grade === grade)!
    : PENSION_GRADES.find((g) => g.pension_grade === grade)!;
  return row.standard_monthly_remuneration;
}

/** Which of イ〜オ a qualifying single-grade move corresponds to, for auditing. */
function namedException(
  scheme: Scheme,
  currentReal: number,
  currentVirtual: number,
  newReal: number,
  newVirtual: number,
): string | null {
  if (Math.abs(newReal - currentReal) >= 2) return null; // ordinary ア
  const v = VIRTUAL[scheme];
  const label = scheme === 'health' ? '健康保険' : '厚生年金保険';
  if (newVirtual === v.virtual_top && currentReal === v.top - 1)
    return `イ: ${label}第${v.top - 1}級の者が昇給し、算定月額が${v.high.toLocaleString()}円以上となった`;
  if (currentVirtual === 0 && currentReal === 1 && newReal === 2)
    return `ウ: 第1級で報酬月額${v.low.toLocaleString()}円未満の者が昇給し、算定月額が第2級に該当した`;
  if (currentVirtual === v.virtual_top && newReal <= v.top - 1)
    return `エ: ${label}第${v.top}級で報酬月額${v.high.toLocaleString()}円以上の者が降給し、算定月額が第${v.top - 1}級以下となった`;
  if (currentReal === 2 && newVirtual === 0)
    return `オ: 第2級の者が降給し、算定月額が${v.low.toLocaleString()}円未満となった`;
  return null;
}

export type PayMonth = { remuneration: number; payment_basis_days: number };
export type WorkerType = 'general' | 'part_time_short_hours' | 'short_time_insured';

/**
 * 健保法41条1項の括弧書きが43条1項・43条の2第1項・43条の3第1項を一括参照するので、
 * the 11-day threshold propagates to all four determinations from one definition
 * (健康保険法施行規則第24条の2).
 */
export const daysThreshold = (t: WorkerType) => (t === 'short_time_insured' ? 11 : 17);

const avg = (ms: PayMonth[]) =>
  Math.floor(ms.reduce((a, m) => a + m.remuneration, 0) / ms.length);

const WORKER_TYPE_LABEL: Record<WorkerType, string> = {
  general: '一般の被保険者',
  part_time_short_hours: '短時間就労者 (パート等、4分の3基準を満たす者)',
  short_time_insured: '特定適用事業所の短時間労働者',
};

// ---------------------------------------------------------------------------
// 随時改定 (月額変更) — 健康保険法第43条 / 厚生年金保険法第23条
// ---------------------------------------------------------------------------

function judgeScheme(
  scheme: Scheme,
  currentRemuneration: number,
  average: number,
  direction: 'increase' | 'decrease',
) {
  const currentReal = realGrade(scheme, currentRemuneration);
  const currentVirtual = virtualGrade(scheme, currentRemuneration);
  const newReal = realGrade(scheme, average);
  const newVirtual = virtualGrade(scheme, average);

  const gap = Math.abs(newVirtual - currentVirtual);
  // 保発第4号 記2(1) is written for 昇給/降給, so the move must run the same way
  // as fixed pay did. 日本年金機構 states this as its own exclusion: fixed pay up
  // but the average down is not a revision even at a two-grade gap.
  const directionOk = direction === 'increase'
    ? newVirtual > currentVirtual
    : newVirtual < currentVirtual;
  const applies = gap >= 2 && directionOk;

  return {
    applies,
    current_grade: currentReal,
    current_standard_remuneration: standardRemuneration(scheme, currentRemuneration),
    new_grade: applies ? newReal : null,
    new_standard_remuneration: applies ? standardRemuneration(scheme, average) : null,
    real_grade_gap: Math.abs(newReal - currentReal),
    extended_grade_gap: gap,
    boundary_exception: applies
      ? namedException(scheme, currentReal, currentVirtual, newReal, newVirtual)
      : null,
    direction_consistent: directionOk,
  };
}

export function judgeRevision(args: {
  current_remuneration: number;
  months: [PayMonth, PayMonth, PayMonth];
  fixed_pay_change: 'increase' | 'decrease' | 'none';
  worker_type: WorkerType;
}) {
  const threshold = daysThreshold(args.worker_type);
  const short = args.months
    .map((m, i) => ({ i, days: m.payment_basis_days }))
    .filter((m) => m.days < threshold);

  const blocking: string[] = [];
  if (args.fixed_pay_change === 'none')
    blocking.push(
      '固定的賃金の変動がありません (保発第4号 記2(2))。残業手当など非固定的賃金だけの増減では月額変更になりません。',
    );
  if (short.length)
    blocking.push(
      `支払基礎日数が${threshold}日未満の月があります (${short.map((m) => `${m.i + 1}か月目=${m.days}日`).join('、')})。` +
      '随時改定は3か月すべてが基準を満たす必要があります。' +
      (args.worker_type === 'part_time_short_hours'
        ? '短時間就労者の15日基準は定時決定専用で、随時改定には使えません (平成18年 庁保険発第0512001号 記2(2))。'
        : ''),
    );

  const average = avg(args.months);
  const direction = args.fixed_pay_change === 'none' ? 'increase' : args.fixed_pay_change;
  const health = judgeScheme('health', args.current_remuneration, average, direction);
  const pension = judgeScheme('pension', args.current_remuneration, average, direction);

  if (!blocking.length && !health.applies && !pension.applies) {
    if (!health.direction_consistent && health.extended_grade_gap >= 2)
      blocking.push(
        `固定的賃金は${args.fixed_pay_change === 'increase' ? '増加' : '減少'}しましたが、3か月平均から算出した等級は逆方向です。` +
        '非固定的賃金の変動による逆転は随時改定の対象外です。',
      );
    else
      blocking.push(
        '健康保険・厚生年金保険のいずれも等級差が2に届きません。上限・下限付近の例外にも該当しません (保発第4号 記2(1))。',
      );
  }

  const applies = blocking.length === 0 && (health.applies || pension.applies);

  return {
    applies,
    schemes: { health, pension },
    current_remuneration: args.current_remuneration,
    average_remuneration: average,
    fixed_pay_change: args.fixed_pay_change,
    worker_type: args.worker_type,
    worker_type_label: WORKER_TYPE_LABEL[args.worker_type],
    payment_basis_threshold: threshold,
    blocking_reasons: blocking,
    effective_from: applies
      ? '固定的賃金が変動した月から起算して4か月目 (健康保険法第43条第1項)'
      : null,
    notes: {
      independence:
        '健康保険と厚生年金保険は別の等級表なので、片方だけが改定されることがあります。厚生年金は上下限で頭打ちになるため、高額者では健保だけが動くのが普通です。',
      basis:
        '「2等級以上の差」も「固定的賃金の変動」も健康保険法・同施行規則には書かれておらず、昭和36年1月26日 保発第4号によります。',
      annual_average:
        '季節的な繁閑で3か月平均が実態とずれる場合は、年間平均による保険者算定 (平成30年10月〜) を POST /v1/standard-remuneration/annual-average で判定できます。',
    },
  };
}

// ---------------------------------------------------------------------------
// 定時決定 (算定基礎) — 健康保険法第41条 / 厚生年金保険法第21条
// ---------------------------------------------------------------------------

export function judgeRegularDecision(args: {
  months: [PayMonth, PayMonth, PayMonth];
  worker_type: WorkerType;
  previous_remuneration?: number;
}) {
  const threshold = daysThreshold(args.worker_type);
  let used = args.months.filter((m) => m.payment_basis_days >= threshold);
  let basis = `4〜6月のうち支払基礎日数${threshold}日以上の月の平均`;
  let fallback: string | null = null;

  // 平成18年5月12日 庁保険発第0512001号 記2(1)②: the 15-day step exists only for
  // 短時間就労者, and only in 定時決定. It is not available in 随時改定.
  if (used.length === 0 && args.worker_type === 'part_time_short_hours') {
    used = args.months.filter((m) => m.payment_basis_days >= 15);
    if (used.length) {
      fallback = '15日以上17日未満の月による保険者算定 (平成18年 庁保険発第0512001号 記2(1)②)';
      basis = fallback;
    }
  }

  const common = {
    payment_basis_threshold: threshold,
    worker_type: args.worker_type,
    worker_type_label: WORKER_TYPE_LABEL[args.worker_type],
    effective: '9月から翌年8月まで (健康保険法第41条第2項)',
    statute: '健康保険法第41条 / 厚生年金保険法第21条',
  };

  if (used.length === 0)
    return {
      decided: false,
      months_used: 0,
      insurer_determination: true,
      reason:
        `4〜6月のいずれも支払基礎日数の基準を満たしません` +
        (args.worker_type === 'part_time_short_hours' ? '(15日への緩和を含む)' : '') +
        '。保険者算定により従前の標準報酬月額を引き継ぎます (平成18年 庁保険発第0512001号 記2(1)③)。',
      previous_remuneration: args.previous_remuneration ?? null,
      previous_grades: args.previous_remuneration
        ? {
            health: realGrade('health', args.previous_remuneration),
            pension: realGrade('pension', args.previous_remuneration),
          }
        : null,
      ...common,
    };

  const average = avg(used);
  return {
    decided: true,
    months_used: used.length,
    insurer_determination: fallback !== null,
    average_remuneration: average,
    schemes: {
      health: {
        grade: realGrade('health', average),
        standard_remuneration: standardRemuneration('health', average),
      },
      pension: {
        grade: realGrade('pension', average),
        standard_remuneration: standardRemuneration('pension', average),
        clamped:
          average < VIRTUAL.pension.low ||
          average >= PENSION_GRADES[PENSION_GRADES.length - 1].remuneration_from!,
      },
    },
    basis,
    fallback_applied: fallback,
    ...common,
  };
}

/** 定時決定の提出対象外 (日本年金機構「定時決定(算定基礎届)」). */
export const REGULAR_DECISION_EXCLUSIONS = [
  '6月1日以降に資格取得した方 (資格取得時決定が翌年8月まで有効なため)',
  '6月30日以前に退職した方',
  '7月改定の月額変更届を提出する方',
  '8月または9月に随時改定が予定されている旨の申し出を行った方',
];

/** 資格取得時決定の適用期間 (健康保険法第42条). */
export function acquisitionDecisionPeriod(month: number) {
  return month >= 1 && month <= 5
    ? { applies_until: 'その年の8月', note: '1月〜5月の資格取得' }
    : { applies_until: '翌年の8月', note: '6月〜12月の資格取得' };
}

// ---------------------------------------------------------------------------
// 産前産後休業終了時改定 / 育児休業等終了時改定 — 健保法43条の3 / 43条の2
// ---------------------------------------------------------------------------

export function judgeLeaveEndRevision(args: {
  kind: 'maternity' | 'childcare';
  current_remuneration: number;
  months: [PayMonth, PayMonth, PayMonth];
  worker_type: WorkerType;
  /** 産休: 終了日の翌日に育休を開始した / 育休: 終了日の翌日に産休を開始した */
  next_leave_starts_immediately?: boolean;
}) {
  const threshold = daysThreshold(args.worker_type);
  const blocking: string[] = [];

  if (args.next_leave_starts_immediately)
    blocking.push(
      args.kind === 'maternity'
        ? '産前産後休業終了日の翌日に育児休業を開始しているため、申出できません。'
        : '育児休業等終了日の翌日に産前産後休業を開始しているため、申出できません (健康保険法第43条の2第1項ただし書)。',
    );

  let used = args.months.filter((m) => m.payment_basis_days >= threshold);
  let fallback: string | null = null;
  if (used.length === 0 && args.worker_type === 'part_time_short_hours') {
    used = args.months.filter((m) => m.payment_basis_days >= 15);
    if (used.length) fallback = '15日以上17日未満の月による算定 (短時間就労者)';
  }
  if (used.length === 0)
    blocking.push(
      `3か月のうち少なくとも1か月は支払基礎日数${threshold}日以上である必要があります` +
      (args.worker_type === 'part_time_short_hours' ? '(短時間就労者は15日以上の月による算定も可)' : '') +
      '。',
    );

  const average = used.length ? avg(used) : null;

  // 1等級以上の差で足りる。随時改定の2等級とは別の基準 (健保法43条の2第1項/43条の3第1項)。
  const schemes = average === null ? null : {
    health: leaveEndScheme('health', args.current_remuneration, average),
    pension: leaveEndScheme('pension', args.current_remuneration, average),
  };

  if (!blocking.length && schemes && !schemes.health.applies && !schemes.pension.applies)
    blocking.push('従前の標準報酬月額との間に1等級以上の差が生じていません。');

  const applies = blocking.length === 0;

  return {
    applies,
    kind: args.kind,
    kind_label: args.kind === 'maternity' ? '産前産後休業終了時改定' : '育児休業等終了時改定',
    current_remuneration: args.current_remuneration,
    average_remuneration: average,
    months_used: used.length,
    months_excluded: 3 - used.length,
    fallback_applied: fallback,
    payment_basis_threshold: threshold,
    worker_type: args.worker_type,
    worker_type_label: WORKER_TYPE_LABEL[args.worker_type],
    schemes,
    blocking_reasons: blocking,
    grade_difference_required: 1,
    effective_from: applies
      ? '休業終了日の翌日が属する月から起算して4か月目'
      : null,
    applies_until:
      '1〜6月の改定はその年の8月まで、7〜12月の改定は翌年の8月まで (再び随時改定等がない限り)',
    requires_employee_application: true,
    statutes: args.kind === 'maternity'
      ? ['健康保険法第43条の3', '厚生年金保険法第23条の3']
      : ['健康保険法第43条の2', '厚生年金保険法第23条の2'],
    notes: {
      one_grade:
        '随時改定に該当しなくても改定できます。差は1等級で足り、固定的賃金の変動も不要です。',
      excluded_months:
        '支払基礎日数が基準未満の月は平均から除きます。3か月すべてが基準未満だと改定できません(短時間就労者の15日基準を除く)。',
      application:
        '被保険者本人の申出が必須で、事業主が単独で届出することはできません。',
    },
  };
}

function leaveEndScheme(scheme: Scheme, currentRemuneration: number, average: number) {
  const currentReal = realGrade(scheme, currentRemuneration);
  const newReal = realGrade(scheme, average);
  const applies = newReal !== currentReal;
  return {
    applies,
    current_grade: currentReal,
    current_standard_remuneration: standardRemuneration(scheme, currentRemuneration),
    new_grade: applies ? newReal : null,
    new_standard_remuneration: applies ? standardRemuneration(scheme, average) : null,
    grade_gap: Math.abs(newReal - currentReal),
  };
}

// ---------------------------------------------------------------------------
// 年間平均による保険者算定 — 定時決定 (平成23年4月〜) / 随時改定 (平成30年10月〜)
// ---------------------------------------------------------------------------

export type AnnualMonth = {
  month?: string;
  remuneration?: number;
  fixed?: number;
  non_fixed?: number;
  payment_basis_days: number;
};

/**
 * 定時決定の年間平均. Compares the ordinary April–June figure with the average
 * over 前年7月〜当年6月, both excluding months under the day threshold.
 *
 * The 1等級差 special case published by 日本年金機構 turns out to be the extended
 * two-grade test again — the thresholds are the same virtual bands as 保発第4号 —
 * so it needs no separate branch.
 */
export function annualAverageRegular(args: {
  months: AnnualMonth[]; // 12 entries, 前年7月 → 当年6月
  worker_type: WorkerType;
  recurring_annually: boolean;
  employee_consent: boolean;
}) {
  const threshold = daysThreshold(args.worker_type);
  const qualifying = args.months.filter((m) => m.payment_basis_days >= threshold);
  const aprJun = args.months.slice(9); // last three entries are 4, 5, 6月
  const aprJunUsed = aprJun.filter((m) => m.payment_basis_days >= threshold);

  const blocking: string[] = [];
  if (!aprJunUsed.length)
    blocking.push(`4〜6月に支払基礎日数${threshold}日以上の月がありません。`);
  if (!qualifying.length)
    blocking.push(`前年7月〜当年6月に支払基礎日数${threshold}日以上の月がありません。`);
  if (!args.recurring_annually)
    blocking.push('等級差が業務の性質上例年発生する見込みではないため、対象外です。');
  if (!args.employee_consent)
    blocking.push('被保険者の同意がないため、対象外です。');

  const ordinary = aprJunUsed.length
    ? Math.floor(aprJunUsed.reduce((a, m) => a + (m.remuneration ?? 0), 0) / aprJunUsed.length)
    : null;
  const annual = qualifying.length
    ? Math.floor(qualifying.reduce((a, m) => a + (m.remuneration ?? 0), 0) / qualifying.length)
    : null;

  const schemes = ordinary === null || annual === null ? null : {
    health: annualScheme('health', ordinary, annual),
    pension: annualScheme('pension', ordinary, annual),
  };

  if (!blocking.length && schemes && !schemes.health.qualifies && !schemes.pension.qualifies)
    blocking.push(
      '通常の算定と年間平均の間に2等級以上の差が生じていません (上限・下限付近の1等級差特例にも該当しません)。',
    );

  const applies = blocking.length === 0;

  return {
    applies,
    ordinary_remuneration: ordinary,
    annual_average_remuneration: annual,
    months_used_annual: qualifying.length,
    months_used_apr_jun: aprJunUsed.length,
    payment_basis_threshold: threshold,
    worker_type: args.worker_type,
    schemes,
    decided: applies && annual !== null ? {
      health: {
        grade: realGrade('health', annual),
        standard_remuneration: standardRemuneration('health', annual),
      },
      pension: {
        grade: realGrade('pension', annual),
        standard_remuneration: standardRemuneration('pension', annual),
      },
    } : null,
    blocking_reasons: blocking,
    basis: '昭和36年 保発第4号 記1(4)。平成23年4月1日から実施。',
    filing: {
      form: '被保険者報酬月額算定基礎届の備考欄「8. 年間平均」に〇',
      attachments: [
        '(様式1) 年間報酬の平均で算定することの申立書',
        '(様式2) 保険者算定申立に係る例年の状況、標準報酬月額の比較及び被保険者の同意等',
      ],
      note: '賃金台帳等の提出を求められる場合があります。',
    },
    excluded_cases: [
      '当年4月〜5月に資格取得した方 (年間平均の対象月が1か月も確保されないため)',
      '当年7〜9月に随時改定を行った場合',
      '当年7月1日時点で一時帰休が解消される見込みがない場合',
    ],
  };
}

/**
 * 随時改定の年間平均 (平成30年10月〜). Three tests must all pass, per
 * 平成30年3月1日 保保発0301第1号・年管管発0301第4号 —
 *
 *   (1) 現在の標準報酬月額 vs 通常の随時改定 … 2等級以上
 *   (2) 通常の随時改定 vs 年間平均         … 2等級以上
 *   (3) 現在の標準報酬月額 vs 年間平均      … 1等級以上
 *
 * The annual figure is not a plain twelve-month average: it is the three-month
 * average of **fixed** pay plus the twelve-month average of **non-fixed** pay.
 */
export function annualAverageRevision(args: {
  /** 12 entries: 9 months before the change, then the 3 months after it. */
  months: AnnualMonth[];
  current_remuneration: number;
  fixed_pay_change: 'increase' | 'decrease';
  worker_type: WorkerType;
  recurring_annually: boolean;
  employee_consent: boolean;
}) {
  const threshold = daysThreshold(args.worker_type);
  const after = args.months.slice(9);
  const blocking: string[] = [];

  const short = after
    .map((m, i) => ({ i, days: m.payment_basis_days }))
    .filter((m) => m.days < threshold);
  if (short.length)
    blocking.push(
      `変動月以後3か月のうち支払基礎日数が${threshold}日未満の月があります (${short.map((m) => `${m.i + 1}か月目=${m.days}日`).join('、')})。`,
    );
  if (!args.recurring_annually)
    blocking.push('固定的賃金の変動と等級差の双方が例年発生する見込みではないため、対象外です。定期昇給とは別の単年度のみの特別な昇給や、一時的な繁忙との重複による改定は対象外です。');
  if (!args.employee_consent)
    blocking.push('被保険者の同意がないため、対象外です。');

  const sum = (ms: AnnualMonth[], k: 'fixed' | 'non_fixed') =>
    ms.reduce((a, m) => a + (m[k] ?? 0), 0);

  const ordinary = Math.floor(
    after.reduce((a, m) => a + (m.fixed ?? 0) + (m.non_fixed ?? 0), 0) / after.length,
  );
  // 昇給月以後3か月の固定的賃金の平均 + 前9か月と以後3か月(=12か月)の非固定的賃金の平均
  const annual = Math.floor(sum(after, 'fixed') / after.length)
    + Math.floor(sum(args.months, 'non_fixed') / args.months.length);

  const test = (scheme: Scheme) => {
    const cur = virtualGrade(scheme, args.current_remuneration);
    const ord = virtualGrade(scheme, ordinary);
    const ann = virtualGrade(scheme, annual);
    const t1 = Math.abs(ord - cur) >= 2;
    const t2 = Math.abs(ann - ord) >= 2;
    const t3 = Math.abs(ann - cur) >= 1;
    // 記2(5) ただし書: an increase whose annual figure lands at or below the current
    // grade (or a decrease at or above it) stays put.
    const directionOk = args.fixed_pay_change === 'increase' ? ann > cur : ann < cur;
    return {
      qualifies: t1 && t2 && t3 && directionOk,
      test_1_current_vs_ordinary: { gap: Math.abs(ord - cur), required: 2, passed: t1 },
      test_2_ordinary_vs_annual: { gap: Math.abs(ann - ord), required: 2, passed: t2 },
      test_3_current_vs_annual: { gap: Math.abs(ann - cur), required: 1, passed: t3 },
      direction_consistent: directionOk,
      current_grade: realGrade(scheme, args.current_remuneration),
      ordinary_grade: realGrade(scheme, ordinary),
      annual_grade: realGrade(scheme, annual),
      new_standard_remuneration: t1 && t2 && t3 && directionOk
        ? standardRemuneration(scheme, annual) : null,
    };
  };

  const schemes = { health: test('health'), pension: test('pension') };
  if (!blocking.length && !schemes.health.qualifies && !schemes.pension.qualifies)
    blocking.push('3つの等級差要件をすべて満たす制度がありません。');

  return {
    applies: blocking.length === 0,
    current_remuneration: args.current_remuneration,
    ordinary_remuneration: ordinary,
    annual_average_remuneration: annual,
    calculation:
      '年間平均額 = 変動月以後3か月の固定的賃金の平均 + 変動月前9か月と以後3か月(計12か月)の非固定的賃金の平均',
    fixed_pay_change: args.fixed_pay_change,
    payment_basis_threshold: threshold,
    worker_type: args.worker_type,
    schemes,
    blocking_reasons: blocking,
    basis:
      '平成30年3月1日 保発0301第8号・年発0301第1号 (通知改正) / 保保発0301第1号・年管管発0301第4号 (事務処理)。平成30年10月1日以降の随時改定から適用。',
    filing: {
      form: '被保険者報酬月額変更届の「⑱備考」欄の「6.その他」に〇し「年間平均」と記入、「⑯修正平均額」欄に年間平均額を記入',
      attachments: [
        '(様式1) 年間報酬の平均で算定することの申立書 (随時改定用)',
        '(様式2) 保険者算定申立に係る例年の状況、標準報酬月額の比較及び被保険者の同意等 (随時改定用)',
        '変動月以後3か月の固定的賃金と、変動月前9か月・以後3か月の非固定的賃金を記載した書類',
      ],
    },
  };
}

function annualScheme(scheme: Scheme, ordinary: number, annual: number) {
  const ord = virtualGrade(scheme, ordinary);
  const ann = virtualGrade(scheme, annual);
  return {
    qualifies: Math.abs(ann - ord) >= 2,
    ordinary_grade: realGrade(scheme, ordinary),
    annual_grade: realGrade(scheme, annual),
    extended_grade_gap: Math.abs(ann - ord),
    real_grade_gap: Math.abs(realGrade(scheme, annual) - realGrade(scheme, ordinary)),
  };
}

// ---------------------------------------------------------------------------

/** 固定的賃金にあたるか — 保発第4号 記2(2) と日本年金機構の列挙、および事例集. */
export const FIXED_PAY_GUIDANCE = {
  counts_as_change: [
    '昇給 (ベースアップ)・降給 (ベースダウン)',
    '給与体系の変更 (日給から月給への変更等)',
    '日給・時間給の基礎単価 (日当、単価) の変更',
    '請負給・歩合給等の単価、歩合率の変更',
    '住宅手当・役付手当等の固定的な手当の追加、支給額の変更',
    '上記の遡及適用によって差額支給を受ける場合',
    '一時帰休のため、継続して3か月を超えて通常の報酬より低額の休業手当等が支払われた場合',
    '一時帰休が解消され、継続して3か月を超えて通常の報酬が支払われるようになった場合',
    '通勤手当が支払われなくなる、支給方法が月額から日額単位に変更される等 (事例集 在宅勤務 問1)',
    '通勤手当のガソリン単価の変動 (月ごとに生じる場合も含む、事例集 問13)',
    '現物給与の標準価額の告示改正 (事例集 問12)',
    '実費弁償に当たらない在宅勤務手当の新設 (事例集 在宅勤務 問3)',
  ],
  does_not_count: [
    '休職による休職給 (保発第4号 記2(2) が明文で除外)',
    '減給制裁 (事例集 問11)',
    '産休等で通勤実績がないことによる通勤手当の不支給 — 手当自体が廃止された訳ではないため (事例集 問14)',
    '実費弁償分の算定に伴う在宅勤務手当額の月々の変動 (事例集 在宅勤務 問3)',
    '残業手当・能率手当等、非固定的賃金のみの変動',
  ],
  unverified: [
    '家族手当: 日本年金機構の列挙は「住宅手当、役付手当等」までで、家族手当を名指しした一次情報は確認できていません。一般定義には含まれる読みです。',
    '有給休暇日の支払基礎日数への算入: 日本年金機構・厚生労働省・協会けんぽのいずれの一次情報にも明示記述を確認できていません。月給者は暦日数なので当然に含まれますが、日給・時給者は解釈が残ります。',
    '年俸制の支払基礎日数: 「年俸」を明示した一次情報は確認できていません。構造上は月給者として暦日数になります。',
  ],
};

/** 支払基礎日数の数え方 — 平成18年5月12日 庁保険発第0512001号 記1. */
export const PAYMENT_BASIS_DAYS_GUIDANCE = {
  monthly_paid: '各月の暦日数',
  monthly_paid_with_absence_deduction:
    '就業規則・給与規程等に基づき事業所が定めた日数から欠勤日数を控除した日数',
  daily_paid: '各月の出勤日数',
  weekly_paid: '暦日数 (日本年金機構「随時改定」の説明による)',
  night_shift: {
    monthly: '各月の暦日数',
    daily: '給与支払いの基礎となった出勤回数',
    hourly: '各月の総労働時間を、その事業所における所定労働時間で除して得られた日数',
    source: '標準報酬月額の定時決定及び随時改定の事務取扱いに関する事例集 ○定時決定について 問1',
  },
  source: '平成18年5月12日 庁保険発第0512001号 記1',
};

export const REVISION_ATTRIBUTION = {
  source: 'e-Gov 法令検索 / 厚生労働省 法令等データベース / 日本年金機構',
  statutes: [
    { name: '健康保険法 第41条 (定時決定) / 第42条 (資格取得時決定) / 第43条 (随時改定) / 第43条の2 (育休終了時改定) / 第43条の3 (産休終了時改定)', url: 'https://laws.e-gov.go.jp/law/211AC0000000070' },
    { name: '厚生年金保険法 第21条 / 第22条 / 第23条 / 第23条の2 / 第23条の3', url: 'https://laws.e-gov.go.jp/law/329AC0000000115' },
    { name: '健康保険法施行規則 第24条の2 (短時間労働者の定義)', url: 'https://laws.e-gov.go.jp/law/215M10000008036' },
  ],
  notices: [
    { name: '昭和36年1月26日 保発第4号 (定時決定及び随時改定の取扱い)', url: 'https://www.mhlw.go.jp/web/t_doc?dataId=00tb1543&dataType=1&pageNo=1' },
    { name: '平成18年5月12日 庁保険発第0512001号 (支払基礎日数の取扱い)', url: 'https://www.mhlw.go.jp/web/t_doc?dataId=00tb4337&dataType=1&pageNo=1' },
    { name: '平成30年3月1日 保保発0301第1号・年管管発0301第4号 (随時改定の年間平均)', url: 'https://www.mhlw.go.jp/web/t_doc?dataId=00tc3223&dataType=1&pageNo=1' },
    { name: '令和4年3月18日 年管管発0318第1号・保保発0318第1号 (適用拡大)', url: 'https://www.mhlw.go.jp/web/t_doc?dataId=00tc6563&dataType=1&pageNo=1' },
  ],
  references: [
    { name: '日本年金機構 定時決定 (算定基礎届)', url: 'https://www.nenkin.go.jp/service/kounen/hokenryo/hoshu/20121017.html' },
    { name: '日本年金機構 随時改定 (月額変更届)', url: 'https://www.nenkin.go.jp/service/kounen/hokenryo/hoshu/20150515-02.html' },
    { name: '標準報酬月額の定時決定及び随時改定の事務取扱いに関する事例集', url: 'https://www.nenkin.go.jp/service/kounen/hokenryo/hoshu/20121017.files/jireisyu.pdf' },
  ],
  licence: '公共データ利用規約(第1.0版)',
  caveat:
    'This decides whether a filing is due; it is not the filing. 保険者算定 by 日本年金機構 can differ, and several cases turn on facts an API cannot see — whether a difference is "例年発生することが見込まれる", whether pay counts as 実費弁償. The grade tables are the FY2026 figures; 令和7年法律第74号 adds pension grades 33-35 from 2027-09-01, which will move the 665,000 yen boundary threshold with them.',
};
