/**
 * 被保険者区分の判定 — 健康保険法第3条第1項第9号。
 *
 * 週20時間・月8.8万円・学生かどうか。この3つに事業所の規模と雇用見込みを足した
 * 判断で、17日と11日という支払基礎日数の閾値が入れ替わる。**日本の社会保険で最も
 * 間違えやすい分類**でありながら、このAPIは `worker_type` を利用者に決めさせて
 * いた。間違えれば定時決定が無警告で誤答になる。判定できる材料は揃っているのに、
 * 判定そのものを渡していなかった。
 *
 * ## 条文の構造
 *
 * 第3条第1項第9号の本文が「四分の三」基準を置く。同一の事業所に使用される
 * 「通常の労働者」の1週間の所定労働時間および「一月間の所定労働日数」の4分の3
 * 以上であれば、そのまま被保険者になる。
 *
 * 4分の3に満たない者は原則として適用除外だが、イ〜ハのいずれにも当たらなければ
 * 被保険者になる。つまりイ〜ハは**除外条件**であって加入条件ではない。
 *
 *   イ 一週間の所定労働時間が二十時間未満であること
 *   ロ 報酬の月額が八万八千円未満であること(労働基準法第4条第3項各号の賃金を除く)
 *   ハ 学校教育法に規定する学生等であること
 *
 * 事業所の規模要件は第3条には無い。日本年金機構の公表による特定適用事業所の定義
 * (厚生年金保険の被保険者総数が1年のうち6月間以上51人以上と見込まれること)を使う。
 */

/** 四分の三基準 (健康保険法第3条第1項第9号本文)。 */
export const THREE_QUARTERS = 3 / 4;

/** 通常の労働者の1週間の所定労働時間を渡されなかったときの既定。労基法32条の上限。 */
export const DEFAULT_NORMAL_WEEKLY_HOURS = 40;

export const SHORT_TIME_TESTS = {
  weekly_hours: 20,
  monthly_wage: 88_000,
  employment_months: 2,
  workplace_insured_count: 51,
} as const;

/**
 * 人数要件は段階的に下がる。写した数字が腐る典型で、51人を定数で持つだけでは
 * 2027年10月に黙って誤る。予定を返して、利用者が自分の時点を確かめられるようにする。
 */
export const HEADCOUNT_SCHEDULE = [
  { from: '2024-10-01', insured_count: 51, note: '令和6年10月から。現行。' },
  { from: '2027-10-01', insured_count: 36, note: '予定。' },
  { from: '2029-10-01', insured_count: 21, note: '予定。' },
  { from: '2032-10-01', insured_count: 11, note: '予定。' },
] as const;

/**
 * 8.8万円に算入しない賃金。ここを足して判定すると、本来入らない人が入る。
 * 最低賃金法が賃金に算入しないものに相当するものを除く、という建て付け。
 */
export const EXCLUDED_FROM_WAGE_TEST = [
  '臨時に支払われる賃金(結婚手当など)',
  '1か月を超える期間ごとに支払われる賃金(賞与など)',
  '時間外・休日・深夜労働に対する割増賃金',
  '精皆勤手当',
  '通勤手当',
  '家族手当',
];

export type WorkerTypeInput = {
  weekly_hours: number;
  normal_weekly_hours?: number | null;
  monthly_days?: number | null;
  normal_monthly_days?: number | null;
  monthly_wage?: number | null;
  is_student?: boolean | null;
  workplace_insured_count?: number | null;
  employment_months?: number | null;
};

type Test = {
  key: string;
  label: string;
  passed: boolean | null;
  value: unknown;
  threshold: unknown;
  basis: string;
};

