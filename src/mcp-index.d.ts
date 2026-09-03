/** mcp/src/index.mjs は JS のまま(npm パッケージの本体)。Worker から使う2つの口だけ型を当てる。 */
declare module '*/mcp/src/index.mjs' {
  export function createServer(): { connect(transport: unknown): Promise<void> };
  export function configure(opts: { baseUrl?: string; fetch?: (url: string, init?: RequestInit) => Promise<Response> }): void;
}
