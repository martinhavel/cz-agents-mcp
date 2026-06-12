/**
 * Authentication + quota middleware for HTTP transport.
 *
 * Behaviour:
 *   - No `Authorization` header → caller is on the **free tier** (subject to
 *     IP-based daily rate limit handled separately by `rateLimit.ts`).
 *   - `Authorization: Bearer <token>` → look up token, decrement counter or
 *     credits. Sets response headers `X-Tier`, `X-Quota-Remaining`.
 *   - Unknown / revoked token → 401.
 *   - Quota exhausted → 429 with `Retry-After` header.
 *   - Pay-per-report credits = 0 → 402 (Payment Required) with hint to top up.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TokenStore } from './tokenStore.js';
import type { AuthOutcome, ServiceKind, TokenRecord } from './types.js';

export interface QuotaOptions {
  store: TokenStore;
  service: ServiceKind;
  /** Allow requests without a token (free tier). Default true. */
  allowAnonymous?: boolean;
}

export function createQuotaGuard(opts: QuotaOptions) {
  const { store, service, allowAnonymous = true } = opts;

  return function guard(req: IncomingMessage, res: ServerResponse): AuthOutcome {
    const auth = req.headers['authorization'];
    const headerStr = Array.isArray(auth) ? auth[0] : auth;
    const token = extractBearer(headerStr);

    if (!token) {
      if (allowAnonymous) {
        res.setHeader('X-Tier', 'free');
        res.setHeader('X-RateLimit-Remaining', '-1');
        return { ok: true, token: anonymousFreeToken(service) };
      }
      writeJson(res, 401, { error: 'unauthorized', message: 'Authorization: Bearer <token> required.' });
      return { ok: false, status: 401, reason: 'no_token' };
    }

    const record = store.find(token);
    if (!record || record.service !== service) {
      writeJson(res, 401, { error: 'unauthorized', message: 'Token unknown or for a different service.' });
      return { ok: false, status: 401, reason: 'unknown_token' };
    }

    try {
      const updated = store.consume(token);
      const remaining = computeRemaining(updated);
      res.setHeader('X-Tier', updated.tier);
      if (remaining !== null) {
        res.setHeader('X-Quota-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
      }
      const limit = updated.monthly_quota ?? updated.credits;
      if (limit !== null && limit !== undefined) res.setHeader('X-RateLimit-Limit', String(limit));
      if (updated.expires_at != null) res.setHeader('X-Trial-Expires-At', new Date(updated.expires_at).toISOString());
      return { ok: true, token: updated };
    } catch (e) {
      const code = e instanceof Error ? e.message : 'UNKNOWN';
      if (code === 'TRIAL_EXPIRED') {
        writeJson(res, 402, { error: 'trial_expired', message: 'Your trial has expired. Upgrade at https://cz-agents.dev/pricing.html' });
        return { ok: false, status: 402, reason: 'trial_expired' };
      }
      if (code === 'QUOTA_EXCEEDED') {
        res.setHeader('Retry-After', '60');
        res.setHeader('X-RateLimit-Remaining', '0');
        writeJson(res, 429, { error: 'quota_exceeded', message: 'Monthly quota exceeded. Upgrade at https://cz-agents.dev/pricing.html' });
        return { ok: false, status: 429, reason: 'quota' };
      }
      if (code === 'CREDITS_EXHAUSTED') {
        res.setHeader('X-RateLimit-Remaining', '0');
        writeJson(res, 402, { error: 'credits_exhausted', message: 'No remaining report credits. Top up at https://cz-agents.dev/pricing.html' });
        return { ok: false, status: 402, reason: 'credits' };
      }
      if (code === 'TOKEN_NOT_FOUND') {
        // The token resolved via find() but was gone by consume() (e.g. deleted
        // between the two calls) — an auth condition, not a server fault.
        writeJson(res, 401, { error: 'unauthorized', message: 'Token unknown or for a different service.' });
        return { ok: false, status: 401, reason: 'unknown_token' };
      }
      writeJson(res, 500, { error: 'internal', message: 'Token consume failed.' });
      return { ok: false, status: 500, reason: 'internal' };
    }
  };
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

function computeRemaining(record: TokenRecord): number | null {
  if (record.credits !== null) return record.credits;
  if (record.monthly_quota !== null) return Math.max(0, record.monthly_quota - record.counter);
  return null;
}

function anonymousFreeToken(service: ServiceKind): TokenRecord {
  // Synthetic record so call sites can treat free + paid uniformly downstream.
  return {
    token: '__anonymous__',
    service,
    tier: 'free',
    stripe_customer_id: '',
    stripe_subscription_id: null,
    monthly_quota: null,
    counter: 0,
    credits: null,
    period_started_at: 0,
    created_at: 0,
    updated_at: 0,
    revoked_at: null,
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
