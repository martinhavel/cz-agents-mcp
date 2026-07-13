#!/usr/bin/env node
/**
 * Streamable HTTP entry for dd. Listens on PORT (default 3030) at /mcp.
 * Stripe webhook at /webhook/stripe (POST). Bearer-token quota enforcement on /mcp.
 *
 * Env:
 *   SANCTIONS_DB         — sanctions screening data (optional; missing → screening skipped)
 *   TOKEN_DB             — billing tokens SQLite (default ./tokens.db)
 *   STRIPE_WEBHOOK_SECRET
 *   ADIS_SOAP_ENABLED    — set to 1 to enable live ADIS unreliable-VAT-payer lookup
 *   MCP_AUDIT_URL        — webapp base URL for internal MCP audit ingestion
 *   MCP_AUDIT_KEY        — internal key sent to MCP audit ingestion
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
  jsonOk,
  jsonErr,
  parseIco,
  TokenStore,
  createQuotaGuard,
  createTokenAuthGuard,
  handleStripeWebhook,
  WebhookError,
  createSessionRegistry,
  registerSession,
  getClientIp,
  getClientUa,
} from '@czagents/shared';
import { EntitlementStore,HostedEntitlementResolver,entitlementMode,accountContextFromToken,
  runWithHostedRequestContext,getHostedRequestContext } from '@czagents/shared/entitlements';
import { AresClient } from '@czagents/ares';
import { SanctionsDb, SanctionsSearch } from '@czagents/sanctions';
import { IsirClient } from '@czagents/isir';
import { AdisClient } from '@czagents/adis';
import { buildDdServer } from './server.js';
import type { DdLookupAuthorizer } from './server.js';
import type { DdClients } from './clients.js';
import { buildDdBilling } from './billing.js';
import { buildReport } from './report.js';
import { vrClient, vrBaseClient } from './vr-client.js';

const PORT = Number(process.env.PORT ?? 3030);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const PUBLIC_MCP_URL = process.env.PUBLIC_MCP_URL ?? 'https://dd.cz-agents.dev/mcp';
const OAUTH_ISSUER = process.env.OAUTH_ISSUER ?? 'https://app.cz-agents.dev';
const OAUTH_RESOURCE_METADATA_URL =
  process.env.OAUTH_RESOURCE_METADATA_URL ?? 'https://dd.cz-agents.dev/.well-known/oauth-protected-resource/mcp';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 30);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 100_000);
const ENTITLEMENT_MODE=entitlementMode(process.env.HOSTED_GEO_TIER_ENFORCEMENT);
const UPGRADE_URL=process.env.HOSTED_UPGRADE_URL ?? 'https://cz-agents.dev/pricing.html';

async function main() {
  const ares = new AresClient();

  let sanctions: SanctionsSearch | undefined;
  if (process.env.SANCTIONS_DB) {
    const db = new SanctionsDb(process.env.SANCTIONS_DB);
    sanctions = new SanctionsSearch(db);
  }

  const isir = new IsirClient();
  const adis = new AdisClient();

  const clients: DdClients = { ares, sanctions, isir, adis, vr: vrClient, vrBase: vrBaseClient };

  const tokenDbPath = process.env.TOKEN_DB ?? './tokens.db';
  const tokenStore = new TokenStore(tokenDbPath);
  const entitlementStore=ENTITLEMENT_MODE==='off'?null:new EntitlementStore(tokenDbPath);
  const entitlementResolver=entitlementStore?new HostedEntitlementResolver(entitlementStore,{mode:ENTITLEMENT_MODE,
    upgradeUrl:UPGRADE_URL,cacheTtlMs:Number(process.env.HOSTED_POLICY_CACHE_TTL_MS ?? 30_000)}):null;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  // Build the price→tier map only when the webhook is enabled. Fail-fast: if a
  // required canonical price-id env var is missing, boot aborts with its name
  // rather than silently mapping no prices (= paid checkout, no token minted).
  const billing = webhookSecret ? buildDdBilling() : undefined;
  const authOnly = createTokenAuthGuard({ store: tokenStore, service: 'dd', allowAnonymous: true });
  const quota = ENTITLEMENT_MODE==='off'
    ? createQuotaGuard({ store: tokenStore, service: 'dd', allowAnonymous: true })
    : authOnly;
  const authorizeLookup:DdLookupAuthorizer|undefined=entitlementResolver?async(lookup)=>{
    const context=getHostedRequestContext();
    if(!context)return {upstreamAllowed:false,error:{error:'policy_unavailable',dimension:'coverage',message:'Hosted account context is unavailable.'}};
    const decision=entitlementResolver.check({account:context.account,country:lookup.country,requestedDepth:lookup.depth,
      endpoint:`mcp:${lookup.tool}`,requestId:context.requestId,
      usageMetric:lookup.depth==='ddplus'?'ddplus_reports_per_month':'requests_per_day'});
    if(!decision.upstreamAllowed)return {upstreamAllowed:false,error:decision.error,
      record:(called)=>entitlementResolver.record(decision,called)};
    const quotaError=consumeForTool(tokenStore,context.account.token);
    if(quotaError)return {upstreamAllowed:false,error:quotaError,
      record:(called)=>entitlementResolver.record(decision,called)};
    return {upstreamAllowed:true,record:(called)=>entitlementResolver.record(decision,called)};
  }:undefined;
  const ddRestLimiter = createRestRateLimiter({ max: 60, windowMs: 60 * 60 * 1000 });

  const transports = createSessionRegistry<StreamableHTTPServerTransport>();
  const limiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX, getIp: getClientIp });

  const http = createServer(async (req, res) => {
    // Permissive Accept-header rewrite for clients that send "*/*"
    // (Anthropic Connector probe-tester uses python-httpx with default
    // Accept: */* — MCP SDK does literal string-includes check and returns
    // 406, which Claude.ai surfaces as "Couldn't reach"). hono/node-server
    // (used by SDK transport) reads from req.rawHeaders, so we must patch
    // BOTH the parsed object AND the raw array.
    if (req.url?.startsWith(MCP_PATH)) {
      const accept = req.headers.accept;
      if (!accept || accept === '*/*' || accept.includes('*/*')) {
        const fixed = 'application/json, text/event-stream';
        req.headers.accept = fixed;
        const rh = req.rawHeaders;
        for (let i = 0; i + 1 < rh.length; i += 2) {
          if (rh[i] && rh[i]!.toLowerCase() === 'accept') {
            rh[i + 1] = fixed;
          }
        }
      }
    }

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

    if (
      req.method === 'GET' &&
      (req.url === '/.well-known/oauth-protected-resource' ||
        req.url === '/.well-known/oauth-protected-resource/mcp')
    ) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      });
      res.end(JSON.stringify({
        resource: PUBLIC_MCP_URL,
        authorization_servers: [OAUTH_ISSUER],
        scopes_supported: ['mcp:dd'],
        bearer_methods_supported: ['header'],
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
      if (!webhookSecret || !billing) {
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
          config: billing,
        });
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } catch (e) {
        // WebhookError carries a client-safe validation message; anything else is an
        // internal fault whose raw message must not leak to the caller — log it, return
        // a generic 500.
        if (e instanceof WebhookError) {
          res.writeHead(e.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'webhook_failed', message: e.message }));
        } else {
          console.error('[dd] webhook handler error:', e);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'webhook_failed', message: 'Internal error.' }));
        }
      }
      return;
    }

    if (await handleDdRest(req, res, clients, quota, authOnly, ddRestLimiter,entitlementResolver,tokenStore)) return;

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

    // Streamable HTTP spec: a bare GET to /mcp without a session id is a
    // probe for a server-initiated SSE stream. For Claude Desktop connectors
    // this is also the OAuth discovery trigger, so advertise protected-resource
    // metadata instead of falling through to an SDK-level transport error.
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (req.method === 'GET' && !sessionId) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${OAUTH_RESOURCE_METADATA_URL}"`,
      });
      res.end(JSON.stringify({
        error: 'authorization_required',
        message: 'Use OAuth or Authorization: Bearer <token> for DD MCP connector access. Anonymous discovery probes remain available for catalogs.',
      }));
      return;
    }

    const auth = quota(req, res);
    if (!auth.ok) return;

    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else {
      const clientIpEarly = getClientIp(req);
      const clientUaEarly = getClientUa(req);
      const newSessionId = randomUUID();
      // Map token tier → DD server tier kind. 'pro' (API Compliance €99) and
      // 'agency' (Agency €199) both unlock pattern detectors; 'agency' adds
      // statutory_chain. Free / unknown tiers see only basic tools.
      const tokenTier = auth.token.tier as string;
      const ddTier = ENTITLEMENT_MODE!=='off' ? 'agency' as const :
        tokenTier === 'agency' || tokenTier === 're_agency' ? 'agency' as const :
        tokenTier === 'pro' || tokenTier === 're_pro' ? 'compliance' as const :
        tokenTier === 'enterprise' ? 'enterprise' as const :
        'free' as const;
      const audit = auth.token.token === '__anonymous__'
        ? undefined
        : { tokenId: auth.token.token, userId: auth.token.stripe_customer_id || undefined };
      const server = buildDdServer(clients, ddTier, { audit,authorizeLookup });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        // Allow plain application/json responses for clients (e.g. Anthropic
        // Connector tester) that don't advertise text/event-stream. Without
        // this the SDK returns 406 Not Acceptable, which Claude.ai surfaces
        // as "Couldn't reach the MCP server".
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          console.error(`[cz-agents/dd] new session: ${id} (tier=${auth.token.tier})`);
          registerSession(id, clientIpEarly, clientUaEarly);
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

    const clientIp = getClientIp(req);
    const hostedContext=entitlementResolver?{account:accountContextFromToken(auth.token,clientIp,
      process.env.ENTITLEMENT_ACCOUNT_HASH_SALT ?? process.env.LOOKUP_HASH_SALT ?? 'czagents-entitlement'),
      requestId:(Array.isArray(req.headers['x-request-id'])?req.headers['x-request-id'][0]:req.headers['x-request-id']) ?? randomUUID()}:null;
    setRequestIp(clientIp);
    try {
      const handle=()=>runWithIp(clientIp,()=>transport.handleRequest(req,res));
      if(hostedContext)await runWithHostedRequestContext(hostedContext,handle);else await handle();
    } finally {
      clearRequestIp();
    }
  });

  http.listen(PORT, () => {
    console.error(
      `[cz-agents/dd] listening on :${PORT}${MCP_PATH} (sanctions=${sanctions ? 'enabled' : 'disabled'}, tokens: ${tokenDbPath}, webhook: ${webhookSecret ? 'enabled' : 'disabled'})`,
    );
  });
}

