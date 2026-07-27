/**
 * Implementace `HTTPAdapter` z `@x402/core/server` nad `node:http` `IncomingMessage`.
 *
 * Pro vanilla `node:http` neexistuje oficiální balíček (jen framework adaptéry
 * pro express/hono/next, které se navíc nechtějí — táhnou `@x402/extensions`
 * kvůli paywallu). `HTTPAdapter` je zamýšlená integrační cesta pro
 * nepodporované frameworky, ne obcházení — SDK ho přímo pro tenhle účel exportuje.
 *
 * Rozhraní je opsané ze skutečného `.d.ts` (`@x402/core@2.19.0`, rozbaleno do
 * `@x402/core` (`dist/cjs`, typové definice)),
 * NE importované odtamtud — `@x402/core` je volitelná peer závislost a fáze 1
 * nesmí vyžadovat instalaci. Sedm metod přesně podle zadání; skutečné rozhraní
 * má navíc `getQueryParams?`/`getQueryParam?`, které jsou taky optional a fáze 1
 * je nepotřebuje, takže je tahle implementace neposkytuje.
 */

import type { IncomingMessage } from 'node:http';

export interface HTTPAdapter {
  getHeader(name: string): string | undefined;
  getMethod(): string;
  getPath(): string;
  getUrl(): string;
  getAcceptHeader(): string;
  getUserAgent(): string;
  /** Naparsované tělo requestu. Framework adaptéry si parsování dělají samy. */
  getBody?(): unknown;
}

export interface NodeHTTPAdapterOptions {
  /**
   * Naparsované tělo, pokud ho volající middleware už přečetl (node:http samo
   * o sobě streamuje a neparsuje). Když se nedodá, `getBody()` vrátí `undefined`.
   */
  body?: unknown;
}

export class NodeHTTPAdapter implements HTTPAdapter {
  private readonly body: unknown;

  constructor(
    private readonly req: IncomingMessage,
    options: NodeHTTPAdapterOptions = {},
  ) {
    this.body = options.body;
  }

  getHeader(name: string): string | undefined {
    const value = this.req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  getMethod(): string {
    return this.req.method ?? 'GET';
  }

  getPath(): string {
    const url = this.req.url ?? '/';
    const queryIndex = url.indexOf('?');
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
  }

  getUrl(): string {
    return this.req.url ?? '/';
  }

  getAcceptHeader(): string {
    return this.getHeader('accept') ?? '*/*';
  }

  getUserAgent(): string {
    return this.getHeader('user-agent') ?? '';
  }

  getBody(): unknown {
    return this.body;
  }
}
