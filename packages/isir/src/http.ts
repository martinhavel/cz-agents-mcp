#!/usr/bin/env node
/**
 * Streamable HTTP entry for ISIR. Listens on PORT (default 3030) at /mcp.
 *
 * v0.1.0 alpha — no billing layer yet (free), SOAP integration pending.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  createRateLimiter,
  createRestRateLimiter,
  checkBodySize,
  checkOrigin,
  getMetrics,
  getRestIp,
  jsonErr,
  jsonOk,
  parseIco,
  runWithIp,
  setRequestIp,
  clearRequestIp,
  createSessionRegistry,
  registerSession,
  getClientIp,
  getClientUa,
} from '@czagents/shared';
import { IsirClient } from './client.js';
import { buildIsirServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3030);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);

async function main() {
  const client = new IsirClient();

  const transports = createSessionRegistry<StreamableHTTPServerTransport>();
  const restLimiter = createRestRateLimiter();
  const limiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    getIp: getClientIp,
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
    if (req.url === '/v1/health' || req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'isir',
        version: '0.1.0',
        transport: ['mcp', 'rest'],
      }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(getMetrics());
      return;
    }

    if (await handleIsirRest(req, res, client, restLimiter)) {
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
        'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id',
      });
      res.end();
      return;
    }

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
      const clientIpEarly = getClientIp(req);
      const clientUaEarly = getClientUa(req);
      const newSessionId = randomUUID();
      const server = buildIsirServer(client);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/isir] new session: ${id}`);
          registerSession(id, clientIpEarly, clientUaEarly);
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };
      await server.connect(transport);
    }

    const clientIp = getClientIp(req);
    setRequestIp(clientIp);
    try {
      await runWithIp(clientIp, () => transport.handleRequest(req, res));
    } finally {
      clearRequestIp();
    }
  });

  http.listen(PORT, () => {
    console.error(
      `[cz-agents/isir] Streamable HTTP MCP server listening on :${PORT}${MCP_PATH} (mode: ${process.env.ISIR_SOAP_ENABLED ? 'soap' : 'stub'})`,
    );
  });
}

async function handleIsirRest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  client: IsirClient,
  limiter: ReturnType<typeof createRestRateLimiter>,
): Promise<boolean> {
  if (!req.url) return false;
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/v1/')) return false;

  if (req.method !== 'GET') {
    jsonErr(res, 405, 'method_not_allowed', 'Use GET for REST requests.');
    return true;
  }

  if (!limiter(req, res)) return true;
  const clientIp = getRestIp(req);

  await runWithIp(clientIp, async () => {
    try {
      if (/^\/v1\/insolvency\/[0-9]{7,8}$/.test(url.pathname)) {
        const ico = parseIco(req, res);
        if (!ico) return;
        const result = await client.checkActiveInsolvency(ico);
        jsonOk(res, result, 'isir');
        return;
      }

      jsonErr(res, 404, 'not_found', 'REST endpoint not found.');
    } catch (e) {
      jsonErr(res, 500, 'upstream_error', e instanceof Error ? e.message : 'Unexpected REST error');
    }
  });

  return true;
}


main().catch((err) => {
  console.error('[cz-agents/isir] fatal:', err);
  process.exit(1);
});
