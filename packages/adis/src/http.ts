#!/usr/bin/env node
/**
 * Streamable HTTP entry for ADIS. Listens on PORT (default 3030) at /mcp.
 *
 * Set ADIS_SOAP_ENABLED=1 to actually hit the live MFČR SOAP service.
 * Default is offline stub for safety.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRateLimiter, checkBodySize, checkOrigin } from '@czagents/shared';
import { AdisClient } from './client.js';
import { buildAdisServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3030);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);

async function main() {
  const client = new AdisClient();

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const limiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
  });

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
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'cz-agents/adis',
        version: '0.1.0',
        mode: process.env.ADIS_SOAP_ENABLED ? 'soap' : 'stub',
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
      const newSessionId = randomUUID();
      const server = buildAdisServer(client);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/adis] new session: ${id}`);
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

    await transport.handleRequest(req, res);
  });

  http.listen(PORT, () => {
    console.error(
      `[cz-agents/adis] Streamable HTTP MCP server listening on :${PORT}${MCP_PATH} (mode: ${process.env.ADIS_SOAP_ENABLED ? 'soap' : 'stub'})`,
    );
  });
}

main().catch((err) => {
  console.error('[cz-agents/adis] fatal:', err);
  process.exit(1);
});
