import type { IncomingMessage, ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getClientIp } from '../rateLimit.js';
import { McpRequestBodyError, readMcpRequestBody } from '../mcpRequestBody.js';
import { AnonymousQuotaStore, ANONYMOUS_DAILY_TOOL_LIMIT } from './anonymousQuotaStore.js';
import { TokenStore } from './tokenStore.js';

type LookupService = 'ares' | 'cnb' | 'isir' | 'dd';
const REGISTER_URL = 'https://app.cz-agents.dev/prihlaseni?callbackUrl=%2Fapp%2Fbilling';
const PRICING_URL = 'https://cz-agents.dev/pricing.html';
const MONTH_MS = 30 * 86_400_000;
interface OutcomeContext {
  observe(message: unknown): boolean;
  cancel(): void;
}
interface HostedQuotaRequest { ok: boolean; parsedBody?: unknown; outcome?: OutcomeContext }
interface QuotaTransport { send(message: object, options?: object): Promise<void> }
const outcomes = new AsyncLocalStorage<OutcomeContext>();
const wrappedTransports = new WeakSet<QuotaTransport>();

/** Observe SDK results, including validation failures, before JSON headers are sent. */
export async function runWithHostedToolQuota(
  request: HostedQuotaRequest, transport: QuotaTransport, operation: () => Promise<void>,
): Promise<void> {
  if (!request.outcome) return operation();
  if (!wrappedTransports.has(transport)) {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if (outcomes.getStore()?.observe(message) === false) return;
      await send(message, options);
    };
    wrappedTransports.add(transport);
  }
  try { await outcomes.run(request.outcome, operation); }
  finally { request.outcome.cancel(); }
}


/** Opt-in transport boundary. All enabled services must mount the same TOKEN_DB. */
export function createHostedToolQuota(options: {
  service: LookupService;
  enabled: boolean;
  dbPath?: string;
  maxBodyBytes: number;
  /** ARES previously accepts stored tokens through hosted entitlement auth. */
  allowLegacyAresTokens?: boolean;
}) {
  if (!options.enabled) return async (_req: IncomingMessage, _res: ServerResponse) =>
    ({ ok: true, parsedBody: undefined } as const);
  if (!options.dbPath) throw new Error('Hosted tool quotas require a shared TOKEN_DB');
  const anonymous = new AnonymousQuotaStore(options.dbPath);
  const tokens = new TokenStore(options.dbPath);

  return async (req: IncomingMessage, res: ServerResponse): Promise<HostedQuotaRequest> => {
    try {
      const header = req.headers.authorization;
      const value = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] : undefined;
      if (header !== undefined && !value) return reject(res, 401, 'unauthorized', 'Malformed bearer credential.');
      const record = value ? tokens.find(value) : null;
      if (value && !record) return reject(res, 401, 'unauthorized', 'Token unknown or revoked.');
      if (record?.expires_at != null && Date.now() > record.expires_at)
        return reject(res, 402, 'trial_expired', 'Token expired.');
      const identity = record?.service === 'identity';
      if (identity && options.service === 'dd')
        return reject(res, 401, 'unauthorized', 'This lookup credential does not authorize DD reports.');
      if (record && !identity && !(options.service === 'dd' && record.service === 'dd')
        && !(options.service === 'ares' && options.allowLegacyAresTokens))
        return reject(res, 401, 'unauthorized', 'Token is for a different service.');

      if (req.method !== 'POST') return { ok: true };
      const body = await readMcpRequestBody(req, options.maxBodyBytes);
      if (body.toolCallCount === 0 || (record && !identity)) return { ok: true, parsedBody: body.parsedBody };

      if (identity && record) {
        try {
          if (new Set(body.toolCallIds).size !== body.toolCallIds.length)
            return reject(res, 400, 'invalid_request', 'Tool request IDs must be unique within a batch.');
          const reservation = tokens.reserveIdentity(record.token, body.toolCallCount);
          const updated = reservation.snapshot;
          headers(res, 'Registered', updated.lookupLimit, updated.lookupRemaining, updated.period_started_at + MONTH_MS);
          const outcome = observeReservation(tokens, reservation, body.toolCallIds, res);
          return { ok: true, parsedBody: body.parsedBody, outcome };
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'QUOTA_EXCEEDED') throw error;
          res.setHeader('Retry-After', retryAfter(record.period_started_at + MONTH_MS));
          return reject(res, 429, 'registered_quota_exceeded',
            'Your free and purchased lookup allowances are exhausted. Open billing to view availability of another 10,000-call package. DD report credits do not increase lookup access.',
            { pricing_url: REGISTER_URL });
        }
      } else {
        const quota = anonymous.consume(getClientIp(req), Date.now(), body.toolCallCount);
        headers(res, 'Anonymous', ANONYMOUS_DAILY_TOOL_LIMIT, quota.remaining, quota.resetAt);
        if (res.getHeader('X-RateLimit-Remaining') === '-1') res.removeHeader('X-RateLimit-Remaining');
        if (!quota.allowed) {
          res.setHeader('Retry-After', retryAfter(quota.resetAt));
          return reject(res, 429, 'anonymous_quota_exceeded',
            options.service === 'dd'
              ? 'The shared 100-call daily allowance is exhausted. Activate a DD trial or purchase DD report credits.'
              : 'The shared 100-call daily allowance is exhausted. Register for a shared 2,000-call monthly lookup allowance for ARES, CNB and ISIR.',
            options.service === 'dd'
              ? { registration_url: `${PRICING_URL}#trial`, pricing_url: PRICING_URL }
              : { registration_url: REGISTER_URL });
        }
      }
      return { ok: true, parsedBody: body.parsedBody };
    } catch (error) {
      if (error instanceof McpRequestBodyError) {
        if (error.closeConnection) {
          res.setHeader('Connection', 'close');
          res.once('finish', () => req.destroy());
        }
        return reject(res, error.status, error.code, error.message);
      }
      return reject(res, 503, 'quota_unavailable', 'Usage accounting is temporarily unavailable. Try again later.');
    }
  };
}

