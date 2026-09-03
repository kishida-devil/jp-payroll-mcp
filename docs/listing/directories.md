# MCP ディレクトリ掲載文(貼るだけ)

外から当てた結果(2026-09-03)、4面ともまだ載っていない。公式レジストリ登録と
GitHub topics だけでは自動では拾われない。どれも申請かフォーム送信が要る。
下の文をそのまま貼る。**数字(30ツール・45エンドポイント・4,689件)は
`scripts/sync-counts.py` が揃えるので、ここも同期対象。**

| 面 | 入口 | 要るもの | 状態(2026-09-03) |
|---|---|---|---|
| mcp.so | https://github.com/chatmcp/mcpso/issues/new に issue | GitHub | **提出済み** https://github.com/chatmcp/mcpso/issues/3906 |
| Glama | https://glama.ai/mcp/servers → Claim / Add server | GitHub ログイン | **自動掲載済み**(8/31 更新、品質「未採点」)。Claim は任意 |
| Smithery | https://smithery.ai/servers/new | GitHub ログイン(済) | **remote MCP を実装済み**(`/mcp`、2026-09-03)。本番デプロイ後に Server ID `jp-payroll-mcp`、MCP Server URL `https://japan-payroll-api.tsumugi.workers.dev/mcp` を入れて Continue |
| PulseMCP | https://www.pulsemcp.com/submit | フォーム(アカウント不要) | **受付停止中**。公式レジストリから自動で拾うとの掲示。申請不要 |

---

## mcp.so — issue のタイトル

```
Submit: jp-payroll-mcp (io.github.kishida-devil/jp-payroll-mcp) — Japanese payroll & social insurance, 30 tools
```

## mcp.so — issue の本文

```
## MCP Server Submission: jp-payroll-mcp

**Name:** jp-payroll-mcp
**Repo:** https://github.com/kishida-devil/jp-payroll-mcp
**Official MCP Registry:** https://registry.modelcontextprotocol.io/v0/servers/io.github.kishida-devil%2Fjp-payroll-mcp/versions/latest
**npm:** https://www.npmjs.com/package/jp-payroll-mcp
**Website:** https://japan-payroll-api.tsumugi.workers.dev

**Description:** Japanese payroll, social insurance and labour law for AI assistants — 30 tools over a public JSON API. 日本の給与計算・社会保険・労務のMCPサーバー。

Health/pension/employment insurance rates for all 47 prefectures, the 50-grade standard remuneration table, the National Tax Agency withholding tables (monthly, daily, bonus), overtime premiums (Labour Standards Act art. 37), annual paid leave, regular and ad-hoc remuneration revisions, maternity/childcare leave premium exemptions, 24 years of prefectural minimum wage, public holidays with business-day arithmetic, consumption tax history, and corporate/invoice number validation.

Every figure is extracted from the published government tables and checked cell by cell — 4,689 assertions on every change. When a test cannot be judged from the inputs given, the tools say so rather than guessing.

**Install (Claude Desktop / Cursor / any stdio client):**

```json
{ "mcpServers": { "jp-payroll": { "command": "npx", "args": ["-y", "jp-payroll-mcp"] } } }
```

**Transport:** streamable-http at https://japan-payroll-api.tsumugi.workers.dev/mcp (stateless, no key), or stdio via npx. No API key needed for the free tier.
**Language:** tool descriptions in English; responses carry Japanese field labels and statutory citations.
**Tags:** payroll, hr, japan, social-insurance, tax, labor-law, finance, data
```

---

## Glama / Smithery — 説明文(英語)

```
Japanese payroll, social insurance and labour law for AI assistants. 30 tools: insurance rates for all 47 prefectures, the 50-grade standard remuneration table, NTA withholding tables (monthly/daily/bonus), overtime premiums, annual paid leave, remuneration revisions, leave premium exemptions, 24 years of minimum wage, holidays with business-day arithmetic, consumption tax, corporate/invoice number validation. Extracted from the published government tables and verified cell by cell (4,689 assertions). Says "cannot judge" instead of guessing. Remote endpoint (no install): https://japan-payroll-api.tsumugi.workers.dev/mcp
```

## Glama / Smithery — 説明文(日本語)

```
日本の給与計算・社会保険・労務のMCPサーバー(30ツール)。47都道府県の保険料率、標準報酬月額50等級、国税庁の源泉徴収税額表(月額・日額・賞与)、割増賃金、年次有給休暇、定時決定・随時改定、産休育休の保険料免除、24年分の最低賃金、祝日と営業日計算、消費税、法人番号・インボイス番号の検証。公表資料から抽出し、1セルずつ照合(4,689件)。判定できないときは推測せず「判定できない」と言います。URL を貼るだけの remote MCP: https://japan-payroll-api.tsumugi.workers.dev/mcp
```

---

## PulseMCP — フォームの各欄

| 欄 | 値 |
|---|---|
| Server name | jp-payroll-mcp |
| GitHub URL | https://github.com/kishida-devil/jp-payroll-mcp |
| npm package | jp-payroll-mcp |
| Website | https://japan-payroll-api.tsumugi.workers.dev |
| Short description | Japanese payroll & social insurance for AI assistants: 30 tools over the published government tables, verified cell by cell. |
| Long description | 上の Glama / Smithery の英語説明文 |
| Category | Finance / Data / HR |
| Contact | (提出者のメール) |
