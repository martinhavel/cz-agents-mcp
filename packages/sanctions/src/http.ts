#!/usr/bin/env node
/**
 * Streamable HTTP entry for sanctions MCP server.
 * Listens on PORT (default 3030) at /mcp. Health probe at /health.
 *
 * Env:
 *   SANCTIONS_DB
 *   PORT, MCP_PATH, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, MAX_BODY_BYTES
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRateLimiter, checkBodySize } from '@czagents/shared';
import { SanctionsDb } from './db.js';
import { SanctionsSearch } from './search.js';
import { buildSanctionsServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3030);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);

async function main() {
  const dbPath = process.env.SANCTIONS_DB ?? './sanctions.db';
  const db = new SanctionsDb(dbPath);
  const search = new SanctionsSearch(db);

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const limiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
  });

  const http = createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      const stats = db.stats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'cz-agents/sanctions',
        version: '0.1.0',
        active_records: stats.total_active,
        sources: stats.by_source,
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
      const server = buildSanctionsServer({ db, search });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/sanctions] new session: ${id}`);
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          console.error(`[cz-agents/sanctions] closed session: ${transport.sessionId}`);
        }
      };
      await server.connect(transport);
    }

    await transport.handleRequest(req, res);
  });

  http.listen(PORT, () => {
    console.error(
      `[cz-agents/sanctions] Streamable HTTP MCP server listening on :${PORT}${MCP_PATH} (db: ${dbPath})`,
    );
  });
}

main().catch((err) => {
  console.error('[cz-agents/sanctions] fatal:', err);
  process.exit(1);
});
