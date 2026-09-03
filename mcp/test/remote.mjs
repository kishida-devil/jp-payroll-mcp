#!/usr/bin/env node
/**
 * remote MCP(Streamable HTTP)を、本物の MCP クライアントで叩く。
 *
 *   node mcp/test/remote.mjs                      # 本番 /mcp
 *   JP_PAYROLL_MCP_URL=http://127.0.0.1:8799/mcp node mcp/test/remote.mjs
 *
 * stdio 版の smoke.mjs は stdio で本物のクライアントを使う。こちらは HTTP で同じことをする。
 * 「curl で JSON-RPC が返る」と「MCP クライアントが繋げる」は別で、ヘッダやセッションの
 * 扱いで後者だけが落ちることがある。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.env.JP_PAYROLL_MCP_URL ?? 'https://japan-payroll-api.tsumugi.workers.dev/mcp';
let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label, detail) => {
  if (cond) pass++; else { fail++; failures.push(`${label} — ${detail ?? ''}`); }
};

const client = new Client({ name: 'jp-payroll-remote-test', version: '0' });
const transport = new StreamableHTTPClientTransport(new URL(URL_));
await client.connect(transport);

const { tools } = await client.listTools();
ok(tools.length === 30, 'lists 30 tools over HTTP', `${tools.length}`);

const cases = [
  ['get_minimum_wage', { prefecture: 'Tokyo' }, (j) => j?.hourly_wage > 0],
  ['calculate_payslip', { prefecture: 'Tokyo', monthly_salary: 300000, age: 40 }, (j) => j?.totals?.net_pay > 0],
  ['judge_worker_type', { weekly_hours: 25, normal_weekly_hours: 40, monthly_wage: 100000 }, (j) => j?.insured === null],
  ['calculate_year_end_adjustment', {
    total_pay: 8970000, withheld_tax: 156670, social_insurance: 1386102,
    life_insurance: { new_general: 80000, old_general: 35000, care_medical: 80000, new_pension: 30000, old_pension: 90000 },
    earthquake_insurance: { earthquake: 42000, old_long_term: 14800 }, spouse: { income: 500000 },
    dependants: { general: 1, specified: 1, elderly_cohabiting_parent: 1, under_23: 1 }, disabilities: { general: 1 },
    specified_relatives: [1000000], housing_loan_credit: 76500,
  }, (j) => j?.result?.annual_tax === 41400],
  ['estimate_resident_tax', {
    prefecture: 'Kanagawa', city: '横浜市', income_year: 2025, salary: 5500000, social_insurance: 394800,
    life_insurance: { new_general: 90000 }, earthquake_insurance: { earthquake: 20000 }, spouse: { income: 0 }, dependants: { general: 1, under_16: 1 },
  }, (j) => j?.annual_tax === 247900],
];
for (const [name, args, check] of cases) {
  const r = await client.callTool({ name, arguments: args });
  let json = null;
  try { json = JSON.parse(r.content?.[0]?.text ?? ''); } catch { /* not json */ }
  ok(!r.isError && check(json), `${name} answers over HTTP`, (r.content?.[0]?.text ?? '').slice(0, 100));
}
// 知らない引数は黙って捨てない(stdio 版と同じ包み)。
const bad = await client.callTool({ name: 'get_minimum_wage', arguments: { prefecture: 'Tokyo', zzz: 1 } });
ok(bad.isError === true && /unknown_parameter/.test(bad.content?.[0]?.text ?? ''), 'unknown arguments are refused over HTTP');

await client.close();
console.log(`  remote MCP ${URL_}`);
console.log(`  passed ${pass} / ${pass + fail}`);
if (fail) { console.log('  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