function observeReservation(
  store: TokenStore, reservation: ReturnType<TokenStore['reserveIdentity']>, ids: Array<string | number>,
  res: ServerResponse,
): OutcomeContext {
  const expected = new Set(ids);
  const completed = new Map<string | number, boolean>();
  let settled = false;
  const finish = (successfulCalls: number) => {
    if (settled) return true;
    const result = store.settleIdentityReservation(reservation.id, successfulCalls);
    settled = true;
    clearTimeout(timer);
    res.off('finish', cleanup);
    res.off('close', cleanup);
    if (result && !res.headersSent) headers(res, 'Registered', result.snapshot.lookupLimit,
      result.snapshot.lookupRemaining, result.snapshot.period_started_at + MONTH_MS);
    return result !== null && !result.expired;
  };
  const unavailable = () => {
    if (!res.headersSent && !res.destroyed)
      reject(res, 503, 'quota_unavailable', 'Usage accounting is temporarily unavailable. Try again later.');
    else if (!res.writableEnded) res.destroy();
  };
  const cleanup = () => {
    if (settled) return;
    try { finish(0); } catch { unavailable(); }
  };
  const timer = setTimeout(() => { cleanup(); unavailable(); }, Math.max(1, reservation.expiresAt - Date.now()));
  timer.unref();
  res.once('finish', cleanup);
  res.once('close', cleanup);
  return {
    cancel: cleanup,
    observe(message) {
      if (settled) return !res.destroyed && !res.writableEnded;
      if (!message || typeof message !== 'object') return true;
      const response = message as Record<string, unknown>;
      if ((typeof response.id !== 'string' && typeof response.id !== 'number') || !expected.has(response.id)) return true;
      if (!Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error')) return true;
      if (completed.has(response.id)) return true;
      const result = response.result;
      completed.set(response.id, !Object.hasOwn(response, 'error') && !!result && typeof result === 'object'
        && !Array.isArray(result) && Array.isArray((result as Record<string, unknown>).content)
        && (result as Record<string, unknown>).isError !== true);
      if (completed.size !== expected.size) return true;
      try {
        if (finish([...completed.values()].filter(Boolean).length)) return true;
      } catch { cleanup(); }
      unavailable();
      return false;
    },
  };
}

function retryAfter(resetAt: number): string { return String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))); }
function headers(res: ServerResponse, kind: string, limit: number, remaining: number, resetAt: number) {
  res.setHeader(`X-${kind}-Quota-Limit`, String(limit));
  res.setHeader(`X-${kind}-Quota-Remaining`, String(remaining));
  res.setHeader(`X-${kind}-Quota-Reset`, String(Math.floor(resetAt / 1000)));
}
function reject(res: ServerResponse, status: number, error: string, message: string, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error, message, ...extra }));
  return { ok: false };
}
