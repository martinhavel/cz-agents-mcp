#!/usr/bin/env node
/**
 * Streamable HTTP entry for sanctions MCP server.
 * Listens on PORT (default 3030) at /mcp. Health probe at /health.
 * Stripe webhook at /webhook/stripe (POST). Bearer-token quota enforcement on /mcp.
 *
 * Env:
 *   SANCTIONS_DB
 *   TOKEN_DB              — path to billing token SQLite (default ./tokens.db)
 *   STRIPE_WEBHOOK_SECRET — required to enable /webhook/stripe; if unset, endpoint returns 503
 *   PORT, MCP_PATH, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, MAX_BODY_BYTES
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  createRateLimiter,
  createRestRateLimiter,
  checkBodySize,
  checkOrigin,
  runWithIp,
  setRequestIp,
  clearRequestIp,
  getMetrics,
  getRestIp,
  jsonErr,
  jsonOk,
  parseIco,
  TokenStore,
  createQuotaGuard,
  handleStripeWebhook,
  WebhookError,
  createSessionRegistry,
  registerSession,
} from '@czagents/shared';
import { SanctionsDb } from './db.js';
import { SanctionsSearch } from './search.js';
import { buildSanctionsServer } from './server.js';
import { SANCTIONS_BILLING } from './billing.js';

const PORT = Number(process.env.PORT ?? 3030);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);

async function main() {
  const dbPath = process.env.SANCTIONS_DB ?? './sanctions.db';
  const db = new SanctionsDb(dbPath);
  const search = new SanctionsSearch(db);

  const tokenDbPath = process.env.TOKEN_DB ?? './tokens.db';
  const tokenStore = new TokenStore(tokenDbPath);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const quota = createQuotaGuard({ store: tokenStore, service: 'sanctions', allowAnonymous: true });

  const transports = createSessionRegistry<StreamableHTTPServerTransport>();
  const restLimiter = createRestRateLimiter();
  const limiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX, getIp: getClientIp });

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
        service: 'sanctions',
        version: '0.1.0',
        transport: ['mcp', 'rest'],
      }));
      return;
    }

    if (req.url?.startsWith('/onboard/token') && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('session_id');
      if (!sessionId || !sessionId.startsWith('cs_')) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'invalid_session_id' }));
        return;
      }
      const t = tokenStore.retrieveBySession(sessionId);
      res.writeHead(t ? 200 : 404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(t
        ? { token: t.token, tier: t.tier, monthly_quota: t.monthly_quota, credits: t.credits }
        : { error: 'not_found', message: 'Session unknown or token already retrieved.' }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(getMetrics());
      return;
    }

    if (req.url === '/webhook/stripe' && req.method === 'POST') {
      if (!webhookSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'webhook_disabled', message: 'STRIPE_WEBHOOK_SECRET not configured.' }));
        return;
      }
      try {
        const rawBody = await readRawBody(req, MAX_BODY_BYTES);
        const sig = req.headers['stripe-signature'];
        const result = handleStripeWebhook({
          rawBody,
          signatureHeader: Array.isArray(sig) ? sig[0] : sig,
          webhookSecret,
          store: tokenStore,
          config: SANCTIONS_BILLING,
        });
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } catch (e) {
        const status = e instanceof WebhookError ? e.status : 500;
        const message = e instanceof Error ? e.message : 'webhook_error';
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'webhook_failed', message }));
      }
      return;
    }

    if (await handleSanctionsRest(req, res, search, restLimiter, quota)) {
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
    if (!checkOrigin(req, res)) return;
    if (!checkBodySize(req, res, MAX_BODY_BYTES)) return;

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (req.method === 'GET' && !sessionId) {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' });
      res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Use POST for MCP requests.' }));
      return;
    }

    const auth = quota(req, res);
    if (!auth.ok) return;

    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      const clientIpEarly = getClientIp(req);
      const newSessionId = randomUUID();
      const server = buildSanctionsServer({ db, search });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/sanctions] new session: ${id} (tier=${auth.token.tier})`);
          registerSession(id, clientIpEarly);
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
      `[cz-agents/sanctions] listening on :${PORT}${MCP_PATH} (db: ${dbPath}, tokens: ${tokenDbPath}, webhook: ${webhookSecret ? 'enabled' : 'disabled'})`,
    );
  });
}

async function handleSanctionsRest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  search: SanctionsSearch,
  limiter: ReturnType<typeof createRestRateLimiter>,
  quota: ReturnType<typeof createQuotaGuard>,
): Promise<boolean> {
  if (!req.url) return false;
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/v1/')) return false;

  if (req.method !== 'GET') {
    jsonErr(res, 405, 'method_not_allowed', 'Use GET for REST requests.');
    return true;
  }

  if (!limiter(req, res)) return true;

  const auth = quota(req, res);
  if (!auth.ok) return true;

  const clientIp = getRestIp(req);

  await runWithIp(clientIp, async () => {
    try {
      if (url.pathname === '/v1/sanctions/check') {
        const ico = parseIco(req, res);
        if (!ico) return;
        const name = url.searchParams.get('name') ?? undefined;
        const result = search.searchByIco(ico, name);
        jsonOk(res, result, 'sanctions');
        return;
      }

      jsonErr(res, 404, 'not_found', 'REST endpoint not found.');
    } catch (e) {
      jsonErr(res, 500, 'upstream_error', e instanceof Error ? e.message : 'Unexpected REST error');
    }
  });

  return true;
}

function getClientIp(req: import('node:http').IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xr = req.headers['x-real-ip'];
  if (typeof xr === 'string' && xr.length > 0) return xr;
  return req.socket.remoteAddress ?? 'unknown';
}

function readRawBody(req: import('node:http').IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new WebhookError('Body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

main().catch((err) => {
  console.error('[cz-agents/sanctions] fatal:', err);
  process.exit(1);
});
