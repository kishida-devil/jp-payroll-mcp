import wc from './data/workers-comp-r6.json';

/**
 * 労災保険 (F-02).
 *
 * 全額事業主負担。健康保険・厚生年金・雇用保険は労使折半または一定割合の分担が
 * あるが、労災保険料は事業主が全部負担する(徴収法第31条は雇用保険分についてのみ
 * 被保険者負担を定めており、労災保険分には対応する規定が無い)。
 *
 * このAPIが「事業主負担の総額」を名乗る以上、これが欠けていると総額が必ず不足する。
 * 率は事業の種類ごとに 2.5/1000 から 88/1000 まで35倍の開きがあるので、
 * 「だいたい」で埋めることもできない。
 *
 * 扱っていないもの:
 *  - メリット制(継続事業の収支率による±40%の増減)。事業ごとの過去3年の
 *    給付実績が要るので、外から渡してもらう以外に決められない。
 *  - 建設事業の元請が請負金額×労務費率で計算する方式。賃金総額が使えない
 *    ケースで、別の入力が要る。
 *  - 一般拠出金(石綿健康被害救済法)と特別加入保険料率。
 */

export const WORKERS_COMP_META = wc.meta;
export const WORKERS_COMP_TYPES = wc.business_types;

const BY_NUMBER = new Map(wc.business_types.map((b) => [b.number, b]));

export type WorkersCompType = (typeof wc.business_types)[number];

/** Look up by the official 事業の種類の番号 ("02" … "99", "90"). */
export function workersCompType(raw: string | null | undefined): WorkersCompType | null {
  if (raw == null) return null;
  const q = String(raw).trim();
  if (!q) return null;
  // "2" and "02" are the same row; the official table prints two digits.
  const padded = /^\d$/.test(q) ? `0${q}` : q;
  return BY_NUMBER.get(padded) ?? null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 労災保険料。賃金総額に率を掛けたものを事業主が全額負担する。
 *
 * 賃金総額は雇用保険と同じ(徴収法第2条第2項)ので、通勤手当は入り実費弁償は入らない。
 */
export function workersCompPremium(wageBase: number, type: WorkersCompType) {
  const employer = round2(wageBase * type.rate);
  return {
    business_type: type.number,
    business_type_ja: type.label_ja,
    category_ja: type.category_ja,
    rate: type.rate,
    rate_per_1000: type.rate_per_1000,
    wage_base: round2(wageBase),
    employee: 0,
    employer,
    total: employer,
  };
}

export const WORKERS_COMP_ATTRIBUTION = {
  source: WORKERS_COMP_META.source,
  source_url: WORKERS_COMP_META.source_url,
  effective_from: WORKERS_COMP_META.effective_from,
  statutes: WORKERS_COMP_META.statutes,
  licence: {
    name: '公共データ利用規約(第1.0版) / Japan Public Data License v1.0',
    url: 'https://www.digital.go.jp/resources/open_data/public_data_license_v1.0',
  },
  attribution_ja: '出典：厚生労働省ホームページを加工して作成',
  excluded: WORKERS_COMP_META.excluded,
};
