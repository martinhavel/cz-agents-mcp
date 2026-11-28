import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TokenStore } from '../../../shared/src/billing/tokenStore.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('loopback_port_unavailable');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForAnonymousChallenge(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 401) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`dd_http_not_ready:${lastError instanceof Error ? lastError.name : 'unknown'}`);
}

async function stop(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit');
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  if (!stopped()) child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 1_000)),
  ]);
  if (!stopped()) {
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1_000))]);
  }
}

// Regression guard for a production artifact found 2026-07-21: the REST
// entitlement self-check endpoint (`rest:entitlement_check`) called
// entitlementResolver.record(decision, false) unconditionally, before any
// upstreamAllowed check. record() emits an `upgrade_cta` event whenever
// upstreamCalled is false and the decision is tier_required — so every probe
// against this endpoint silently inflated the upgrade_cta counter. Verified on
// prod: all 4 existing upgrade_cta events came from this endpoint, none from a
// real user. http.ts isn't otherwise unit-tested (no HTTP harness in this
// package, see server-pricing-url.test.ts for the same source-read pattern),
// so this asserts the fix — record() called with {isProbe:true} — stays in
// place at the call site rather than re-testing HostedEntitlementResolver
// itself (covered in packages/shared/src/entitlements/__tests__/resolver.test.ts).
describe('DD REST entitlement-check probe', () => {
  it('records via the isProbe flag so it never counts as an upgrade_cta', () => {
    const source = readFileSync(new URL('../http.ts', import.meta.url), 'utf8');
    const marker = "endpoint:'rest:entitlement_check'";
    const markerIndex = source.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(-1);
    const nearby = source.slice(markerIndex, markerIndex + 400);
    expect(nearby).toMatch(/entitlementResolver\.record\(decision,\s*false,\s*\{\s*isProbe:\s*true\s*\}\)/);
  });

  it('returns the expired-token challenge for sessionless GET and POST before any tool work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'czat-dd-expired-'));
    const dbPath = join(directory, 'tokens.db');
    const store = new TokenStore(dbPath);
    const expired = store.mint({
      service: 'dd', tier: 'pro', stripe_customer_id: 'synthetic', stripe_subscription_id: 'synthetic',
      monthly_quota: 10, credits: null, expires_at: Date.now() - 1_000,
    });
    const counterBefore = store.find(expired.token)?.counter;
    store.close();

    const port = await freeLoopbackPort();
    const child = spawn(process.execPath, ['packages/dd/dist/http.js'], {
      cwd: REPOSITORY_ROOT,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', PORT: String(port), TOKEN_DB: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.resume();
    child.stderr?.resume();

    const endpoint = `http://127.0.0.1:${port}/mcp`;
    try {
      const anonymous = await waitForAnonymousChallenge(endpoint);
      expect(await anonymous.json()).toMatchObject({ error: 'authorization_required' });
      expect(anonymous.headers.get('www-authenticate')).toContain('resource_metadata=');

      const headers = { authorization: `Bearer ${expired.token}`, origin: 'https://claude.ai' };
      const get = await fetch(endpoint, { headers });
      const post = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });

      for (const response of [get, post]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: 'invalid_token' });
        expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate');
      }
    } finally {
      await stop(child);
      const after = new TokenStore(dbPath);
      try {
        expect(after.find(expired.token)?.counter).toBe(counterBefore);
      } finally {
        after.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