async function handleDdRest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  clients: DdClients,
  quota: ReturnType<typeof createQuotaGuard>,
  authOnly: ReturnType<typeof createTokenAuthGuard>,
  limiter: ReturnType<typeof createRestRateLimiter>,
  entitlementResolver:HostedEntitlementResolver|null,
  tokenStore:TokenStore,
): Promise<boolean> {
  if (!req.url) return false;
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/v1/')) return false;

  if (req.method !== 'GET') {
    jsonErr(res, 405, 'method_not_allowed', 'Use GET for REST requests.');
    return true;
  }

  if (!limiter(req, res)) return true;

  // The no-upstream entitlement preflight must never consume the legacy report
  // quota, including while the rollout flag is `off`.
  const auth = (url.pathname === '/v1/entitlements/check' ? authOnly : quota)(req, res);
  if (!auth.ok) return true;

  const isPaid = auth.token.tier !== 'free';
  const clientIp = getRestIp(req);

  await runWithIp(clientIp, async () => {
    try {
      if(url.pathname==='/v1/entitlements/check') {
        if(!entitlementResolver) { jsonOk(res,{allowed:true,mode:'off'},'dd');return; }
        const country=url.searchParams.get('country') ?? 'CZ';
        const requested=url.searchParams.get('depth')==='ddplus'?'ddplus' as const:'basic' as const;
        const account=accountContextFromToken(auth.token,clientIp,
          process.env.ENTITLEMENT_ACCOUNT_HASH_SALT ?? process.env.LOOKUP_HASH_SALT ?? 'czagents-entitlement');
        const decision=entitlementResolver.check({account,country,requestedDepth:requested,
          endpoint:'rest:entitlement_check',requestId:randomUUID()});
        entitlementResolver.record(decision,false);
        if(!decision.upstreamAllowed){writeRestAccessError(res,decision.error);return;}
        jsonOk(res,{allowed:true,mode:decision.mode,would_gate:decision.wouldGate,country:decision.country,
          country_group:decision.countryGroup,coverage_tier:decision.coverageTier,depth_tier:decision.depthTier,
          policy_version:decision.policyVersion,source:decision.source},'dd');return;
      }
      // GET /v1/dd/{ico}
      const ddMatch = url.pathname.match(/^\/v1\/dd\/([0-9]{7,8})$/);
      if (ddMatch) {
        const ico = parseIco(req, res);
        if (!ico) return;
        const depth = isPaid ? 'full' : 'basic';
        const access=restAccess(entitlementResolver,tokenStore,auth.token,'CZ',depth==='full'?'ddplus':'basic','rest:get_dd_report',req);
        if(!access.allowed){writeRestAccessError(res,access.error);return;}
        let report;
        try{report = await buildReport(ico, clients, { depth });}finally{access.record?.(true);}
        jsonOk(res, report, 'dd');
        return;
      }

      // GET /v1/dd/{ico}/risk
      const riskMatch = url.pathname.match(/^\/v1\/dd\/([0-9]{7,8})\/risk$/);
      if (riskMatch) {
        const ico = parseIco(req, res);
        if (!ico) return;
        const access=restAccess(entitlementResolver,tokenStore,auth.token,'CZ','ddplus','rest:get_risk_score',req);
        if(!access.allowed){writeRestAccessError(res,access.error);return;}
        let report;
        try{report=await buildReport(ico,clients,{depth:'basic'});}finally{access.record?.(true);}
        const top = report.red_flags.slice().sort((a: { weight: number }, b: { weight: number }) => b.weight - a.weight).slice(0, 5);
        jsonOk(res, {
          ico,
          company_name: report.company.name,
          value: report.risk_score.value,
          level: report.risk_score.level,
          top_flags: top,
          tier: auth.token.tier,
        }, 'dd');
        return;
      }

      jsonErr(res, 404, 'not_found', 'REST endpoint not found. See https://cz-agents.dev/docs/api.html');
    } catch (e) {
      // Don't leak the raw upstream/internal message to the client; log it server-side.
      console.error('[dd] REST handler error:', e);
      jsonErr(res, 500, 'upstream_error', 'Upstream request failed.');
    }
  });

  return true;
}

