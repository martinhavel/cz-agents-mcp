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
import { pathToFileURL } from 'node:url';
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
  TtlMap,
  createSessionRegistry,
  registerSession,
  getClientIp,
  getClientUa,
} from '@czagents/shared';
import { AresClient } from './client.js';
import { checkSandboxLimit, getSandboxIp, getSandboxMeta } from './sandbox.js';
import { buildAresServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3030);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);
const SESSION_LIMIT_MAX = Number(process.env.SESSION_LIMIT_MAX ?? 3);
// Comma-separated IPs to block entirely: BLOCKED_IPS=1.2.3.4,2a02:c207:...
const BLOCKED_IPS = new Set(
  (process.env.BLOCKED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
const SESSION_LIMIT_WINDOW_MS = 60_000;
const SESSION_LIMIT_MAX_IPS = 50_000;
export const MAX_SESSION_IPS = 10_000;

// Session-creation rate limit per IP (sliding window)
const sessionTimes = new TtlMap<string, number[]>({
  ttlMs: SESSION_LIMIT_WINDOW_MS,
  maxSize: SESSION_LIMIT_MAX_IPS,
  sweepIntervalMs: 5 * 60_000,
});
interface SessionTimesMap extends Iterable<[string, number[]]> {
  readonly size: number;
  delete(ip: string): boolean;
  set(ip: string, times: number[]): unknown;
}

function checkSessionLimit(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - SESSION_LIMIT_WINDOW_MS;
  const times = (sessionTimes.get(ip) ?? []).filter((t) => t > cutoff);
  if (times.length >= SESSION_LIMIT_MAX) return false;
  times.push(now);
  sessionTimes.set(ip, times);
  return true;
}
export function cleanupSessionTimes(timesByIp: SessionTimesMap = sessionTimes): void {
  const cutoff = Date.now() - SESSION_LIMIT_WINDOW_MS;
  for (const [ip, times] of [...timesByIp]) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length === 0) timesByIp.delete(ip);
    else timesByIp.set(ip, fresh);
  }

  if (timesByIp.size > MAX_SESSION_IPS) {
    const oldestIps = [...timesByIp]
      .map(([ip, times]) => [ip, Math.max(...times)] as const)
      .sort(([, a], [, b]) => b - a)
      .slice(MAX_SESSION_IPS);
    for (const [ip] of oldestIps) timesByIp.delete(ip);
  }
}
setInterval(cleanupSessionTimes, 5 * 60_000).unref();

async function main() {
  const client = new AresClient();
  // Per-session McpServer instance (SDK forbids connecting the same
  // McpServer to multiple transports).
  const transports = createSessionRegistry<StreamableHTTPServerTransport>();
  const restLimiter = createRestRateLimiter();

  // Rate limiter (60 req/min per IP via CF-Connecting-IP or X-Forwarded-For)
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
    // Health check (no rate limit — used by Docker/monitoring)
    if (req.url === '/v1/health' || req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'ares', version: '0.1.0', transport: ['mcp', 'rest'] }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(getMetrics());
      return;
    }

    // OPTIONS preflight for sandbox
    if (req.method === 'OPTIONS' && req.url?.startsWith('/sandbox/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Continue-Token',
        'Access-Control-Expose-Headers': 'X-Sandbox-Remaining, X-Sandbox-Reset',
      });
      res.end();
      return;
    }
    if (await handleSandboxRest(req, res, client)) return;

    if (await handleAresRest(req, res, client, restLimiter)) {
      return;
    }

    if (!req.url?.startsWith(MCP_PATH)) {
      res.writeHead(404);
      res.end('Not found. MCP endpoint at ' + MCP_PATH);
      return;
    }

    // IP blocklist — checked before everything else for /mcp
    if (BLOCKED_IPS.size > 0) {
      const earlyIp = getClientIp(req);
      if (BLOCKED_IPS.has(earlyIp)) {
        console.error(`[cz-agents/ares] blocked ip=${earlyIp}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'blocked', message: 'Your IP has been temporarily blocked due to unusual traffic patterns.' }));
        return;
      }
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
      // New session — check session-creation rate limit before allocating
      const clientIpEarly = getClientIp(req);
      const clientUaEarly = getClientUa(req);
      if (!checkSessionLimit(clientIpEarly)) {
        console.error(`[cz-agents/ares] session limit exceeded ip=${clientIpEarly}`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_limit_exceeded', message: `Max ${SESSION_LIMIT_MAX} new sessions/min per IP.` }));
        return;
      }
      // New session — fresh McpServer instance (SDK limitation)
      const newSessionId = randomUUID();
      const server = buildAresServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/ares] new session: ${id} ip=${clientIpEarly}`);
          registerSession(id, clientIpEarly, clientUaEarly);
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
      `[cz-agents/ares] Streamable HTTP MCP server listening on :${PORT}${MCP_PATH}`,
    );
  });
}

