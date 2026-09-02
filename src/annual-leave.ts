/**
 * 年次有給休暇 — 労働基準法第39条、同法施行規則第24条の3、同法第115条。
 *
 * 労務の相談でいちばん多い問いでありながら、このAPIには無かった。付与日数は
 * 勤続期間で階段状に上がり、週の所定日数が少ない人には別表が使われ、10日以上
 * 付与された人には年5日を取得させる義務がある。どれも条文に数字が書いてある。
 *
 * ## 条文から取った数字 (e-Gov 322AC0000000049 / 322M40000100023)
 *
 * 第39条第1項: 「六箇月」継続勤務し「全労働日」の「八割」以上出勤した労働者に
 * 「十労働日」。第2項の表が継続勤務年数ごとの加算日数を定める —
 * 一年:一労働日、二年:二労働日、三年:四労働日、四年:六労働日、五年:八労働日、
 * 六年以上:十労働日。合計すると 10, 11, 12, 14, 16, 18, 20 になる。
 * 20という数字は条文に書かれておらず、10+10 の結果である。
 *
 * 第39条第3項の「厚生労働省令で定める日数」が比例付与で、施行規則第24条の3が
 * 週の所定労働時間「三十時間」未満かつ週所定労働日数四日以下(または一年間の
 * 所定労働日数「二百十六日」以下)の者に別表を当てる。
 *
 * 第39条第7項が年「五日」の時季指定義務。第115条は「この法律の規定による」
 * 請求権を「二年」で時効消滅させるので、繰越しは1年分まで。
 */

/** 第39条第1項。六箇月継続勤務・全労働日の八割以上出勤で十労働日。 */
export const BASE_GRANT_DAYS = 10;
export const QUALIFYING_MONTHS = 6;
export const ATTENDANCE_THRESHOLD = 0.8;

/** 第39条第2項の表。6か月経過後、1年ごとの加算日数。 */
export const ESCALATION_EXTRA = [0, 1, 2, 4, 6, 8, 10] as const;

/** 通常付与の合計日数。index 0 = 6か月、以降1年ごと。6年6か月以降は20日で頭打ち。 */
export const FULL_GRANT = ESCALATION_EXTRA.map((e) => BASE_GRANT_DAYS + e);

/** 施行規則第24条の3。比例付与の対象になる上限。 */
export const PROPORTIONAL_HOURS_LIMIT = 30;
export const PROPORTIONAL_ANNUAL_LIMIT = 216;

/** 施行規則第24条の3の別表。days の index は FULL_GRANT と同じ並び。 */
export const PROPORTIONAL_TABLE = [
  { weekly_days: 4, annual_from: 169, annual_to: 216, days: [7, 8, 9, 10, 12, 13, 15] },
  { weekly_days: 3, annual_from: 121, annual_to: 168, days: [5, 6, 6, 8, 9, 10, 11] },
  { weekly_days: 2, annual_from: 73, annual_to: 120, days: [3, 4, 4, 5, 6, 6, 7] },
  { weekly_days: 1, annual_from: 48, annual_to: 72, days: [1, 2, 2, 2, 3, 3, 3] },
] as const;

/** 第39条第7項。10労働日以上付与された者に年5日。 */
export const FIVE_DAY_DUTY_THRESHOLD = 10;
export const FIVE_DAY_DUTY_DAYS = 5;

/** 第115条。この法律の規定による請求権は二年で時効消滅する。 */
export const CARRY_OVER_YEARS = 2;

const addMonths = (d: Date, n: number) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
  // 月末をまたぐとき日が繰り上がるのを戻す (1/31 + 1月 = 2/28)。
  if (x.getUTCDate() !== d.getUTCDate()) x.setUTCDate(0);
  return x;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

export type AnnualLeaveInput = {
  hired_on: Date;
  as_of: Date;
  attendance_rate?: number | null;
  weekly_days?: number | null;
  weekly_hours?: number | null;
  annual_days?: number | null;
  days_taken?: number | null;
};

/** 比例付与に当たるか。当たるなら別表の行を返す。 */
export function proportionalRow(input: {
  weekly_days?: number | null; weekly_hours?: number | null; annual_days?: number | null;
}) {
  const hours = input.weekly_hours ?? null;
  // 週30時間以上なら日数にかかわらず通常付与 (施行規則第24条の3)。
  if (hours !== null && hours >= PROPORTIONAL_HOURS_LIMIT) return null;

  // **`hours === null` で即 return していたので、annual_days の分岐に到達しなかった。**
  // 年間の所定労働日数は、週の日数が一定でない人のための代替指標として
  // 別表そのものが持っている欄で、それ単独で行が決まる。時間が要るのは
  // 「週4日以下でも30時間以上なら通常付与」を除くためであって、
  // 年間日数で引くときには関係しない。年52日(週1日相当)に20日を返していた。
  if (input.weekly_days != null) {
    if (hours === null) return null;   // 日数だけでは30時間以上かを判定できない
    if (input.weekly_days >= 5) return null;
    return PROPORTIONAL_TABLE.find((r) => r.weekly_days === Math.floor(input.weekly_days!)) ?? null;
  }
  if (input.annual_days != null) {
    if (input.annual_days > PROPORTIONAL_ANNUAL_LIMIT) return null;
    return PROPORTIONAL_TABLE.find(
      (r) => input.annual_days! >= r.annual_from && input.annual_days! <= r.annual_to) ?? null;
  }
  return null;
}