export function judgeWorkerType(input: WorkerTypeInput) {
  const normalWeekly = input.normal_weekly_hours ?? DEFAULT_NORMAL_WEEKLY_HOURS;
  const hoursRatio = input.weekly_hours / normalWeekly;
  const daysRatio =
    input.monthly_days != null && input.normal_monthly_days
      ? input.monthly_days / input.normal_monthly_days
      : null;

  // 本文の四分の三基準。時間と日数の両方が4分の3以上であることを要する。
  // 日数を渡されなければ時間だけで判定し、その旨を返す。
  const meetsThreeQuarters =
    hoursRatio >= THREE_QUARTERS && (daysRatio === null || daysRatio >= THREE_QUARTERS);

  if (meetsThreeQuarters) {
    // 通常の労働者と同じ時間数なら一般。下回るがなお4分の3以上なら短時間就労者。
    const isFullTime = input.weekly_hours >= normalWeekly;
    return {
      insured: true,
      worker_type: isFullTime ? ('general' as const) : ('part_time_short_hours' as const),
      payment_basis_threshold: 17,
      three_quarters: {
        met: true,
        hours_ratio: Math.round(hoursRatio * 1000) / 1000,
        days_ratio: daysRatio === null ? null : Math.round(daysRatio * 1000) / 1000,
        basis: '健康保険法第3条第1項第9号本文(同一の事業所に使用される通常の労働者の四分の三)',
        note: daysRatio === null
          ? '所定労働日数を渡していないので、1週間の所定労働時間だけで判定しています。条文は日数も要件にしているため、日数が4分の3未満なら結論は変わります。'
          : null,
      },
      tests: [] as Test[],
      reason: isFullTime
        ? '通常の労働者と同等の所定労働時間なので、一般の被保険者です。'
        : '四分の三基準を満たすため被保険者です。短時間就労者(いわゆるパート)として、定時決定では支払基礎日数17日で判定し、17日以上の月が無いときに限り15日以上の月による保険者算定があります(平成18年 庁保険発第0512001号)。',
      headcount_schedule: HEADCOUNT_SCHEDULE,
    };
  }

  // 4分の3未満。イ〜ハに当たらず、かつ特定適用事業所で、雇用見込みが2月を超えること。
  const tests: Test[] = [
    {
      key: 'weekly_hours',
      label: '1週間の所定労働時間が20時間以上',
      passed: input.weekly_hours >= SHORT_TIME_TESTS.weekly_hours,
      value: input.weekly_hours,
      threshold: SHORT_TIME_TESTS.weekly_hours,
      basis: '健康保険法第3条第1項第9号イ(一週間の所定労働時間が二十時間未満であること)',
    },
    {
      key: 'monthly_wage',
      label: '所定内賃金の月額が88,000円以上',
      passed: input.monthly_wage == null ? null : input.monthly_wage >= SHORT_TIME_TESTS.monthly_wage,
      value: input.monthly_wage ?? null,
      threshold: SHORT_TIME_TESTS.monthly_wage,
      basis: '健康保険法第3条第1項第9号ロ(労働基準法第4条第3項各号に掲げる賃金に相当するものを除いた報酬の月額が八万八千円未満であること)',
    },
    {
      key: 'is_student',
      label: '学生でない',
      // **渡されなければ「学生でない」と決めつけていた。**
      // 隣の3つ(賃金・事業所規模・雇用期間)は未指定なら null を返して
      // 「判定できない」と言うのに、ここだけ黙って合格にしていた。
      // 学生は第9号ハで適用除外なので、答えがひっくり返る要件。
      // MCP のツール説明はこう約束している —
      //   Ask rather than assume; the tool applies the tests to what you
      //   pass and names any it could not evaluate.
      // 28・30件目と同じ「判定していない要件を通ったことにする」型。
      passed: input.is_student == null ? null : !input.is_student,
      value: input.is_student ?? null,
      threshold: false,
      basis: '健康保険法第3条第1項第9号ハ(学校教育法に規定する学生等であること)',
    },
    {
      key: 'workplace_insured_count',
      label: '特定適用事業所(厚生年金保険の被保険者が51人以上)',
      passed: input.workplace_insured_count == null
        ? null
        : input.workplace_insured_count >= SHORT_TIME_TESTS.workplace_insured_count,
      value: input.workplace_insured_count ?? null,
      threshold: SHORT_TIME_TESTS.workplace_insured_count,
      basis: '日本年金機構「短時間労働者に対する健康保険・厚生年金保険の適用の拡大」(厚生年金保険の被保険者の総数が1年のうち6月間以上51人以上となることが見込まれる企業等)。健康保険法第3条には無く、実施機関の公表による。',
    },
    {
      key: 'employment_months',
      label: '雇用期間の見込みが2か月を超える',
      passed: input.employment_months == null
        ? null
        : input.employment_months > SHORT_TIME_TESTS.employment_months,
      value: input.employment_months ?? null,
      threshold: SHORT_TIME_TESTS.employment_months,
      basis: '健康保険法第3条第1項第2号(臨時に使用される者のうち二月以内の期間を定めて使用される者)',
    },
  ];

  const failed = tests.filter((t) => t.passed === false);
  const unknown = tests.filter((t) => t.passed === null);
  // **判定できないときも false と言っていた。**「被保険者にならない」と
  // 「判定できない」は違う答えで、reason は書き分けていたのに boolean は
  // どちらも false だった。`insured` だけを読む呼び出し側には区別が付かない。
  // このプロジェクトの他の判定は、判定していない項目を null で返している
  // (有給の attendance.met、下の tests[].passed)。ここだけ揃っていなかった。
  //
  // **確定で落ちた要件を、未判定の要件が隠していた(32件目)。**
  // 上の式は `unknown.length ? null : ...` だった。要件はすべて「かつ」なので、
  // 賃金が8.8万円未満と分かっていれば、学生かどうかを聞いていなくても
  // 被保険者にならない。それを「判定できません」と言っていた。
  // 順序は、確定の不該当 → 未判定 → 該当。reason も同じ順で書く。
  const insured: boolean | null =
    failed.length ? false : unknown.length ? null : true;

  return {
    insured,
    worker_type: insured ? ('short_time_insured' as const) : null,
    payment_basis_threshold: insured ? 11 : null,
    three_quarters: {
      met: false,
      hours_ratio: Math.round(hoursRatio * 1000) / 1000,
      days_ratio: daysRatio === null ? null : Math.round(daysRatio * 1000) / 1000,
      basis: '健康保険法第3条第1項第9号本文',
      note: null,
    },
    tests,
    reason: insured
      ? '四分の三基準は満たしませんが、第9号イからハのいずれにも当たらず、特定適用事業所に使用されるため被保険者です。定時決定の支払基礎日数は11日で判定します。'
      : failed.length
        ? `被保険者になりません。${failed.map((t) => t.label).join(' / ')} を満たしていないためです。`
        : `判定できません。${unknown.map((t) => t.key).join(', ')} が渡されていません。四分の三基準を満たさない人は、これらすべてを見ないと被保険者かどうかが決まりません。`,
    headcount_schedule: HEADCOUNT_SCHEDULE,
  };
}

export const WORKER_TYPE_ATTRIBUTION = {
  source: 'e-Gov 法令検索 / 日本年金機構',
  statutes: [
    { name: '健康保険法第3条第1項第9号 (被保険者)', url: 'https://laws.e-gov.go.jp/law/211AC0000000070' },
    { name: '厚生年金保険法第12条 (適用除外)', url: 'https://laws.e-gov.go.jp/law/329AC0000000115' },
    { name: '労働基準法第4条第3項 (賃金の範囲)', url: 'https://laws.e-gov.go.jp/law/322AC0000000049' },
  ],
  publications: [
    {
      name: '日本年金機構「短時間労働者に対する健康保険・厚生年金保険の適用の拡大」',
      url: 'https://www.nenkin.go.jp/service/kounen/tekiyo/jigyosho/tanjikan.html',
    },
  ],
  caveat:
    '「通常の労働者」が誰か、所定労働時間が何時間か、学生に当たるか(卒業見込みや夜間部の例外がある)は' +
    'いずれも事業所ごとの事実であり、このAPIでは決められません。渡された値をそのまま条文の要件に' +
    'あてはめた結果を返します。',
};
