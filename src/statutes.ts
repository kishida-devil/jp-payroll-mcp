import statutes from './data/statutes.json';

/**
 * 引用した条文の本文を返す層。
 *
 * このAPIはこれまで「健康保険法第43条による」と根拠を示すだけで、条文番号を受け取った
 * 利用者は e-Gov を開き直す必要があった。答えと根拠が別の場所にあるのは、根拠を示す
 * 意味を半分しか果たしていない。
 *
 * ただし本文を常に同梱はしない。レスポンスは既に大きく、判定結果を見たいだけの呼び出し
 * では条文本文は純粋なノイズになる。既定は引用のみ、`include=statute_text` で本文、
 * `GET /v1/statute` で単独取得、の3層にしている。
 *
 * 参照文字列の名寄せは scripts/extract-statutes.py の PROVISIONS が唯一の基準で、
 * コード中の引用がそこに無ければ検証スイートが落ちる。引用が「ただの文字列」ではなく
 * 「解決できる参照」であることが、この仕組み全体の前提になっている。
 */

type Provision = {
  law: string;
  caption: string | null;
  text: string;
  paragraphs?: { num: number; text: string }[];
  url: string;
};

const PROVISIONS = statutes.provisions as Record<string, Provision>;
const LAWS = statutes.laws as Record<string, {
  law_id: string; title: string; abbrev: string | null;
  law_num: string; enforced_from: string | null; url: string;
}>;

export const STATUTE_ATTRIBUTION = statutes.meta;
export const STATUTE_REFS = Object.keys(PROVISIONS);

/**
 * 実務で実際に書かれる略称。e-Gov も略称を返すが、それは公式の略称であって、
 * 現場の略称ではない。厚生年金保険法は e-Gov では「厚生年金法」だが、社労士が
 * 書くのはほぼ「厚年法」で、そちらで引くと解決できなかった。
 *
 * 展開先は正式名称ではなく **参照キーの接頭辞** であることに注意。労働保険徴収法の
 * 正式名称は「労働保険の保険料の徴収等に関する法律」だが、引用はどこでも
 * 「労働保険徴収法第11条」と書かれるので、参照キーもそちらを採っている。正式名称へ
 * 展開すると、かえって解決できなくなる。
 */
const ALIASES: Record<string, string> = {
  厚年法: '厚生年金保険法',
  厚生年金法: '厚生年金保険法',
  健保法: '健康保険法',
  健保則: '健康保険法施行規則',
  徴収法: '労働保険徴収法',
  労徴法: '労働保険徴収法',
  // **正式名称からの逆方向が抜けていた。**参照キーを略称に寄せたのは正しいが、
  // e-Gov からコピーしてきた人は正式名称で書く。他の7法令は正式名称で引けるのに、
  // この法令だけ 400 out_of_coverage になっていた。
  労働保険の保険料の徴収等に関する法律: '労働保険徴収法',
  子育て支援法: '子ども・子育て支援法',
};

/** 全角数字を含む引用も受け付ける。利用者がコピーしてくる文字列は一定しない。 */
const normalise = (ref: string) =>
  ref.trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '');

/**
 * 引用文字列を条文に解決する。
 *
 * 「健康保険法第43条第1項」のように項まで指定された引用は、条までで解決する。
 * 条文本文には項がすべて含まれるので、項の指定は絞り込みであって別の条文ではない。
 * 「健保法43条」のような略記や「第」の省略も、実際に書かれる形なので受ける。
 */
export function resolveStatute(raw: string): { ref: string; provision: Provision } | null {
  const ref = normalise(raw);
  if (PROVISIONS[ref]) return { ref, provision: PROVISIONS[ref] };

  // 候補を先に広げてから、まとめて最長前方一致を採る。以前は「第」の補完で一度
  // 解決を試み、失敗してから略称展開に進んでいたため、「健保法43条」のように両方の
  // 変形が要る引用が漏れていた。変形は互いに独立なので、順に試すのではなく全部を
  // 候補に入れるのが正しい。
  const variants = new Set<string>([ref]);
  const withDai = (s: string) => s.replace(/(法|規則|令)([0-9])/, '$1第$2');
  variants.add(withDai(ref));

  // 略称は長いものから試す。「健保法施行規則」が「健保法」に食われると、
  // 規則の条文が法律の条文に解決してしまう。
  const abbrevs = [
    ...Object.entries(ALIASES),
    ...Object.entries(LAWS)
      .filter(([, m]) => m.abbrev)
      .map(([name, m]) => [m.abbrev as string, name] as [string, string]),
  ].sort((a, b) => b[0].length - a[0].length);

  for (const [abbrev, full] of abbrevs) {
    if (ref.startsWith(abbrev)) {
      const expanded = full + ref.slice(abbrev.length);
      variants.add(expanded);
      variants.add(withDai(expanded));
      break;
    }
  }

  // 最長一致でなければならない。短い方から採ると「第43条」が「第4条」に解決する。
  const hit = STATUTE_REFS
    .filter((r) => [...variants].some((v) => v.startsWith(r)))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? { ref: hit, provision: PROVISIONS[hit] } : null;
}

