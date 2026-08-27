import insurance from './data/insurance-r8.json';
import minwage from './data/minimum-wage.json';
import empins from './data/employment-insurance.json';

export { insurance, minwage, empins };

export type PrefKey = keyof typeof insurance.prefectures;

/** Resolve "Tokyo" | "tokyo" | "東京" | "東京都" | 13 to the canonical English key. */
export function resolvePrefecture(input: string | null): PrefKey | null {
  if (!input) return null;
  const q = String(input).trim();
  if (!q) return null;

  const entries = Object.entries(insurance.prefectures) as [PrefKey, { prefecture_ja: string; code: number }][];

  const asNum = Number(q);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= 47) {
    return entries.find(([, v]) => v.code === asNum)![0];
  }

  const lower = q.toLowerCase();
  const hit = entries.find(([en]) => en.toLowerCase() === lower);
  if (hit) return hit[0];

  // 接尾辞は1つしか正しくない。末尾を無条件に落とすと「東京府」が「東京」に
  // 一致してしまい、存在しない行政区画に料率を返すことになる。
  //
  // 北海道は名前そのものに「道」を含むので、剥がすと「北海」になって一致しない。
  // 剥がした形と剥がさない形の両方で当たりを探す。
  const stripped = q.replace(/[都道府県]$/, '');
  const jaHit = entries.find(([, v]) => v.prefecture_ja === q)
    ?? entries.find(([, v]) => v.prefecture_ja === stripped);
  if (!jaHit) return null;
  // 接尾辞なし、または正しい接尾辞のときだけ通す。
  const full = PREFECTURE_FULL_JA[jaHit[1].prefecture_ja];
  return q === jaHit[1].prefecture_ja || q === full ? jaHit[0] : null;
}

/**
 * 正式名称。接尾辞は1つしか正しくない。
 *
 * 公職選挙法 (e-Gov 325AC1000000100) の本文 1,722,869 字を照合して確定した。
 * 47件すべてが一意に決まり、都1(東京)・道1(北海道)・府2(京都・大阪)・県43。
 * 「東京府」「大阪県」「京都県」「北海道県」はいずれも本文に一度も現れない。
 *
 * 北海道は名前そのものに「道」を含むので、接尾辞を足さない。
 */
export const PREFECTURE_FULL_JA: Record<string, string> = {
  '北海道': '北海道',
  '青森': '青森県',
  '岩手': '岩手県',
  '宮城': '宮城県',
  '秋田': '秋田県',
  '山形': '山形県',
  '福島': '福島県',
  '茨城': '茨城県',
  '栃木': '栃木県',
  '群馬': '群馬県',
  '埼玉': '埼玉県',
  '千葉': '千葉県',
  '東京': '東京都',
  '神奈川': '神奈川県',
  '新潟': '新潟県',
  '富山': '富山県',
  '石川': '石川県',
  '福井': '福井県',
  '山梨': '山梨県',
  '長野': '長野県',
  '岐阜': '岐阜県',
  '静岡': '静岡県',
  '愛知': '愛知県',
  '三重': '三重県',
  '滋賀': '滋賀県',
  '京都': '京都府',
  '大阪': '大阪府',
  '兵庫': '兵庫県',
  '奈良': '奈良県',
  '和歌山': '和歌山県',
  '鳥取': '鳥取県',
  '島根': '島根県',
  '岡山': '岡山県',
  '広島': '広島県',
  '山口': '山口県',
  '徳島': '徳島県',
  '香川': '香川県',
  '愛媛': '愛媛県',
  '高知': '高知県',
  '福岡': '福岡県',
  '佐賀': '佐賀県',
  '長崎': '長崎県',
  '熊本': '熊本県',
  '大分': '大分県',
  '宮崎': '宮崎県',
  '鹿児島': '鹿児島県',
  '沖縄': '沖縄県',
};

/** 誤った接尾辞を指摘するために、正しい書き方を返す。拒むだけでは直せない。 */
export function suggestPrefecture(input: string | null): string | null {
  if (!input) return null;
  const q = String(input).trim();
  return PREFECTURE_FULL_JA[q] ?? PREFECTURE_FULL_JA[q.replace(/[都道府県]$/, '')] ?? null;
}

/**
 * Employee-share rounding per 協会けんぽ:
 * fraction <= 0.50 yen is truncated, > 0.50 yen is rounded up.
 * (Applies when the employer deducts the share from salary.)
 */
export function roundEmployeeShare(v: number): number {
  const floor = Math.floor(v);
  return v - floor > 0.5 ? floor + 1 : floor;
}

/** Grade row whose [remuneration_from, remuneration_to) contains `remuneration`. */
export function findGrade(remuneration: number) {
  const grades = insurance.grades;
  for (const g of grades) {
    const lo = g.remuneration_from ?? -Infinity;
    const hi = g.remuneration_to ?? Infinity;
    if (remuneration >= lo && remuneration < hi) return g;
  }
  return remuneration < (grades[0].remuneration_to ?? 0) ? grades[0] : grades[grades.length - 1];
}

