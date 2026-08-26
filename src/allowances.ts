/**
 * 支給項目 — 給与を「基本給 + 手当」の配列として扱う。
 *
 * 単一の `monthly_salary` に潰している限り、通勤手当は表現できない。
 * 通勤手当は社会保険では**報酬に含み**(健康保険法第3条第5項: 名称の如何を問わず
 * 労働者が労務の対償として受けるもの)、所得税では**一定額まで非課税**
 * (所得税法第9条第1項第5号、所得税法施行令第20条の2)。同じ1円が、社会保険では
 * 課され所得税では課されない。この食い違いが月次給与計算の根幹で、支給額を1つの
 * 数値に潰すと構造的に正しい答えが出せない。
 *
 * 実費弁償(出張旅費など)はさらに別で、労務の対償ではないので報酬にも賃金にも
 * 入らず、所得税もかからない。
 */

/**
 * 交通機関通勤の1か月の非課税限度額。
 * 国税庁 タックスアンサー No.2582(令和8年4月1日現在法令等)。
 */
export const TRANSIT_CEILING = 150000;

/**
 * 交通用具(マイカー・自転車等)で通勤する人の、片道の通勤距離ごとの
 * 1か月の非課税限度額。
 *
 * 国税庁 タックスアンサー No.2585(令和8年4月1日現在法令等)。
 * 片道2km未満は全額課税。
 */
export const VEHICLE_BANDS: ReadonlyArray<{
  from_km: number; to_km: number | null; limit: number; label_ja: string;
}> = [
  { from_km: 0, to_km: 2, limit: 0, label_ja: '2キロメートル未満(全額課税)' },
  { from_km: 2, to_km: 10, limit: 4200, label_ja: '2キロメートル以上10キロメートル未満' },
  { from_km: 10, to_km: 15, limit: 7300, label_ja: '10キロメートル以上15キロメートル未満' },
  { from_km: 15, to_km: 25, limit: 13500, label_ja: '15キロメートル以上25キロメートル未満' },
  { from_km: 25, to_km: 35, limit: 19700, label_ja: '25キロメートル以上35キロメートル未満' },
  { from_km: 35, to_km: 45, limit: 25900, label_ja: '35キロメートル以上45キロメートル未満' },
  { from_km: 45, to_km: 55, limit: 32300, label_ja: '45キロメートル以上55キロメートル未満' },
  { from_km: 55, to_km: 65, limit: 38700, label_ja: '55キロメートル以上65キロメートル未満' },
  { from_km: 65, to_km: 75, limit: 45700, label_ja: '65キロメートル以上75キロメートル未満' },
  { from_km: 75, to_km: 85, limit: 52700, label_ja: '75キロメートル以上85キロメートル未満' },
  { from_km: 85, to_km: 95, limit: 59600, label_ja: '85キロメートル以上95キロメートル未満' },
  { from_km: 95, to_km: null, limit: 66400, label_ja: '95キロメートル以上' },
];

export const COMMUTING_SOURCE = {
  source: '国税庁 タックスアンサー No.2585(マイカー・自転車通勤者の通勤手当) / No.2582(電車・バス通勤者の通勤手当)',
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2585.htm',
  statutes: ['所得税法第9条第1項第5号', '所得税法施行令第20条の2'],
  as_of: '令和8年4月1日現在法令等',
  note: '駐車場等の利用料は距離区分の額に月5,000円まで加算される(片道2キロメートル以上に限る)。' +
    'その額は「財務省令で定める金額」なので、実際に負担した額をそのまま渡してよいとは限らない。',
};

/**
 * 交通用具通勤者が負担する駐車場等の利用料の、1か月の非課税加算額の上限。
 * 距離区分の額に**加算**されるもので、単独で使えるものではない。片道2キロメートル
 * 未満の者は距離区分が全額課税なので、加算も生じない。
 *
 * 所得税法施行令第20条の2(令和8年4月1日施行)。条文は「当該金額が五千円を超える
 * ときは、五千円」。五万円ではない。
 */
export const PARKING_CAP = 5000;

export function vehicleBand(km: number) {
  return VEHICLE_BANDS.find((b) => km >= b.from_km && (b.to_km === null || km < b.to_km))!;
}

export type AllowanceKind = 'base' | 'commuting' | 'taxable' | 'reimbursement';

export const ALLOWANCE_KINDS: readonly AllowanceKind[] = ['base', 'commuting', 'taxable', 'reimbursement'];

export const ALLOWANCE_KIND_MEANING: Record<AllowanceKind, string> = {
  base: '基本給。課税され、報酬にも賃金にも入る。',
  commuting: '通勤手当。報酬・賃金には全額入るが、所得税は非課税限度額まで課されない。',
  taxable: '課税手当(役職手当・住宅手当・家族手当など)。課税され、報酬にも賃金にも入る。',
  reimbursement: '実費弁償(出張旅費など)。労務の対償ではないので報酬にも賃金にも入らず、課税もされない。',
};

