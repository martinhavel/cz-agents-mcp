#!/usr/bin/env node
/**
 * Streamable HTTP entry for dd. Listens on PORT (default 3030) at /mcp.
 * Stripe webhook at /webhook/stripe (POST). Bearer-token quota enforcement on /mcp.
 *
 * Env:
 *   SANCTIONS_DB         — sanctions screening data (optional; missing → screening skipped)
 *   TOKEN_DB             — billing tokens SQLite (default ./tokens.db)
 *   STRIPE_WEBHOOK_SECRET
 *   PORT, MCP_PATH, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, MAX_BODY_BYTES
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  createRateLimiter,
  checkBodySize,
  TokenStore,
  createQuotaGuard,
  handleStripeWebhook,
  WebhookError,
} from '@czagents/shared';
import { AresClient } from '@czagents/ares';
import { SanctionsDb, SanctionsSearch } from '@czagents/sanctions';
import { buildDdServer } from './server.js';
import type { DdClients } from './clients.js';
import { DD_BILLING } from './billing.js';

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

  const tokenDbPath = process.env.TOKEN_DB ?? './tokens.db';
  const tokenStore = new TokenStore(tokenDbPath);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const quota = createQuotaGuard({ store: tokenStore, service: 'dd', allowAnonymous: true });

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const limiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX });

  const http = createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      const tokens = tokenStore.stats('dd');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'cz-agents/dd',
        version: '0.1.0',
        sanctions: sanctions ? 'enabled' : 'disabled',
        tokens,
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
          config: DD_BILLING,
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

    const auth = quota(req, res);
    if (!auth.ok) return;

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
          console.error(`[cz-agents/dd] new session: ${id} (tier=${auth.token.tier})`);
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
      `[cz-agents/dd] listening on :${PORT}${MCP_PATH} (sanctions=${sanctions ? 'enabled' : 'disabled'}, tokens: ${tokenDbPath}, webhook: ${webhookSecret ? 'enabled' : 'disabled'})`,
    );
  });
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
  console.error('[cz-agents/dd] fatal:', err);
  process.exit(1);
});
