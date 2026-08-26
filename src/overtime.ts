/**
 * 割増賃金 — 労働基準法第37条。
 *
 * 給与計算で毎月使う計算でありながら、このAPIには無かった。社会保険料と源泉徴収は
 * 出せても割増賃金が出せないなら、月次給与を最後まで回すことはできない。
 *
 * ## 率が単純でない理由
 *
 * 率は加算されるものと、されないものがある。深夜は時間外や休日に**重なる**ので
 * 足すが、時間外と法定休日は**排他**で、休日労働に時間外の割増は付かない。
 * 法定休日は「そもそも労働義務が無い日」なので、そこに時間外という概念が無い。
 *
 *   時間外                 25%以上   (37条1項)
 *   時間外が月60時間超      50%以上   (37条1項ただし書)
 *   法定休日               35%以上   (37条1項、平成6年政令第5号)
 *   深夜(22時〜5時)        25%以上   (37条4項) ← 上に加算
 *
 * 中小企業への60時間超50%の適用猶予は2023年4月1日に終了しており、いまは
 * 企業規模にかかわらず適用される。
 *
 * ## 算定基礎から除外する手当
 *
 * 労基法37条5項と施行規則21条が、7種類を**限定列挙**している。列挙されたもの
 * *だけ*が除外でき、名称ではなく実質で判断する。「家族手当」という名前でも
 * 扶養人数と無関係に一律支給なら除外できない。ここを間違えると割増賃金が
 * 過少になり、未払賃金になる。
 *
 * ## 端数処理
 *
 * 昭和63年基発第150号が認めているのは、1時間あたりの賃金額と割増賃金額の
 * 「50銭未満切捨て、50銭以上切上げ」のみ。労働時間そのものの切捨ては
 * 賃金の全額払い(24条)違反になる。1か月の合計時間数に限り、30分未満切捨て・
 * 30分以上切上げが認められる。
 */

/** 労基法37条5項・施行規則21条の限定列挙。名称ではなく実質で判断する。 */
export const EXCLUDABLE_ALLOWANCES = [
  { key: 'family', label: '家族手当', note: '扶養家族の人数に応じて支給されるものに限る。一律支給は除外できない。' },
  { key: 'commuting', label: '通勤手当', note: '通勤距離・実費に応じて支給されるものに限る。一律支給は除外できない。' },
  { key: 'separation', label: '別居手当', note: '' },
  { key: 'education', label: '子女教育手当', note: '' },
  { key: 'housing', label: '住宅手当', note: '住宅費用に応じて支給されるものに限る。一律の住宅手当は除外できない。' },
  { key: 'temporary', label: '臨時に支払われた賃金', note: '' },
  { key: 'over_one_month', label: '1か月を超える期間ごとに支払われる賃金', note: '賞与など。' },
] as const;

export const RATES = {
  overtime: 0.25,
  overtime_over_60h: 0.50,
  holiday: 0.35,
  night: 0.25,
} as const;

export const SIXTY_HOUR_THRESHOLD = 60;

export type OvertimeInput = {
  /** 月給のうち、割増賃金の算定基礎に含める額。 */
  base_monthly_pay: number;
  /** 月平均所定労働時間。年間所定労働日数×1日の所定労働時間÷12。 */
  monthly_scheduled_hours: number;
  /** 法定時間外労働の時間数（法定休日労働を除く）。 */
  overtime_hours?: number;
  /** うち深夜(22時〜5時)に当たる時間数。時間外と重複しうる。 */
  night_hours?: number;
  /** 法定休日に労働した時間数。 */
  holiday_hours?: number;
  /** うち深夜に当たる時間数。 */
  holiday_night_hours?: number;
  /** 端数処理を適用するか。昭和63年基発第150号。既定で適用。 */
  round?: boolean;
};

/** 昭和63年基発第150号: 50銭未満切捨て、50銭以上切上げ。 */
const roundYen = (v: number) => Math.floor(v + 0.5);