export type AllowanceInput = {
  name?: string;
  amount: number;
  kind: AllowanceKind;
  /** 交通用具通勤の片道距離(km)。渡すと距離区分表で限度額が決まる。 */
  distance_km?: number | null;
  /** 交通機関の運賃・有料道路料金の合理的な額。併用のとき距離区分の額に足される。 */
  fare?: number | null;
  /**
   * 通勤のために負担する駐車場等の利用料(1か月)。距離区分の額に月5,000円まで
   * 加算される。交通用具通勤の制度なので `distance_km` と併せてのみ意味を持つ。
   */
  parking?: number | null;
};

const round2 = (v: number) => Math.round(v * 100) / 100;

export type CommutingExemption = {
  non_taxable: number;
  taxable: number;
  limit: number;
  distance_km: number | null;
  band: string | null;
  /** 駐車場等の利用料のうち、限度額に加算された分。 */
  parking_added: number;
  basis: string;
};

/**
 * 1つの通勤手当の非課税限度額を出す。
 *
 * 距離を渡さなければ交通機関のみとみなし、合理的な運賃等の額(既定では支給額そのもの)
 * が限度で、月15万円で頭打ち。距離を渡せば距離区分表の額が限度。両方渡せば併用で、
 * 「距離区分の額 + 運賃等の額」が限度、合計で月15万円が上限。
 */
export function commutingExemption(a: {
  amount: number; distance_km?: number | null; fare?: number | null; parking?: number | null;
}): CommutingExemption {
  const km = a.distance_km ?? null;
  const fare = a.fare ?? null;
  // 距離区分が無い(交通機関のみ・片道2km未満)なら加算は生じない。
  const parking = km !== null && km >= 2 ? Math.min(a.parking ?? 0, PARKING_CAP) : 0;

  let limit: number;
  let band: string | null = null;
  let basis: string;

  if (km === null) {
    limit = Math.min(fare ?? a.amount, TRANSIT_CEILING);
    basis = '交通機関のみ: 1か月当たりの合理的な運賃等の額。最高限度 150,000円 (No.2582)。';
  } else {
    const b = vehicleBand(km);
    band = b.label_ja;
    const parkText = parking > 0 ? ` + 駐車場等の利用料 ${parking.toLocaleString()}円(上限5,000円)` : '';
    if (fare === null) {
      limit = Math.min(b.limit + parking, TRANSIT_CEILING);
      basis = km < 2
        ? '交通用具のみ: 片道2キロメートル未満は全額課税 (No.2585)。駐車場等の利用料の加算も生じない。'
        : `交通用具のみ: 片道${km}キロメートルは「${b.label_ja}」の区分で ${b.limit.toLocaleString()}円${parkText} (No.2585)。`;
    } else {
      limit = Math.min(b.limit + fare + parking, TRANSIT_CEILING);
      basis = `併用: 距離区分の額 ${b.limit.toLocaleString()}円 + 合理的な運賃等の額 ${fare.toLocaleString()}円${parkText}。` +
        '合計の最高限度 150,000円 (No.2585)。';
    }
  }

  const nonTaxable = Math.min(a.amount, Math.max(0, limit));
  return {
    non_taxable: round2(nonTaxable),
    taxable: round2(a.amount - nonTaxable),
    limit: round2(limit),
    distance_km: km,
    band,
    parking_added: round2(parking),
    basis,
  };
}

export type ResolvedItem = {
  name: string;
  amount: number;
  kind: AllowanceKind;
  taxable: number;
  non_taxable: number;
  /** 社会保険の報酬・雇用保険の賃金に算入されるか。 */
  remunerative: boolean;
  commuting?: CommutingExemption;
};

export type Earnings = {
  items: ResolvedItem[];
  gross: number;
  taxable: number;
  non_taxable: number;
  /** 標準報酬月額を引き直すときの基礎(健康保険法第3条第5項の報酬)。 */
  remuneration_basis: number;
  /** 雇用保険料の基礎になる賃金総額(徴収法第2条第2項)。 */
  employment_insurance_basis: number;
};

const DEFAULT_NAME: Record<AllowanceKind, string> = {
  base: '基本給',
  commuting: '通勤手当',
  taxable: '課税手当',
  reimbursement: '実費弁償',
};

/**
 * 基本給と手当の配列を、明細に出せる形に解決する。
 *
 * 通勤手当が複数あっても非課税は合計で月15万円が上限なので、並び順に積み上げて
 * 打ち切る。超えた分は課税に回る。
 */
