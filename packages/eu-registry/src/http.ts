#!/usr/bin/env node
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
  runWithIp,
  setRequestIp,
  clearRequestIp,
  TtlMap,
  createSessionRegistry,
  registerSession,
  getClientIp,
  getClientUa,
  TokenStore,
} from '@czagents/shared';
import { EntitlementStore,HostedEntitlementResolver,entitlementMode,authenticateHostedRequest,
  runWithHostedRequestContext,getHostedRequestContext } from '@czagents/shared/entitlements';
import { buildEuRegistryServer } from './server.js';
import type { RegistryLookupAuthorizer } from './server.js';

const PORT = Number(process.env.PORT ?? 3035);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);
const ENTITLEMENT_MODE = entitlementMode(process.env.HOSTED_GEO_TIER_ENFORCEMENT);
const UPGRADE_URL = process.env.HOSTED_UPGRADE_URL ?? 'https://cz-agents.dev/pricing.html';
const POLICY_CACHE_TTL_MS = Number(process.env.HOSTED_POLICY_CACHE_TTL_MS ?? 30_000);
const SESSION_LIMIT_MAX = Number(process.env.SESSION_LIMIT_MAX ?? 3);
const BLOCKED_IPS = new Set(
  (process.env.BLOCKED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
const SESSION_LIMIT_WINDOW_MS = 60_000;
const SESSION_LIMIT_MAX_IPS = 50_000;
export const MAX_SESSION_IPS = 10_000;

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
  const tokenDbPath=process.env.TOKEN_DB ?? './tokens.db';
  const tokenStore=ENTITLEMENT_MODE === 'off' ? null : new TokenStore(tokenDbPath);
  const entitlementStore=ENTITLEMENT_MODE === 'off' ? null : new EntitlementStore(tokenDbPath);
  const entitlementResolver=entitlementStore ? new HostedEntitlementResolver(entitlementStore,{
    mode:ENTITLEMENT_MODE,upgradeUrl:UPGRADE_URL,cacheTtlMs:POLICY_CACHE_TTL_MS,
  }) : null;
  const authorizeLookup:RegistryLookupAuthorizer|undefined=entitlementResolver ? async (lookup)=>{
    const context=getHostedRequestContext();
    if(!context) return {upstreamAllowed:false,error:{error:'policy_unavailable',dimension:'coverage',
      message:'Hosted account context is unavailable.'}};
    const decision=entitlementResolver.check({account:context.account,country:lookup.country,
      requestedDepth:lookup.depth,endpoint:`mcp:${lookup.tool}`,requestId:context.requestId});
    return {upstreamAllowed:decision.upstreamAllowed,country:decision.country?.toLowerCase(),error:decision.error,
      record:(upstreamCalled)=>entitlementResolver.record(decision,upstreamCalled)};
  } : undefined;
  const transports = createSessionRegistry<StreamableHTTPServerTransport>();
  const restLimiter = createRestRateLimiter();

  const limiter = createRateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    getIp: getClientIp,
  });

  const http = createServer(async (req, res) => {
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
      res.end(JSON.stringify({ status: 'ok', service: 'eu-registry', version: '0.1.0' }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(getMetrics());
      return;
    }

    if (await handleEuRegistryRest(req, res, restLimiter)) {
      return;
    }

    if (!req.url?.startsWith(MCP_PATH)) {
      res.writeHead(404);
      res.end('Not found. MCP endpoint at ' + MCP_PATH);
      return;
    }

    if (BLOCKED_IPS.size > 0) {
      const earlyIp = getClientIp(req);
      if (BLOCKED_IPS.has(earlyIp)) {
        console.error(`[cz-agents/eu-registry] blocked ip=${earlyIp}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'blocked', message: 'Your IP has been temporarily blocked due to unusual traffic patterns.' }));
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, authorization, x-request-id',
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

    const hostedContext=tokenStore
      ? authenticateHostedRequest(req,res,tokenStore,process.env.ENTITLEMENT_ACCOUNT_HASH_SALT ?? process.env.LOOKUP_HASH_SALT ?? 'czagents-entitlement')
      : null;
    if(tokenStore && !hostedContext)return;

    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      const clientIpEarly = getClientIp(req);
      const clientUaEarly = getClientUa(req);
      if (!checkSessionLimit(clientIpEarly)) {
        console.error(`[cz-agents/eu-registry] session limit exceeded ip=${clientIpEarly}`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_limit_exceeded', message: `Max ${SESSION_LIMIT_MAX} new sessions/min per IP.` }));
        return;
      }

      const newSessionId = randomUUID();
      const server = buildEuRegistryServer({authorizeLookup});
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/eu-registry] new session: ${id} ip=${clientIpEarly}`);
          registerSession(id, clientIpEarly, clientUaEarly);
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          console.error(`[cz-agents/eu-registry] closed session: ${transport.sessionId}`);
        }
      };
      await server.connect(transport);
    }

    const clientIp = getClientIp(req);
    setRequestIp(clientIp);
    try {
      const handle=()=>runWithIp(clientIp,()=>transport.handleRequest(req,res));
      if(hostedContext) await runWithHostedRequestContext(hostedContext,handle);
      else await handle();
    } finally {
      clearRequestIp();
    }
  });

  http.listen(PORT, () => {
    console.error(
      `[cz-agents/eu-registry] Streamable HTTP MCP server listening on :${PORT}${MCP_PATH}`,
    );
  });
}

async function handleEuRegistryRest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  limiter: ReturnType<typeof createRestRateLimiter>,
): Promise<boolean> {
  if (!req.url) return false;
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/v1/')) return false;
  if (url.pathname === '/v1/health') return false;

  if (req.method !== 'GET') {
    jsonErr(res, 405, 'method_not_allowed', 'Use GET for REST requests.');
    return true;
  }

  if (!limiter(req, res)) return true;
  const clientIp = getRestIp(req);

  await runWithIp(clientIp, async () => {
    jsonErr(res, 404, 'not_found', 'REST endpoint not found.');
  });

  return true;
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[cz-agents/eu-registry] fatal:', err);
    process.exit(1);
  });
}
