/**
 * Failure-path checks.
 *
 * The happy path is the easy half. What decides whether this package is usable in
 * practice is what an assistant is told when the network is down, the origin is
 * slow, or something returns HTML instead of JSON — because in every one of those
 * cases the model's next move is chosen from the error text alone. An error that
 * says only "request failed" produces a confident hallucinated payslip instead.
 *
 * Each case here spawns the server against a deliberately broken origin.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.mjs');

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label, detail) => {
  if (cond) pass++;
  else { fail++; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); }
};

async function withServer(env, fn) {
  const client = new Client({ name: 'failure-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entry], env: { ...process.env, ...env },
  }));
  try { return await fn(client); } finally { await client.close(); }
}

const listen = (handler) => new Promise((resolve) => {
  const srv = createServer(handler);
  srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});

// --- 1. origin unreachable --------------------------------------------------
{
  // Port 1 is reserved and nothing listens there, so the connection is refused
  // immediately rather than hanging.
  await withServer({ JP_PAYROLL_API_URL: 'http://127.0.0.1:1' }, async (c) => {
    const r = await c.callTool({ name: 'check_data_freshness', arguments: {} });
    const text = r.content?.[0]?.text ?? '';
    ok(r.isError === true, 'unreachable origin is reported as an error');
    ok(text.includes('127.0.0.1:1'), 'and names the address it tried', text.slice(0, 160));
    ok(/could not reach/i.test(text), 'in words the model can act on', text.slice(0, 160));
  });
}

// --- 2. origin too slow -----------------------------------------------------
{
  const { srv, port } = await listen(() => { /* never responds */ });
  // Above the 1000ms floor, so this checks the setting is honoured rather than
  // the clamp. Case 8 below covers values the clamp has to rescue.
  await withServer({
    JP_PAYROLL_API_URL: `http://127.0.0.1:${port}`,
    JP_PAYROLL_TIMEOUT_MS: '1500',
  }, async (c) => {
    const started = Date.now();
    const r = await c.callTool({ name: 'check_data_freshness', arguments: {} });
    const elapsed = Date.now() - started;
    const text = r.content?.[0]?.text ?? '';
    ok(r.isError === true, 'a hanging origin times out rather than blocking forever');
    ok(elapsed >= 1400 && elapsed < 6000, 'and the setting is actually honoured', `${elapsed}ms`);
    ok(text.includes('1500'), 'the message states the limit in force', text.slice(0, 160));
    ok(text.includes('JP_PAYROLL_TIMEOUT_MS'), 'and how to raise it', text.slice(0, 160));
  });
  srv.close();
}

// --- 3. origin returns HTML (a proxy or captive portal) ---------------------
{
  const { srv, port } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>Sign in to your network</body></html>');
  });
  await withServer({ JP_PAYROLL_API_URL: `http://127.0.0.1:${port}` }, async (c) => {
    const r = await c.callTool({ name: 'check_data_freshness', arguments: {} });
    const text = r.content?.[0]?.text ?? '';
    ok(r.isError === true, 'a non-JSON body is an error, not silently parsed');
    ok(text.includes('Sign in'), 'and the actual body is shown so the cause is visible',
       text.slice(0, 160));
  });
  srv.close();
}

// --- 4. origin returns a 500 ------------------------------------------------
{
  const { srv, port } = await listen((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error', code: 'internal_error' }));
  });
  await withServer({ JP_PAYROLL_API_URL: `http://127.0.0.1:${port}` }, async (c) => {
    const r = await c.callTool({ name: 'check_data_freshness', arguments: {} });
    const text = r.content?.[0]?.text ?? '';
    ok(r.isError === true, 'a 500 is reported as an error');
    ok(text.includes('internal_error'), 'with the origin\'s own code preserved', text.slice(0, 160));
  });
  srv.close();
}