async function handleSandboxRest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  client: AresClient,
): Promise<boolean> {
  if (!req.url) return false;
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/sandbox/v1/')) return false;

  if (req.method !== 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Use GET.' }));
    return true;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'X-Sandbox-Remaining, X-Sandbox-Reset');

  if (!checkSandboxLimit(req, res)) return true;

  const companyMatch = url.pathname.match(/^\/sandbox\/v1\/companies\/([0-9]{7,8})$/);
  if (!companyMatch) {
    jsonErr(res, 404, 'not_found', 'Sandbox endpoint: GET /sandbox/v1/companies/{ico}');
    return true;
  }

  const icoRaw = companyMatch[1]!;
  const clientIp = getSandboxIp(req);

  await runWithIp(clientIp, async () => {
    try {
      const result = await client.getByIco(icoRaw);
      if (!result) {
        jsonErr(res, 404, 'not_found', 'Company ' + icoRaw + ' was not found.');
        return;
      }
      const meta = getSandboxMeta(clientIp);
      const responseBody = {
        data: result,
        _sandbox: {
          token: meta.token,
          remaining: meta.remaining,
          resets_at: meta.resets_at,
          note: meta.remaining === 0
            ? 'Limit reached. Get free API key (30 calls/day): https://cz-agents.dev/pricing.html'
            : meta.remaining + ' call(s) remaining today. Pass _sandbox.token as X-Continue-Token on next request.',
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    } catch (e) {
      // Don't leak the raw internal message to the client; log it server-side.
      console.error('[ares] sandbox handler error:', e);
      jsonErr(res, 500, 'upstream_error', 'Request failed.');
    }
  });

  return true;
}

async function handleAresRest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  client: AresClient,
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
      if (url.pathname === '/v1/companies') {
        const query = url.searchParams.get('q') ?? undefined;
        const city = url.searchParams.get('city') ?? undefined;
        const rawLimit = Number(url.searchParams.get('limit') ?? 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 50) : 10;
        const result = await client.search({
          query,
          sidlo: city ? { nazevObce: city } : undefined,
          pocet: limit,
        });
        jsonOk(res, result, 'ares');
        return;
      }

      if (/^\/v1\/companies\/[0-9]{7,8}\/bank-accounts$/.test(url.pathname)) {
        const ico = parseIco(req, res);
        if (!ico) return;
        const result = await client.getBankAccounts(ico);
        jsonOk(res, result, 'ares');
        return;
      }

      if (/^\/v1\/companies\/[0-9]{7,8}\/statutaries$/.test(url.pathname)) {
        const ico = parseIco(req, res);
        if (!ico) return;
        const record = await client.getVrRecord(ico);
        jsonOk(res, record?.statutarniOrgany ?? [], 'ares');
        return;
      }

      const companyMatch = url.pathname.match(/^\/v1\/companies\/([0-9]{7,8})(\/.*)?$/);
      if (companyMatch) {
        const ico = parseIco(req, res);
        if (!ico) return;
        const result = await client.getByIco(ico);
        if (!result) {
          jsonErr(res, 404, 'not_found', `Company ${ico} was not found.`);
          return;
        }
        jsonOk(res, result, 'ares');
        return;
      }

      jsonErr(res, 404, 'not_found', 'REST endpoint not found.');
    } catch (e) {
      // Don't leak the raw internal message to the client; log it server-side.
      console.error('[ares] REST handler error:', e);
      jsonErr(res, 500, 'upstream_error', 'Request failed.');
    }
  });

  return true;
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[cz-agents/ares] fatal:', err);
    process.exit(1);
  });
}