export function judgeAnnualLeave(input: AnnualLeaveInput) {
  const row = proportionalRow(input);
  const table = row ? row.days : FULL_GRANT;

  // 付与日は雇入れから6か月後、以降1年ごと。
  const grants: { on: string; index: number; days: number; service: string }[] = [];
  const first = addMonths(input.hired_on, QUALIFYING_MONTHS);
  for (let i = 0; ; i++) {
    const on = i === 0 ? first : addMonths(first, 12 * i);
    if (on > input.as_of) break;
    const idx = Math.min(i, table.length - 1);
    grants.push({
      on: iso(on),
      index: i,
      days: table[idx],
      service: i === 0 ? '6か月' : `${i}年6か月`,
    });
    if (i > 60) break;
  }

  const attendance = input.attendance_rate ?? null;
  const metAttendance = attendance === null ? null : attendance >= ATTENDANCE_THRESHOLD;

  const latest = grants.length ? grants[grants.length - 1] : null;
  const granted = latest && metAttendance !== false ? latest.days : 0;

  // 年5日の義務は「10労働日以上付与された」ことで生じる (第39条第7項)。
  const dutyApplies = granted >= FIVE_DAY_DUTY_THRESHOLD;
  const taken = input.days_taken ?? null;
  const deadline = latest ? iso(addMonths(new Date(latest.on + 'T00:00:00Z'), 12)) : null;

  return {
    // **判定していない要件を、通ったことにして true と言っていた。**
    // 第39条第1項の付与は「六箇月継続勤務」と「全労働日の八割以上出勤」の
    // 両方が要る。attendance_rate を渡されなければ後者は判定できないのに、
    // `metAttendance !== false` として true を返していた。
    //
    // MCP のツール説明はこう約束している —
    //   Without one the tool reports the eighty per cent test as not judged
    //   rather than assuming it passed.
    // `attendance.met` は null で守っていたが、**見出しの entitled が破っていた**。
    // 28件目(worker-type の insured)と同じ形。判定していないなら null。
    // 付与日が来ていなければ、出勤率にかかわらず false。
    entitled: latest === null ? false : metAttendance,
    proportional: row
      ? {
          applies: true,
          weekly_days: row.weekly_days,
          annual_days_range: [row.annual_from, row.annual_to],
          basis: '労働基準法施行規則第24条の3(週の所定労働時間が三十時間未満で、週所定労働日数が四日以下または一年間の所定労働日数が二百十六日以下)',
        }
      : { applies: false, basis: '労働基準法第39条第1項・第2項の通常付与' },
    attendance: {
      rate: attendance,
      threshold: ATTENDANCE_THRESHOLD,
      met: metAttendance,
      basis: '労働基準法第39条第1項「全労働日の八割以上出勤した労働者」',
      note: metAttendance === null
        ? 'attendance_rate を渡していないので、八割要件は判定していません。満たさない年は付与が生じません。'
        : null,
    },
    grants,
    current: latest
      ? {
          granted_on: latest.on,
          service: latest.service,
          days: granted,
          expires_on: iso(addMonths(new Date(latest.on + 'T00:00:00Z'), 12 * CARRY_OVER_YEARS)),
          basis: '労働基準法第115条(この法律の規定による請求権は二年間行わない場合に時効によつて消滅する)',
        }
      : null,
    five_day_duty: {
      applies: dutyApplies,
      required_days: dutyApplies ? FIVE_DAY_DUTY_DAYS : 0,
      taken,
      remaining: dutyApplies && taken !== null ? Math.max(0, FIVE_DAY_DUTY_DAYS - taken) : null,
      by: dutyApplies ? deadline : null,
      basis: '労働基準法第39条第7項(有給休暇の日数が十労働日以上である労働者に、五日について時季を定めることにより与えなければならない)',
      note: dutyApplies
        ? '労働者自らの請求・計画的付与により取得した日数はこの5日から差し引きます。'
        : '付与日数が10労働日未満なので、年5日の時季指定義務は生じません。',
    },
    statutes: ['労働基準法第39条', '労働基準法施行規則第24条の3', '労働基準法第115条'],
  };
}

export const ANNUAL_LEAVE_ATTRIBUTION = {
  source: 'e-Gov 法令検索',
  statutes: [
    { name: '労働基準法第39条 (年次有給休暇)', url: 'https://laws.e-gov.go.jp/law/322AC0000000049' },
    { name: '労働基準法施行規則第24条の3 (比例付与)', url: 'https://laws.e-gov.go.jp/law/322M40000100023' },
    { name: '労働基準法第115条 (時効)', url: 'https://laws.e-gov.go.jp/law/322AC0000000049' },
  ],
  licence: '公共データ利用規約(第1.0版)',
  caveat:
    '全労働日と出勤率の算定(業務上の負傷による休業、産前産後休業、育児介護休業、年次有給休暇を取得した日は' +
    '出勤したものとみなす)、計画的付与の労使協定、時季変更権の行使可否は、いずれも事業所ごとの事実によるため' +
    'このAPIでは判定できません。就業規則が法定を上回る付与を定めている場合はそちらが優先します。',
};
