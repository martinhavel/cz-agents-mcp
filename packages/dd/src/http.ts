#!/usr/bin/env node
/**
 * Streamable HTTP entry for dd. Listens on PORT (default 3030) at /mcp.
 *
 * Env:
 *   SANCTIONS_DB     — path to sanctions DB (optional; if missing, sanctions
 *                      screening is skipped)
 *   PORT, MCP_PATH, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, MAX_BODY_BYTES
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRateLimiter, checkBodySize } from '@czagents/shared';
import { AresClient } from '@czagents/ares';
import { SanctionsDb, SanctionsSearch } from '@czagents/sanctions';
import { buildDdServer } from './server.js';
import type { DdClients } from './clients.js';

const PORT = Number(process.env.PORT ?? 3030);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 30);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);

async function main() {
  const ares = new AresClient();

  let sanctions: SanctionsSearch | undefined;
  if (process.env.SANCTIONS_DB) {
    const db = new SanctionsDb(process.env.SANCTIONS_DB);
    sanctions = new SanctionsSearch(db);
  }

  const clients: DdClients = { ares, sanctions };

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const limiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
  });

  const http = createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'cz-agents/dd',
        version: '0.1.0',
        sanctions: sanctions ? 'enabled' : 'disabled',
      }));
      return;
    }

    if (!req.url?.startsWith(MCP_PATH)) {
      res.writeHead(404);
      res.end(`Not found. MCP endpoint at ${MCP_PATH}`);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, authorization',
      });
      res.end();
      return;
    }

    if (!limiter(req, res)) return;
    if (!checkBodySize(req, res, MAX_BODY_BYTES)) return;

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      const newSessionId = randomUUID();
      const server = buildDdServer(clients);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/dd] new session: ${id}`);
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          console.error(`[cz-agents/dd] closed session: ${transport.sessionId}`);
        }
      };
      await server.connect(transport);
    }

    await transport.handleRequest(req, res);
  });

  http.listen(PORT, () => {
    console.error(
      `[cz-agents/dd] Streamable HTTP MCP server listening on :${PORT}${MCP_PATH} (sanctions=${sanctions ? 'enabled' : 'disabled'})`,
    );
  });
}

main().catch((err) => {
  console.error('[cz-agents/dd] fatal:', err);
  process.exit(1);
});
