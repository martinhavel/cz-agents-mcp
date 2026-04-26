#!/usr/bin/env node
/**
 * Streamable HTTP entry — for remote MCP clients (Claude Desktop w/ URL,
 * Cursor, Continue, production deployment on Hetzner/Cloudflare Workers).
 *
 * Listens on PORT (default 3030) at path /mcp.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRateLimiter, checkBodySize, checkOrigin } from '@czagents/shared';
import { buildAresServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3030);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);

async function main() {
  // Per-session McpServer instance (SDK forbids connecting the same
  // McpServer to multiple transports).
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Rate limiter (60 req/min per IP via CF-Connecting-IP or X-Forwarded-For)
  const limiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
  });

  const http = createServer(async (req, res) => {
    // Permissive Accept rewrite — clients (Anthropic probe) sending */* otherwise hit MCP SDK strict 406.
    if (req.url?.startsWith(MCP_PATH)) {
      const accept = req.headers.accept;
      if (!accept || accept === "*/*" || accept.includes("*/*")) {
        const fixed = "application/json, text/event-stream";
        req.headers.accept = fixed;
        const rh = req.rawHeaders;
        for (let i = 0; i + 1 < rh.length; i += 2) {
          if (rh[i] && rh[i]!.toLowerCase() === "accept") rh[i + 1] = fixed;
        }
      }
    }
    // Health check (no rate limit — used by Docker/monitoring)
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'cz-agents/ares', version: '0.1.0' }));
      return;
    }

    if (!req.url?.startsWith(MCP_PATH)) {
      res.writeHead(404);
      res.end('Not found. MCP endpoint at ' + MCP_PATH);
      return;
    }

    // CORS preflight (no rate limit)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id',
      });
      res.end();
      return;
    }

    // Rate limit + body size check (writes 429/413 if exceeded)
    if (!limiter(req, res)) return;
    if (!checkOrigin(req, res)) return;
    if (!checkBodySize(req, res, MAX_BODY_BYTES)) return;

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (req.method === 'GET' && !sessionId) {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' });
      res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Use POST for MCP requests.' }));
      return;
    }

    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      // New session — fresh McpServer instance (SDK limitation)
      const newSessionId = randomUUID();
      const server = buildAresServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/ares] new session: ${id}`);
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          console.error(`[cz-agents/ares] closed session: ${transport.sessionId}`);
        }
      };
      await server.connect(transport);
    }

    await transport.handleRequest(req, res);
  });

  http.listen(PORT, () => {
    console.error(
      `[cz-agents/ares] Streamable HTTP MCP server listening on :${PORT}${MCP_PATH}`,
    );
  });
}

main().catch((err) => {
  console.error('[cz-agents/ares] fatal:', err);
  process.exit(1);
});
