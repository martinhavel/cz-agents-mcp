import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedToolQuota } from '../hostedToolQuota.js';
import { TokenStore } from '../tokenStore.js';

type Service = 'ares' | 'cnb' | 'isir' | 'dd';
const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'lookup', arguments: {} } });
const batch = (n: number) => Array.from({ length: n }, (_, i) => call(i));

const dirs: string[] = [];
const servers: Server[] = [];
const stores: TokenStore[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Mounts all four services on one TOKEN_DB, like production. Client IP comes from X-Forwarded-For. */
async function harness(opts: { ladder: boolean; anonAllowlist?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-ladder-'));
  dirs.push(dir);
  const dbPath = join(dir, 'tokens.db');
  const store = new TokenStore(dbPath); stores.push(store);
  const quotas = Object.fromEntries((['ares', 'cnb', 'isir', 'dd'] as Service[]).map((service) =>
    [service, createHostedToolQuota({ service, enabled: true, dbPath, maxBodyBytes: 1_000_000, ...opts })]));
  const server = createServer(async (req, res) => {
    const result = await quotas[req.url!.slice(1)]!(req, res) as { ok: boolean; parsedBody?: unknown; outcome?: { observe(m: unknown): boolean } };
    if (!result.ok) return;
    // Report every call as a successful result so registered reservations are charged, not refunded.
    const calls = ([] as Array<{ id: number }>).concat((result.parsedBody ?? []) as never);
    for (const c of calls) result.outcome?.observe({ jsonrpc: '2.0', id: c.id, result: { content: [] } });
    if (!res.writableEnded) res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const post = (service: Service, body: unknown, o: { ip?: string; token?: string } = {}) => fetch(`http://127.0.0.1:${port}/${service}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip ?? '192.0.2.1',
      ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { store, post, dbPath };
}

describe('HOSTED_QUOTA_LADDER at the HTTP boundary', () => {
  it('ladder on: anon ARES 30 + CNB 20 exhausts the shared 50, ISIR blocked with limit-derived 429', async () => {
    const { post } = await harness({ ladder: true });
    expect((await post('ares', batch(30))).status).toBe(200);
    const last = await post('cnb', batch(20));
    expect(last.status).toBe(200);
    expect(last.headers.get('X-Anonymous-Quota-Limit')).toBe('50');
    expect(last.headers.get('X-Anonymous-Quota-Remaining')).toBe('0');
    const blocked = await post('isir', call(1));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('X-Anonymous-Quota-Limit')).toBe('50');
    const body = await blocked.json();
    expect(body).toMatchObject({ error: 'anonymous_quota_exceeded', registration_url: expect.stringContaining('prihlaseni') });
    expect(body.message).toContain('50-call daily');
  });

  it('ladder on: a /24 hitting the 250 cap reports the 30-day limit', async () => {
    const { post } = await harness({ ladder: true });
    for (let i = 1; i <= 5; i++) expect((await post('ares', batch(50), { ip: `198.51.100.${i}` })).status).toBe(200);
    const blocked = await post('cnb', call(1), { ip: '198.51.100.9' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('X-Anonymous-Quota-Limit')).toBe('250');
    expect((await blocked.json()).message).toContain('250-call 30-day');
  });

  it('ladder on: exhausting lookup does not block anonymous DD (own 100/day)', async () => {
    const { post } = await harness({ ladder: true });
    expect((await post('ares', batch(50))).status).toBe(200);
    expect((await post('ares', call(1))).status).toBe(429);
    const dd = await post('dd', batch(100));
    expect(dd.status).toBe(200);
    expect(dd.headers.get('X-Anonymous-Quota-Limit')).toBe('100');
    const ddBlocked = await post('dd', call(1));
    expect(ddBlocked.status).toBe(429);
    expect((await ddBlocked.json()).message).toContain('DD trial');
  });

  it('ladder off (today): lookup and DD share one 100/day bucket per exact IP', async () => {
    const { post } = await harness({ ladder: false });
    expect((await post('ares', batch(100))).status).toBe(200);
    const dd = await post('dd', call(1));
    expect(dd.status).toBe(429);
    expect(dd.headers.get('X-Anonymous-Quota-Limit')).toBe('100');
    expect((await dd.json()).message).toBe('The shared 100-call daily allowance is exhausted. Activate a DD trial or purchase DD report credits.');
    // different IP in the same /24 is unaffected in legacy mode
    expect((await post('ares', batch(100), { ip: '192.0.2.77' })).status).toBe(200);
  });

  it('ladder off: legacy lookup 429 text is unchanged', async () => {
    const { post } = await harness({ ladder: false });
    await post('cnb', batch(100));
    const blocked = await post('isir', call(1));
    expect((await blocked.json()).message).toBe(
      'The shared 100-call daily allowance is exhausted. Register for a shared 2,000-call monthly lookup allowance for ARES, CNB and ISIR.');
  });

  it('allowlisted CIDR (v4 and v6) gets 500/day without the 30-day cap', async () => {
    const { post } = await harness({ ladder: true, anonAllowlist: ' 203.0.113.0/24 , 2001:db8:abcd::/48 ' });
    const ok = await post('ares', batch(500), { ip: '203.0.113.5' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-Anonymous-Quota-Limit')).toBe('500');
    const blocked = await post('cnb', call(1), { ip: '203.0.113.5' });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).message).toContain('500-call daily');
    expect((await post('ares', batch(500), { ip: '2001:db8:abcd:1::9' })).status).toBe(200);
    expect((await post('ares', batch(51), { ip: '203.0.114.5' })).status).toBe(429);
  });

  it('DD tokens are never counted by the hosted quota and identity tokens stay 401 on DD', async () => {
    const { post, store } = await harness({ ladder: true });
    const dd = store.mint({ service: 'dd', tier: 'pay-per-report', stripe_customer_id: 'dd1', stripe_subscription_id: null,
      monthly_quota: null, credits: 1 });
    for (let i = 0; i < 3; i++) expect((await post('dd', batch(100), { token: dd.token })).status).toBe(200);
    expect(store.find(dd.token)?.credits).toBe(1);
    const anon = await post('dd', call(1));
    expect(anon.headers.get('X-Anonymous-Quota-Remaining')).toBe('99');
    const identity = store.mint({ service: 'identity', tier: 'free', stripe_customer_id: 'id1', stripe_subscription_id: null,
      monthly_quota: 500, credits: null });
    expect((await post('dd', call(1), { token: identity.token })).status).toBe(401);
  });

  it('registered identity on a 500 row: header limit 500, 501st is a pricing 429', async () => {
    const { post, store } = await harness({ ladder: true });
    const identity = store.mint({ service: 'identity', tier: 'free', stripe_customer_id: 'id500', stripe_subscription_id: null,
      monthly_quota: 500, credits: null });
    const ok = await post('ares', batch(500), { token: identity.token });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-Registered-Quota-Limit')).toBe('500');
    const blocked = await post('cnb', call(1), { token: identity.token });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: 'registered_quota_exceeded' });
  });

  it('malformed HOSTED_ANON_ALLOWLIST aborts startup (ladder on); ignored when ladder is off', async () => {
    for (const bad of ['10.0.0.0/33', 'garbage', '2001:db8::/129', '10.0.0.0/8/1', '10.0.0.0/x'])
      await expect(harness({ ladder: true, anonAllowlist: `203.0.113.0/24,${bad}` })).rejects.toThrow(/HOSTED_ANON_ALLOWLIST/);
    await expect(harness({ ladder: false, anonAllowlist: 'garbage' })).resolves.toBeDefined();
  });
});
