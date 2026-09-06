import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedToolQuota } from '../hostedToolQuota.js';
import { createQuotaGuard } from '../quota.js';
import { TokenStore } from '../tokenStore.js';
import Database from 'better-sqlite3';

type Service = 'ares' | 'cnb' | 'isir' | 'dd';

const toolCall = (id: number) => ({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'lookup', arguments: {} },
});

describe('hosted lookup tool quota at the HTTP boundary', () => {
  let dir: string;
  let store: TokenStore;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  const executed: Record<Service, number> = { ares: 0, cnb: 0, isir: 0, dd: 0 };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hosted-tool-quota-'));
    const dbPath = join(dir, 'tokens.db');
    store = new TokenStore(dbPath);
    const ddQuota = createQuotaGuard({ store, service: 'dd', allowAnonymous: true });
    const quotas = Object.fromEntries((['ares', 'cnb', 'isir', 'dd'] as Service[]).map((service) => [service,
      createHostedToolQuota({ service, enabled: true, dbPath, maxBodyBytes: 1_000_000 }),
    ])) as Record<Service, ReturnType<typeof createHostedToolQuota>>;

    server = createServer(async (req, res) => {
      const service = req.url?.slice(1) as Service;
      if (!(service in quotas)) {
        res.writeHead(404).end();
        return;
      }
      if (service === 'dd' && !ddQuota(req, res).ok) return;
      const result = await quotas[service](req, res);
      if (!result.ok) return;
      executed[service] += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not charge initialize or tools/list, then shares anonymous calls across lookup services', async () => {
    await expect(post('ares', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }).then((r) => r.status)).resolves.toBe(200);
    await expect(post('cnb', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }).then((r) => r.status)).resolves.toBe(200);

    for (let index = 0; index < 100; index++) {
      const response = await post((['ares', 'cnb', 'isir'] as Service[])[index % 3]!, toolCall(index));
      expect(response.status).toBe(200);
    }

    const rejected = await post('isir', toolCall(101));
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ error: 'anonymous_quota_exceeded' });
    expect(executed.isir).toBe(33);
  });

  it('shares a registered identity allowance across ARES, CNB, and ISIR, atomically rejecting call 2001', async () => {
    const identity = store.mint({
      service: 'identity', tier: 'free', stripe_customer_id: 'identity_test', stripe_subscription_id: null,
      monthly_quota: 2000, credits: null,
    });
    const batches = [800, 800, 400] as const;
    for (const [index, calls] of batches.entries()) {
      const service = (['ares', 'cnb', 'isir'] as Service[])[index]!;
      const response = await post(service, Array.from({ length: calls }, (_, id) => toolCall(id)), identity.token);
      expect(response.status).toBe(200);
    }
    expect(store.find(identity.token)?.counter).toBe(2000);

    const rejected = await post('cnb', toolCall(2001), identity.token);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ error: 'registered_quota_exceeded' });
    expect(store.find(identity.token)?.counter).toBe(2000);
  });

  it('rejects an identity token at DD before execution while paid DD credits keep their original consumption', async () => {
    const identity = store.mint({
      service: 'identity', tier: 'free', stripe_customer_id: 'identity_test', stripe_subscription_id: null,
      monthly_quota: 2000, credits: null,
    });
    const denied = await post('dd', toolCall(1), identity.token);
    expect(denied.status).toBe(401);
    expect(executed.dd).toBe(0);

    const paidDd = store.mint({
      service: 'dd', tier: 'pay-per-report', stripe_customer_id: 'paid_test', stripe_subscription_id: null,
      monthly_quota: null, credits: 1,
    });
    const accepted = await post('dd', toolCall(2), paidDd.token);
    expect(accepted.status).toBe(200);
    expect(store.find(paidDd.token)?.credits).toBe(0);
  });

  it('atomically crosses free into paid quota, rejects exhaustion, and preserves free usage after refund/expiry', async () => {
    const identity = store.mint({ service: 'identity', tier: 'free', stripe_customer_id: 'identity_paid',
      stripe_subscription_id: null, monthly_quota: 2000, credits: null });
    const db = new Database(join(dir, 'tokens.db'));
    const now = Date.now();
    db.prepare('UPDATE tokens SET counter=1999 WHERE token=?').run(identity.token);
    db.prepare(`INSERT INTO lookup_purchases (session_id,payment_intent_id,account,price_id,currency,subtotal,starts_at,expires_at,used)
      VALUES ('cs_paid','pi_paid','identity_paid','price_lookup','czk',49000,?,?,9999)`)
      .run(now - 1000, now + 86400000);
    // Three calls cannot fit the combined remaining two; neither bucket moves.
    expect((await post('ares', [toolCall(1), toolCall(2), toolCall(3)], identity.token)).status).toBe(429);
    expect(store.find(identity.token)?.counter).toBe(1999);
    expect(db.prepare('SELECT used FROM lookup_purchases').get()).toEqual({ used: 9999 });
    expect((await post('cnb', toolCall(4), identity.token)).status).toBe(200);
    expect((await post('isir', toolCall(5), identity.token)).status).toBe(200);
    expect((await post('ares', toolCall(6), identity.token)).status).toBe(429);
    expect(db.prepare('SELECT used FROM lookup_purchases').get()).toEqual({ used: 10000 });
    db.prepare('UPDATE lookup_purchases SET used=0,refunded_at=?').run(now);
    expect((await post('cnb', toolCall(7), identity.token)).status).toBe(429);
    db.prepare('UPDATE lookup_purchases SET refunded_at=NULL,expires_at=?').run(now - 1);
    expect((await post('isir', toolCall(8), identity.token)).status).toBe(429);
    expect(store.find(identity.token)?.counter).toBe(2000);
    db.close();
  });

  async function post(service: Service, body: unknown, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/${service}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }
});
