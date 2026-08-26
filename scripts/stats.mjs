/**
 * どれくらい使われているかを1コマンドで見る。
 *
 * npm のダウンロード数は公開APIなので認証不要。Cloudflare と RapidAPI は
 * ダッシュボードを見るしかないので、そのURLだけ出す。
 *
 * 比較対象を一緒に出すのは意図的で、単独の数字は解釈できないため。週間30という
 * 数字は、隣が3なら健闘していて、隣が2,000なら届いていない。
 */

const PKG = 'jp-payroll-mcp';

// 同じ「日本の法令データを扱うMCP/データパッケージ」。
//
// tax-law-mcp を一度「2026-03で更新停止」と書いていたが、これは誤りだった。
// npm の最終公開日(0.5.4 / 2026-03-08)を開発状況と読み違えたもので、GitHub は
// 2026-08-23 に push がある(★94、アーカイブされていない)。npm に版を出していない
// ことと、作るのをやめたことは別。**現役の競合が週2,000台**というのが正しい読み。
// 止まった競合がその数字なら「保守だけで勝てる」が成り立つが、そうではない。
//
// 数字は下限の目安として見る。日本語圏の参照データがどこまで行くかの上限は
// japan-postal-code のほう。
const PEERS = [
  ['tax-law-mcp', '日本の税法MCP(現役。npm最終公開2026-03 / GitHub最終push2026-08)'],
  ['mcp-jp-paid-leave', '年次有給休暇MCP(2026-07公開)'],
  ['jp-money-data', '制度データJSON(最終更新2026-07)'],
  ['japan-postal-code', '郵便番号(日本向け参照データの上限例)'],
];

const PERIODS = ['last-day', 'last-week', 'last-month'];

async function downloads(pkg, period) {
  try {
    const r = await fetch(`https://api.npmjs.org/downloads/point/${period}/${pkg}`,
      { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return typeof j.downloads === 'number' ? j.downloads : null;
  } catch {
    return null;
  }
}

/** 直近14日を日別で。公開直後は「増えているか」しか判断材料がない。 */
async function daily(pkg) {
  try {
    const r = await fetch(`https://api.npmjs.org/downloads/range/last-week/${pkg}`,
      { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return Array.isArray(j.downloads) ? j.downloads : null;
  } catch {
    return null;
  }
}

const n = (v) => (v === null ? '  —' : String(v).padStart(5));

console.log(`\n  ${PKG}\n  ${'─'.repeat(52)}`);
for (const p of PERIODS) {
  const v = await downloads(PKG, p);
  console.log(`  ${p.padEnd(12)} ${n(v)}`);
}

const series = await daily(PKG);
if (series && series.some((d) => d.downloads > 0)) {
  console.log('\n  日別 (直近7日)');
  const max = Math.max(...series.map((d) => d.downloads), 1);
  for (const d of series)
    console.log(`  ${d.day}  ${String(d.downloads).padStart(4)} ${'█'.repeat(Math.round((d.downloads / max) * 30))}`);
} else {
  console.log('\n  日別データはまだありません。npm の集計は公開から1〜2日遅れます。');
}

console.log(`\n  比較対象 (週間)\n  ${'─'.repeat(52)}`);
for (const [pkg, note] of PEERS) {
  const v = await downloads(pkg, 'last-week');
  console.log(`  ${n(v)}  ${pkg.padEnd(20)} ${note}`);
}

console.log(`
  ${'─'.repeat(52)}
  npm      https://www.npmjs.com/package/${PKG}

  Worker   https://dash.cloudflare.com/ → Workers & Pages
           → japan-payroll-api → Metrics(件数・エラー率)
           → Logs(channel別。mcp / direct / rapidapi を分けて見る)

  RapidAPI https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants
           Studio → Analytics(購読者数・呼び出し数・エラー)
`);
