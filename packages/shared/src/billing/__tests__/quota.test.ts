import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TokenStore } from '../tokenStore.js';
import { createQuotaGuard, createTokenAuthGuard } from '../quota.js';

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, url: '/mcp', method: 'POST' } as IncomingMessage;
}

function mockRes() {
  const r: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    headersSent: false,
    body: '',
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    writeHead(code: number, hdrs?: Record<string, string>) {
      this.statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
      this.headersSent = true;
    },
    end(body?: string) { if (body) this.body = body; this.headersSent = true; },
  };
  return r as ServerResponse & typeof r;
}

describe('createQuotaGuard', () => {
  let tmp: string;
  let store: TokenStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'czat-quota-'));
    store = new TokenStore(join(tmp, 'tokens.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('allows anonymous request with free tier when allowAnonymous=true', () => {
    const guard = createQuotaGuard({ store, service: 'sanctions', allowAnonymous: true });
    const req = mockReq({});
    const res = mockRes();
    const r = guard(req, res);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token.tier).toBe('free');
    expect(res.headers['x-tier']).toBe('free');
  });

  it('rejects anonymous when allowAnonymous=false', () => {
    const guard = createQuotaGuard({ store, service: 'sanctions', allowAnonymous: false });
    const req = mockReq({});
    const res = mockRes();
    const r = guard(req, res);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('allows valid token + decrements counter', () => {
    const t = store.mint({
      service: 'sanctions', tier: 'pro', stripe_customer_id: 'c', stripe_subscription_id: 's',
      monthly_quota: 100, credits: null,
    });
    const guard = createQuotaGuard({ store, service: 'sanctions' });
    const res = mockRes();
    const r = guard(mockReq({ authorization: `Bearer ${t.token}` }), res);
    expect(r.ok).toBe(true);
    expect(res.headers['x-tier']).toBe('pro');
    expect(res.headers['x-quota-remaining']).toBe('99');
  });

  it('authenticates a preflight without consuming report quota', () => {
    const t = store.mint({
      service: 'dd', tier: 'pro', stripe_customer_id: 'c', stripe_subscription_id: 's',
      monthly_quota: 100, credits: null,
    });
    const guard = createTokenAuthGuard({ store, service: 'dd' });
    const before = store.find(t.token);
    const result = guard(mockReq({ authorization: `Bearer ${t.token}` }), mockRes());
    const after = store.find(t.token);

    expect(result.ok).toBe(true);
    expect(after?.requests_used).toBe(before?.requests_used);
  });

  it('rejects unknown token with 401', () => {
    const guard = createQuotaGuard({ store, service: 'sanctions' });
    const res = mockRes();
    const r = guard(mockReq({ authorization: 'Bearer czat_bogus' }), res);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('rejects token from different service with 401', () => {
    const t = store.mint({
      service: 'sanctions', tier: 'pro', stripe_customer_id: 'c', stripe_subscription_id: 's',
      monthly_quota: 100, credits: null,
    });
    const guard = createQuotaGuard({ store, service: 'dd' });
    const res = mockRes();
    const r = guard(mockReq({ authorization: `Bearer ${t.token}` }), res);
    expect(r.ok).toBe(false);
  });

  it('returns 429 when quota exceeded', () => {
    const t = store.mint({
      service: 'sanctions', tier: 'starter', stripe_customer_id: 'c', stripe_subscription_id: 's',
      monthly_quota: 1, credits: null,
    });
    const guard = createQuotaGuard({ store, service: 'sanctions' });
    guard(mockReq({ authorization: `Bearer ${t.token}` }), mockRes()); // consumes the 1
    const res = mockRes();
    const r = guard(mockReq({ authorization: `Bearer ${t.token}` }), res);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
  });

  it('returns 402 when pay-per-report credits exhausted', () => {
    const t = store.mint({
      service: 'dd', tier: 'pay-per-report', stripe_customer_id: 'c', stripe_subscription_id: null,
      monthly_quota: null, credits: 1,
    });
    const guard = createQuotaGuard({ store, service: 'dd' });
    guard(mockReq({ authorization: `Bearer ${t.token}` }), mockRes()); // consumes the 1
    const res = mockRes();
    const r = guard(mockReq({ authorization: `Bearer ${t.token}` }), res);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(402);
  });

  it('maps TOKEN_NOT_FOUND from consume to HTTP 401 (not 500)', () => {
    const t = store.mint({
      service: 'sanctions', tier: 'pro', stripe_customer_id: 'c', stripe_subscription_id: 's',
      monthly_quota: 100, credits: null,
    });
    // Simulate a delete between find() and consume(): the token resolves, then
    // consume() throws TOKEN_NOT_FOUND. Must be treated as 401, not a 500.
    (store as unknown as { consume: () => never }).consume = () => {
      throw new Error('TOKEN_NOT_FOUND');
    };
    const guard = createQuotaGuard({ store, service: 'sanctions' });
    const res = mockRes();
    const r = guard(mockReq({ authorization: `Bearer ${t.token}` }), res);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
    expect(res.statusCode).toBe(401);
  });

  it('handles malformed Authorization header gracefully', () => {
    const guard = createQuotaGuard({ store, service: 'sanctions', allowAnonymous: true });
    const res = mockRes();
    // "Bearer" without token → falls back to anonymous (no token extracted)
    const r = guard(mockReq({ authorization: 'Bearer' }), res);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token.tier).toBe('free');
  });
});
