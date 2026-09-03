/**
 * remote MCP: 同じ30本のツールを、npx で入れずに URL 1つで使えるようにする。
 *
 * なぜ要るか。npm の累計DLは809なのに、13分間の実測で API を叩いた人は0だった。
 * 「npx で入れる」が試用の壁になっている可能性が高い。URL を貼るだけなら
 * Claude.ai のコネクタ、ChatGPT、Cursor から設定1行で使える。Smithery の公開フォームも
 * 2026-09 時点で HTTP の MCP URL が必須で、stdio の npm パッケージは載せられない。
 *
 * 形: Streamable HTTP(MCP 2025-03-26 以降)。セッションを持たない(stateless)。
 * リクエストごとに McpServer と transport を作って捨てる。Worker はリクエスト間で
 * 状態を持てないので、これが自然。GET(SSE の常時接続)は 405 を返す。
 *
 * ツールの定義は mcp/src/index.mjs の1か所。ここでは呼び先だけを差し替え、
 * ツールが叩く /v1/... は HTTP を経由せず、同じ Worker の Hono アプリを直接叩く。
 * 元のリクエストの IP と User-Agent を引き継ぐので、レート制限とチャネルの集計は
 * stdio 版と同じ(channel=mcp)。
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { configure, createServer } from '../mcp/src/index.mjs';
import type { Hono } from 'hono';

export const REMOTE_MCP_PATH = '/mcp';

export function mountRemoteMcp(app: Hono<any>) {
  app.all(REMOTE_MCP_PATH, async (c) => {
    const origin = new URL(c.req.url).origin;
    const ip = c.req.header('cf-connecting-ip');
    // ツールからの /v1 呼び出しは、この Worker のアプリを直接叩く(ネットワークに出ない)。
    configure({
      baseUrl: origin,
      fetch: (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers ?? {});
        headers.set('user-agent', 'jp-payroll-mcp-remote (+https://japan-payroll-api.tsumugi.workers.dev/mcp)');
        if (ip) headers.set('cf-connecting-ip', ip);
        return Promise.resolve(app.fetch(new Request(url, { ...init, headers }), c.env, c.executionCtx));
      },
    });
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless
      enableJsonResponse: true,        // SSE ではなく素の JSON で返す。curl でも読める。
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      c.executionCtx.waitUntil(transport.close().catch(() => {}));
    }
  });
}
