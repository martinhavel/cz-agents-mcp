#!/usr/bin/env node
/**
 * Streamable HTTP transport for realestate MCP (free tier only, v0.2.0+).
 * Listens on PORT (default 3036) at /mcp. IP-rate-limited, no auth required.
 *
 * Paid tools (search_distress_properties, get_property_detail) are served by
 * the private realestate-pro container at realestate-pro.cz-agents.dev.
 * All requests here are handled as 'free' tier.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  createRateLimiter,
  checkBodySize,
  TokenStore,
  createQuotaGuard,
} from '@czagents/shared';
import { buildRealEstateServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3036);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 30);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);

async function main() {
  const tokenDbPath = process.env.TOKEN_DB ?? './tokens.db';
  const tokenStore = new TokenStore(tokenDbPath);
  const quota = createQuotaGuard({
    store: tokenStore,
    service: 'realestate' as const,
    allowAnonymous: true,
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const limiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX });

  const http = createServer(async (req, res) => {
    // Permissive Accept-header rewrite for Anthropic Connector probe-tester
    if (req.url?.startsWith(MCP_PATH)) {
      const accept = req.headers.accept;
      if (!accept || accept === '*/*' || accept.includes('*/*')) {
        const fixed = 'application/json, text/event-stream';
        req.headers.accept = fixed;
        const rh = req.rawHeaders;
        for (let i = 0; i + 1 < rh.length; i += 2) {
          const headerName = rh[i];
          if (headerName && headerName.toLowerCase() === 'accept') {
            rh[i + 1] = fixed;
          }
        }
      }
    }

    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'cz-agents/realestate',
        version: '0.2.0',
        db_path: process.env.REALESTATE_DB_PATH ?? '/data/webapp.db',
      }));
      return;
    }

    if (!req.url?.startsWith(MCP_PATH)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    if (!checkBodySize(req, res, MAX_BODY_BYTES)) return;

    if (!limiter(req, res)) return;

    const auth = quota(req, res);
    if (!auth.ok) return;

    let transport: StreamableHTTPServerTransport;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      const newSessionId = randomUUID();
      // Always free tier — paid tools are at realestate-pro.cz-agents.dev
      const server = buildRealEstateServer('free');
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/realestate] new session: ${id} (tier=free)`);
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          console.error(`[cz-agents/realestate] closed session: ${transport.sessionId}`);
        }
      };
      await server.connect(transport);
    }

    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf-8');
      body = raw ? JSON.parse(raw) : undefined;
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    await transport.handleRequest(req, res, body);
  });

  http.listen(PORT, () => {
    console.error(`[cz-agents/realestate] listening on :${PORT}${MCP_PATH} (db: ${process.env.REALESTATE_DB_PATH ?? '/data/webapp.db'})`);
  });
}

main().catch((err) => {
  console.error('[cz-agents/realestate] fatal:', err);
  process.exit(1);
});
