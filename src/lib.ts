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

  // Japanese, with or without the 都/道/府/県 suffix
  const ja = q.replace(/[都道府県]$/, '');
  const jaHit = entries.find(([, v]) => v.prefecture_ja === ja);
  return jaHit ? jaHit[0] : null;
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