export function resolveEarnings(base: number, allowances: AllowanceInput[] = []): Earnings {
  const items: ResolvedItem[] = [{
    name: DEFAULT_NAME.base, amount: round2(base), kind: 'base',
    taxable: round2(base), non_taxable: 0, remunerative: true,
  }];

  let commutingExempt = 0;

  for (const a of allowances) {
    const name = a.name && String(a.name).trim() ? String(a.name) : DEFAULT_NAME[a.kind];
    const amount = round2(a.amount);

    if (a.kind === 'commuting') {
      const ex = commutingExemption({ amount, distance_km: a.distance_km, fare: a.fare, parking: a.parking });
      // 非課税は1か月あたりの合計で15万円が上限。先に来た項目から埋める。
      const headroom = Math.max(0, TRANSIT_CEILING - commutingExempt);
      const nonTaxable = Math.min(ex.non_taxable, headroom);
      commutingExempt = round2(commutingExempt + nonTaxable);
      items.push({
        name, amount, kind: 'commuting',
        taxable: round2(amount - nonTaxable), non_taxable: round2(nonTaxable),
        remunerative: true,
        commuting: { ...ex, non_taxable: round2(nonTaxable), taxable: round2(amount - nonTaxable) },
      });
      continue;
    }

    if (a.kind === 'reimbursement') {
      items.push({
        name, amount, kind: 'reimbursement',
        taxable: 0, non_taxable: amount, remunerative: false,
      });
      continue;
    }

    // base / taxable — 課税され、報酬にも賃金にも入る。
    items.push({
      name, amount, kind: a.kind,
      taxable: amount, non_taxable: 0, remunerative: true,
    });
  }

  const sum = (f: (i: ResolvedItem) => number) => round2(items.reduce((acc, i) => acc + f(i), 0));

  return {
    items,
    gross: sum((i) => i.amount),
    taxable: sum((i) => i.taxable),
    non_taxable: sum((i) => i.non_taxable),
    remuneration_basis: sum((i) => (i.remunerative ? i.amount : 0)),
    employment_insurance_basis: sum((i) => (i.remunerative ? i.amount : 0)),
  };
}

/** Validate one allowance from untrusted JSON. Returns the reason it failed, or null. */
export function allowanceError(a: unknown, index: number): string | null {
  const where = `allowances[${index}]`;
  if (typeof a !== 'object' || a === null || Array.isArray(a))
    return `${where} must be an object.`;
  const o = a as Record<string, unknown>;

  const amount = Number(o.amount);
  if (o.amount === undefined || !Number.isFinite(amount) || amount < 0)
    return `${where}.amount is required and must be a non-negative number.`;

  const kind = o.kind === undefined ? 'taxable' : String(o.kind);
  if (!ALLOWANCE_KINDS.includes(kind as AllowanceKind))
    return `${where}.kind is "${kind}"; use one of ${ALLOWANCE_KINDS.join(', ')}.`;

  if (o.name !== undefined && typeof o.name !== 'string')
    return `${where}.name must be a string.`;

  if (o.distance_km !== undefined && o.distance_km !== null) {
    const km = Number(o.distance_km);
    if (!Number.isFinite(km) || km < 0)
      return `${where}.distance_km must be a non-negative number of kilometres (one way).`;
    if (kind !== 'commuting')
      return `${where}.distance_km only means something on a "commuting" item.`;
  }

  if (o.fare !== undefined && o.fare !== null) {
    const fare = Number(o.fare);
    if (!Number.isFinite(fare) || fare < 0)
      return `${where}.fare must be a non-negative number of yen.`;
    if (kind !== 'commuting')
      return `${where}.fare only means something on a "commuting" item.`;
  }

  if (o.parking !== undefined && o.parking !== null) {
    const parking = Number(o.parking);
    if (!Number.isFinite(parking) || parking < 0)
      return `${where}.parking must be a non-negative number of yen per month.`;
    if (kind !== 'commuting')
      return `${where}.parking only means something on a "commuting" item.`;
    if (o.distance_km === undefined || o.distance_km === null)
      return `${where}.parking is an addition to the distance band, so it needs distance_km alongside it.`;
  }

  return null;
}

/** Coerce a validated allowance. Call only after `allowanceError` returned null. */
export function readAllowance(a: unknown): AllowanceInput {
  const o = a as Record<string, unknown>;
  return {
    name: o.name === undefined ? undefined : String(o.name),
    amount: Number(o.amount),
    kind: (o.kind === undefined ? 'taxable' : String(o.kind)) as AllowanceKind,
    distance_km: o.distance_km === undefined || o.distance_km === null ? null : Number(o.distance_km),
    fare: o.fare === undefined || o.fare === null ? null : Number(o.fare),
    parking: o.parking === undefined || o.parking === null ? null : Number(o.parking),
  };
}
