#!/usr/bin/env node
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRateLimiter, createSessionRegistry, checkBodySize, checkOrigin, runWithIp, setRequestIp, clearRequestIp, getMetrics } from '@czagents/shared';
import { buildPayqrServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3032);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 10_000_000);

async function main() {
  const transports = createSessionRegistry<StreamableHTTPServerTransport>();
  const limiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX, getIp: getClientIp });

  const http = createServer(async (req, res) => {
    // Permissive Accept rewrite — clients (Anthropic probe) sending */* otherwise hit MCP SDK strict 406.
    if (req.url?.startsWith(MCP_PATH)) {
      const accept = req.headers.accept;
      if (!accept || accept === '*/*' || accept.includes('*/*')) {
        const fixed = 'application/json, text/event-stream';
        req.headers.accept = fixed;
        const rh = req.rawHeaders;
        for (let i = 0; i + 1 < rh.length; i += 2) {
          if (rh[i] && rh[i]!.toLowerCase() === 'accept') rh[i + 1] = fixed;
        }
      }
    }
    if (req.url === '/v1/health' || req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'cz-agents/payqr', version: '0.1.2' }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(getMetrics());
      return;
    }

    if (!req.url?.startsWith(MCP_PATH)) {
      res.writeHead(404);
      res.end('Not found. MCP endpoint at ' + MCP_PATH);
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
      // New session — fresh McpServer instance (SDK limitation)
      const newSessionId = randomUUID();
      const server = buildPayqrServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
        onsessioninitialized: (id) => { transports.set(id, transport); },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
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
    console.error(`[cz-agents/payqr] Streamable HTTP MCP on :${PORT}${MCP_PATH}`);
  });
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

main().catch((err) => {
  console.error('[cz-agents/payqr] fatal:', err);
  process.exit(1);
});