export function statuteDetail(ref: string) {
  const hit = resolveStatute(ref);
  if (!hit) return null;
  const law = LAWS[hit.provision.law];
  return {
    ref: hit.ref,
    law: {
      name: hit.provision.law,
      abbrev: law?.abbrev ?? null,
      law_num: law?.law_num ?? null,
      enforced_from: law?.enforced_from ?? null,
      url: law?.url ?? null,
    },
    caption: hit.provision.caption,
    text: hit.provision.text,
    ...(hit.provision.paragraphs ? { paragraphs: hit.provision.paragraphs } : {}),
    url: hit.provision.url,
  };
}

/**
 * レスポンスが引用した条文をまとめて解決する。
 *
 * 引用は `statutes: [...]`、`statute`、`notice` など置き場所が一定でないので、
 * 構造を歩いて拾う。解決できなかったものは黙って捨てず、`unresolved` に残す —
 * 引用したのに本文を返せない条文は、登録漏れとして見えている必要がある。
 */
/**
 * 引用は決まった場所には無い。`statutes: [...]` の配列にあることも、
 * `{name: "健康保険法第41条 (定時決定) / 第43条 (随時改定)"}` のように属性値の中に
 * あることも、`blocking_reasons` の説明文の途中にあることもある。
 *
 * 最初はキー名で絞り込んでいたが、それだと `name` の下の引用を取りこぼした。
 * 文字列を全部見て、その中に現れる引用を正規表現で拾う方が確実で、しかも説明文中の
 * 引用まで解決できる。1つの文字列に複数の条文が書かれていても全部拾える。
 */
const CITATION = new RegExp(
  '(' + [...new Set([
    ...Object.keys(LAWS),
    ...Object.values(LAWS).map((m) => m.abbrev).filter(Boolean) as string[],
    ...Object.keys(ALIASES),
    ...STATUTE_REFS.map((r) => r.replace(/第[0-9]+条.*$/, '')),
  ])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)   // 長い名前を先に。部分一致に食われないため
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') + ')' +
  '(第?[0-9０-９]+条(?:の[0-9０-９]+)*)?',
  'g');

/**
 * 収録の有無にかかわらず、条文の引用らしい文字列を拾う網。
 *
 * `CITATION` は収録している8法令の名前から組み立てているので、**収録していない
 * 法令の引用は、そもそも目に入らない**。労働基準法第39条は有給の応答が必ず引く
 * のに、この網の外にいた。解決には使わない — 「見えている」ことだけが目的。
 *
 * 3文字以上に限るのは「同法第156条」を法令名として拾わないため。通達
 * (「昭和63年1月1日 基発第150号」など)は法令ではないので対象外。
 */
const CITATION_ANY = new RegExp(
  '([\u4e00-\u9fff\u30a1-\u30f6\u30fc]{3,14}(?:法|規則|令))' +
  '(第[0-9０-９]+条(?:の[0-9０-９]+)*)', 'g');

export function attachStatuteText(payload: unknown) {
  const refs = new Set<string>();
  // **黙って捨てていた。**この関数の説明は最初から「解決できなかったものは
  // `unresolved` に残す」と書いてあったのに、返り値にその欄が無かった。
  // 引用したのに本文を返せない条文は、登録漏れとして見えている必要がある——
  // 21件目(労働保険徴収法の正式名称)は、まさにこの欄が無かったから隠れていた。
  const unresolved = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(CITATION)) {
      const hit = resolveStatute(m[0]);
      if (hit) refs.add(hit.ref);
    }
    for (const m of s.matchAll(CITATION_ANY)) {
      const ref = m[1] + m[2];
      if (!resolveStatute(ref)) unresolved.add(ref);
    }
  };
  const walk = (node: unknown): void => {
    if (typeof node === 'string') return scan(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(payload);

  const resolved: Record<string, ReturnType<typeof statuteDetail>> = {};
  for (const r of refs) resolved[r] = statuteDetail(r);
  return {
    count: refs.size,
    provisions: resolved,
    // 収録しているのは8法令で、それは設計どおり。**足りないことではなく、
    // 足りないと言わないことが誤りだった。**引けなかった引用をそのまま返す。
    unresolved: [...unresolved].sort(),
    ...(refs.size === 0 && unresolved.size === 0
      ? { note: 'この答えは条文を引用していないので、添える本文もありません。' }
      : {}),
    ...(unresolved.size > 0
      ? { unresolved_note: 'これらは引用していますが本文を同梱していません。'
          + '収録は8法令で、範囲外の条文は近いもので代用せず、そのまま名前だけを示します。' }
      : {}),
    attribution: STATUTE_ATTRIBUTION,
  };
}

export const STATUTE_INDEX = STATUTE_REFS.map((ref) => ({
  ref,
  law: PROVISIONS[ref].law,
  caption: PROVISIONS[ref].caption,
  url: PROVISIONS[ref].url,
}));

export const STATUTE_LAWS = LAWS;