// --- 5. a 400 must survive intact so the model can fix its arguments --------
{
  const { srv, port } = await listen((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Unknown prefecture: "Kyouto"',
      code: 'unknown_prefecture',
      hint: 'Accepts English name ("Tokyo"), Japanese ("東京"), or JIS code 1-47.',
    }));
  });
  await withServer({ JP_PAYROLL_API_URL: `http://127.0.0.1:${port}` }, async (c) => {
    const r = await c.callTool({
      name: 'calculate_payslip', arguments: { prefecture: 'Kyouto', monthly_salary: 350000 },
    });
    const text = r.content?.[0]?.text ?? '';
    ok(r.isError === true, 'a 400 is an error');
    ok(text.includes('unknown_prefecture'), 'the stable code survives', text.slice(0, 200));
    ok(text.includes('JIS code'), 'and so does the hint — this is what lets a retry succeed',
       text.slice(0, 200));
  });
  srv.close();
}

// --- 6. schema validation happens before any request goes out ---------------
{
  // Nothing listens here, so if the argument were accepted the call would fail
  // with a connection error instead of a validation error. That distinction is
  // the whole check: bad arguments must never reach the network.
  await withServer({ JP_PAYROLL_API_URL: 'http://127.0.0.1:1' }, async (c) => {
    for (const [name, args, label] of [
      ['calculate_payslip', { prefecture: 'Tokyo' }, 'a missing required argument'],
      ['calculate_payslip', { prefecture: 'Tokyo', monthly_salary: 'lots' }, 'a wrong type'],
      ['judge_monthly_revision',
       { current_remuneration: 1, months: 'x', fixed_pay_change: 'sideways' },
       'a value outside an enum'],
      ['check_leave_exemption', { kind: 'sabbatical', start: '2026-01-01', end: '2026-01-02' },
       'an unknown enum member'],
    ]) {
      let threw = false, text = '';
      try {
        const r = await c.callTool({ name, arguments: args });
        text = r.content?.[0]?.text ?? '';
        threw = !!r.isError;
      } catch (e) { threw = true; text = String(e?.message ?? e); }
      ok(threw, `${label} is rejected`);
      ok(!/could not reach/i.test(text),
         `${label} is caught before a request is sent`, text.slice(0, 140));
    }
  });
}

// --- 7. a pasted URL with a trailing slash --------------------------------
{
  // "https://host/" + "/v1/..." = "//v1/...", which this origin answers with a
  // 404. Anyone self-hosting will paste a trailing slash sooner or later, and a
  // 404 makes it look like the endpoint is missing rather than the setting wrong.
  const { srv, port } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path_seen: req.url }));
  });
  for (const suffix of ['', '/', '///']) {
    await withServer({ JP_PAYROLL_API_URL: `http://127.0.0.1:${port}${suffix}` }, async (c) => {
      const r = await c.callTool({ name: 'check_data_freshness', arguments: {} });
      const seen = JSON.parse(r.content[0].text).path_seen;
      ok(seen === '/v1/data-freshness',
         `a base URL ending in "${suffix}" still builds a clean path`, seen);
    });
  }
  srv.close();
}

// --- 8. an unusable timeout setting ---------------------------------------
{
  // A timeout below one round trip fails every call. Clamping beats obeying.
  const { srv, port } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  for (const bad of ['0', '-5', 'soon', '']) {
    await withServer({
      JP_PAYROLL_API_URL: `http://127.0.0.1:${port}`, JP_PAYROLL_TIMEOUT_MS: bad,
    }, async (c) => {
      const r = await c.callTool({ name: 'check_data_freshness', arguments: {} });
      ok(!r.isError, `JP_PAYROLL_TIMEOUT_MS="${bad}" does not break every call`,
         (r.content?.[0]?.text ?? '').slice(0, 120));
    });
  }
  srv.close();
}

console.log(`  passed ${pass} / ${pass + fail}`);
if (fail) { console.log('\n  FAILURES:'); failures.forEach((f) => console.log('   - ' + f)); process.exit(1); }
console.log('  all failure paths behave\n');