function consumeForTool(store:TokenStore,token:import('@czagents/shared').TokenRecord|null):unknown|null {
  if(!token||token.token==='__anonymous__')return null;
  try{store.consume(token.token);return null;}catch(error){
    const code=error instanceof Error?error.message:'UNKNOWN';
    if(code==='QUOTA_EXCEEDED')return {error:'quota_exceeded',dimension:'usage',message:'Monthly quota exceeded.',upgrade_url:UPGRADE_URL};
    if(code==='CREDITS_EXHAUSTED')return {error:'credits_exhausted',dimension:'usage',message:'No report credits remain.',upgrade_url:UPGRADE_URL};
    if(code==='TRIAL_EXPIRED')return {error:'trial_expired',dimension:'usage',message:'Trial entitlement expired.',upgrade_url:UPGRADE_URL};
    return {error:'unauthorized',dimension:'usage',message:'Token is no longer valid.'};
  }
}

function restAccess(resolver:HostedEntitlementResolver|null,store:TokenStore,token:import('@czagents/shared').TokenRecord,
  country:string,depth:'basic'|'ddplus',endpoint:string,req:import('node:http').IncomingMessage):{allowed:boolean;error?:unknown;record?:(called:boolean)=>void} {
  if(!resolver)return {allowed:true};
  const ip=getRestIp(req);const account=accountContextFromToken(token,ip,
    process.env.ENTITLEMENT_ACCOUNT_HASH_SALT ?? process.env.LOOKUP_HASH_SALT ?? 'czagents-entitlement');
  const decision=resolver.check({account,country,requestedDepth:depth,endpoint,requestId:randomUUID(),
    usageMetric:depth==='ddplus'?'ddplus_reports_per_month':'requests_per_day'});
  if(!decision.upstreamAllowed){resolver.record(decision,false);return {allowed:false,error:decision.error};}
  const quotaError=consumeForTool(store,token);
  if(quotaError){resolver.record(decision,false);return {allowed:false,error:quotaError};}
  return {allowed:true,record:(called)=>resolver.record(decision,called)};
}
function writeRestAccessError(res:import('node:http').ServerResponse,error:unknown):void {
  const body=(error&&typeof error==='object')?error:{error:'access_denied',message:'Access denied.'};
  const code=(body as {error?:string}).error;const status=code==='quota_exceeded'?429:code==='invalid_country'?400:code==='policy_unavailable'?503:402;
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));
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