export function overtimePay(input: OvertimeInput) {
  const {
    base_monthly_pay: base,
    monthly_scheduled_hours: scheduled,
    overtime_hours: ot = 0,
    night_hours: night = 0,
    holiday_hours: hol = 0,
    holiday_night_hours: holNight = 0,
    round = true,
  } = input;

  if (scheduled <= 0) throw new Error('monthly_scheduled_hours must be greater than zero.');

  const rawHourly = base / scheduled;
  const hourly = round ? roundYen(rawHourly) : rawHourly;

  // 60時間を境に率が変わる。閾値までとそれ以降で分けて数える。
  const otNormal = Math.min(ot, SIXTY_HOUR_THRESHOLD);
  const otExcess = Math.max(0, ot - SIXTY_HOUR_THRESHOLD);

  const amount = (hours: number, rate: number) => {
    const v = hourly * hours * rate;
    return round ? roundYen(v) : Math.round(v * 100) / 100;
  };

  // 深夜は時間外・休日に「加算」される。時間外25% + 深夜25% = 50%であって、
  // 深夜分を別枠で全額払うのではない。
  const lines = {
    overtime: {
      hours: otNormal,
      rate: 1 + RATES.overtime,
      amount: amount(otNormal, 1 + RATES.overtime),
      basis: '労働基準法第37条第1項',
    },
    overtime_over_60h: {
      hours: otExcess,
      rate: 1 + RATES.overtime_over_60h,
      amount: amount(otExcess, 1 + RATES.overtime_over_60h),
      basis: '労働基準法第37条第1項ただし書。2023年4月1日から企業規模を問わず適用。',
    },
    holiday: {
      hours: hol,
      rate: 1 + RATES.holiday,
      amount: amount(hol, 1 + RATES.holiday),
      basis: '労働基準法第37条第1項、平成6年政令第5号',
    },
    night_premium: {
      hours: night + holNight,
      rate: RATES.night,
      amount: amount(night + holNight, RATES.night),
      basis: '労働基準法第37条第4項。時間外・休日の割増に加算される。',
    },
  };

  const total = Object.values(lines).reduce((a, l) => a + l.amount, 0);

  return {
    hourly_rate: {
      value: hourly,
      unrounded: Math.round(rawHourly * 100) / 100,
      basis: `${base.toLocaleString()}円 ÷ ${scheduled}時間`,
      rounding: round ? '50銭未満切捨て、50銭以上切上げ (昭和63年基発第150号)' : '端数処理なし',
    },
    lines,
    total: round ? total : Math.round(total * 100) / 100,
    notes: {
      night_is_additive:
        '深夜割増は時間外・休日割増に加算されます。時間外かつ深夜なら 1.25 + 0.25 = 1.5、' +
        '法定休日かつ深夜なら 1.35 + 0.25 = 1.6 です。',
      holiday_excludes_overtime:
        '法定休日労働に時間外割増は付きません。休日はそもそも労働義務が無い日なので、' +
        'そこに「所定を超える」という概念がないためです。法定休日と法定外休日(所定休日)の' +
        '区別は就業規則によるので、どちらかはこのAPIでは判定できません。',
      sixty_hour_scope:
        '60時間の算定に法定休日労働は含みません。法定外休日の労働は含みます。',
      base_pay:
        'base_monthly_pay には、労基法37条5項と施行規則21条が限定列挙する7種類を除いた額を' +
        '渡してください。除外できるかは名称ではなく実質で決まります。',
    },
    excludable_allowances: EXCLUDABLE_ALLOWANCES,
    statutes: ['労働基準法第37条', '労働基準法施行規則第21条', '昭和63年1月1日 基発第150号'],
  };
}

export const OVERTIME_ATTRIBUTION = {
  source: 'e-Gov 法令検索 / 厚生労働省',
  statutes: [
    { name: '労働基準法第37条 (時間外、休日及び深夜の割増賃金)', url: 'https://laws.e-gov.go.jp/law/322AC0000000049' },
    { name: '労働基準法施行規則第21条 (割増賃金の基礎に算入しない賃金)', url: 'https://laws.e-gov.go.jp/law/322M40000100023' },
  ],
  notices: [
    { name: '昭和63年1月1日 基発第150号 (端数処理)', url: 'https://www.mhlw.go.jp/web/t_doc?dataId=00tb0745&dataType=1&pageNo=1' },
  ],
  licence: '公共データ利用規約(第1.0版)',
  caveat:
    '率は法定の下限です。就業規則がこれを上回る場合は就業規則が優先します。法定休日と' +
    '法定外休日の区別、月平均所定労働時間、算定基礎から除外できる手当の実質判断は、' +
    'いずれも事業所ごとの事実によるため、このAPIでは判定できません。',
};