const PENSION_GRADES = insurance.grades.filter((g) => g.pension_grade !== null);
const PENSION_MIN_SMR = PENSION_GRADES[0].standard_monthly_remuneration;
const PENSION_MAX_SMR = PENSION_GRADES[PENSION_GRADES.length - 1].standard_monthly_remuneration;

/** Pension uses grades 1-32 only; below/above the band it clamps. */
export function pensionStandardRemuneration(grade: ReturnType<typeof findGrade>) {
  if (grade.pension_grade !== null) {
    return { smr: grade.standard_monthly_remuneration, grade: grade.pension_grade, clamped: false as const };
  }
  const below = grade.standard_monthly_remuneration < PENSION_MIN_SMR;
  return {
    smr: below ? PENSION_MIN_SMR : PENSION_MAX_SMR,
    grade: below ? PENSION_GRADES[0].pension_grade! : PENSION_GRADES[PENSION_GRADES.length - 1].pension_grade!,
    clamped: true as const,
  };
}

/** 介護保険第2号被保険者: age 40-64. */
export function isLtcInsured(age: number | null): boolean {
  return age !== null && age >= 40 && age < 65;
}

/** Minimum wage in effect for a prefecture on a given ISO date (defaults to latest). */
/**
 * 収録済みで最も新しい発効日。改定に追いついているかの判定に使う。
 * 都道府県ごとに発効日が違う(最低賃金法第14条)ので、全県のうち最も新しいものを返す。
 */
export function latestMinimumWageEffectiveFrom(): string | null {
  let newest: string | null = null;
  for (const p of Object.values(minwage.prefectures as any)) {
    const hist = (p as any).history as { effective_from: string | null }[];
    for (const h of hist)
      if (h.effective_from && (newest === null || h.effective_from > newest)) newest = h.effective_from;
  }
  return newest;
}

export function minimumWageAt(pref: PrefKey, isoDate?: string | null) {
  const hist = (minwage.prefectures as any)[pref].history as {
    fiscal_year: number; era_year: string; hourly_wage: number; effective_from: string | null;
  }[];
  if (!isoDate) return { ...hist[hist.length - 1], latest: true };
  let found = null;
  for (const h of hist) {
    if (h.effective_from && h.effective_from <= isoDate) found = h;
  }
  return found ? { ...found, latest: found === hist[hist.length - 1] } : null;
}

/**
 * Licence terms differ by publisher, so they are stated per source rather than
 * as one blanket claim.
 *
 * 厚生労働省 and 国税庁 both publish under 公共データ利用規約(第1.0版) (PDL1.0),
 * which permits commercial use, redistribution and adaptation with attribution.
 *
 * 協会けんぽ is the exception: its site terms permit 引用・転載・複製 with
 * attribution but state 「全国健康保険協会に無断で改変を行うことはできません」,
 * and make no reference to PDL. What this API republishes from that source is
 * the premium rates and the grade table — numerical data. The Digital Agency's
 * own guidance on PDL1.0 states that 「数値データ、簡単な表・グラフ等は著作権に
 * よる保護の対象ではありません」, so the figures themselves sit outside copyright.
 * Attribution is given regardless.
 */
const PDL10 = {
  name: '公共データ利用規約(第1.0版) / Japan Public Data License v1.0',
  url: 'https://www.digital.go.jp/resources/open_data/public_data_license_v1.0',
};

export const ATTRIBUTION = {
  social_insurance: {
    source: insurance.meta.source,
    source_url: insurance.meta.source_url,
    effective_from: insurance.meta.effective_from,
    fiscal_year: insurance.meta.fiscal_year,
    licence:
      '全国健康保険協会 permits reproduction with attribution but prohibits modification without consent, and does not apply PDL1.0. Republished here as numerical rate data, which falls outside copyright protection.',
    attribution_ja: '出典：全国健康保険協会（協会けんぽ）保険料額表',
  },
  minimum_wage: {
    source: '厚生労働省 地域別最低賃金の全国一覧',
    source_url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/minimumichiran/',
    latest_fiscal_year: (minwage as any).latest_fiscal_year,
    licence: PDL10,
    attribution_ja: '出典：厚生労働省ホームページを加工して作成',
  },
  employment_insurance: {
    source: empins.meta.source,
    source_url: empins.meta.source_url,
    effective_from: empins.meta.effective_from,
    licence: PDL10,
    attribution_ja: '出典：厚生労働省ホームページを加工して作成',
  },
  disclaimer:
    'Derived from Japanese government sources. Not endorsed by, affiliated with, or guaranteed by any government agency. Figures were reshaped from the official files; verify against the source before relying on them for statutory filings.',
};
