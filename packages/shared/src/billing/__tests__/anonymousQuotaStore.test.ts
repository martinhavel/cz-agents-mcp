import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AnonymousQuotaStore, expandIpv6 } from '../anonymousQuotaStore.js';

const dirs: string[] = [];
const stores: AnonymousQuotaStore[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'anonymous-quota-'));
  dirs.push(dir);
  const path = join(dir, 'tokens.db');
  const open = () => { const s = new AnonymousQuotaStore(path); stores.push(s); return s; };
  return { path, open };
}
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch {} }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('shares 100 calls across service connections, survives reopen, and resets at UTC midnight', () => {
  const { path, open } = setup();
  const a = open(); const b = open();
  const now = Date.parse('2026-09-06T23:59:59Z');
  for (let n = 0; n < 100; n++) {
    expect((n % 2 ? a : b).consume('192.0.2.1', now)).toEqual({
      allowed: true, remaining: 99 - n, resetAt: Date.parse('2026-09-07T00:00:00Z'),
    });
  }
  a.close(); b.close();
  const reopened = open();
  expect(reopened.consume('192.0.2.1', now).allowed).toBe(false);
  expect(reopened.consume('192.0.2.2', now).remaining).toBe(99);
  expect(reopened.consume('192.0.2.1', now + 1000).remaining).toBe(99);
  const db = new Database(path, { readonly: true });
  const rows = db.prepare('SELECT identity_hash FROM anonymous_tool_days').all();
  db.close();
  expect(JSON.stringify(rows)).not.toContain('192.0.2.');
});

it('does not allow missing identity or a closed database to become free access', () => {
  const store = setup().open();
  expect(() => store.consume('unknown')).toThrow();
  store.close();
  expect(() => store.consume('192.0.2.1')).toThrow();
});

it('accepts or refuses a batch atomically without partially spending it', () => {
  const store = setup().open();
  const now = Date.parse('2026-09-06T12:00:00Z');
  expect(store.consume('192.0.2.1', now, 60).remaining).toBe(40);
  expect(store.consume('192.0.2.1', now, 41)).toMatchObject({ allowed: false, remaining: 40 });
  expect(store.consume('192.0.2.1', now, 40)).toMatchObject({ allowed: true, remaining: 0 });
  expect(store.consume('192.0.2.2', now, 101)).toMatchObject({ allowed: false, remaining: 100 });
});

it('legacy mode stores the old HMAC(ip) key and keeps 30 days of rows', () => {
  const { path, open } = setup();
  const store = open();
  const now = Date.parse('2026-09-06T12:00:00Z');
  store.consume('192.0.2.1', now);
  const db = new Database(path, { readonly: true });
  const salt = Buffer.from((db.prepare("SELECT value FROM anonymous_quota_settings WHERE name='ip_hmac_salt'").get() as { value: string }).value, 'hex');
  const expected = createHmac('sha256', salt).update('192.0.2.1').digest('hex');
  expect(db.prepare('SELECT identity_hash h FROM anonymous_tool_days').all()).toEqual([{ h: expected }]);
  db.close();
  store.consume('192.0.2.1', now + 29 * 86_400_000);
  const after = new Database(path, { readonly: true });
  expect(after.prepare('SELECT COUNT(*) c FROM anonymous_tool_days').get()).toEqual({ c: 2 });
  after.close();
});

describe('ladder mode', () => {
  const L = { ladder: true } as const;
  const T0 = Date.parse('2026-09-06T12:00:00Z');
  const DAY = 86_400_000;

  it('allows 50 per day per IP and blocks the 51st', () => {
    const s = setup().open();
    for (let n = 0; n < 50; n++) expect(s.consume('192.0.2.1', T0, 1, L)).toMatchObject({ allowed: true, remaining: 49 - n, limit: 50 });
    expect(s.consume('192.0.2.1', T0, 1, L)).toMatchObject({ allowed: false, remaining: 0, limit: 50, scope: 'daily', resetAt: Date.parse('2026-09-07T00:00:00Z') });
  });

  it('shares 250 over 30 days across a /24, then frees it after 30 days', () => {
    const s = setup().open();
    for (let ip = 1; ip <= 5; ip++) expect(s.consume(`198.51.100.${ip}`, T0, 50, L).allowed).toBe(true);
    const blocked = s.consume('198.51.100.6', T0, 1, L);
    expect(blocked).toMatchObject({ allowed: false, limit: 250, scope: 'monthly', remaining: 0 });
    expect(blocked.resetAt).toBe((Math.floor(T0 / DAY) + 30) * DAY);
    expect(s.consume('198.51.100.6', T0 + 29 * DAY, 1, L).allowed).toBe(false);
    expect(s.consume('198.51.100.6', T0 + 30 * DAY, 1, L).allowed).toBe(true);
    expect(s.consume('198.51.101.1', T0, 1, L).allowed).toBe(true);
  });

  it('keys IPv6 by /64 and treats compressed and expanded forms alike', () => {
    const s = setup().open();
    expect(s.consume('2001:db8:0:1::1', T0, 50, L).allowed).toBe(true);
    expect(s.consume('2001:0db8:0000:0001:ffff:0:0:2', T0, 1, L).allowed).toBe(false);
    expect(s.consume('2001:db8:0:2::1', T0, 1, L).allowed).toBe(true);
    expect(expandIpv6('::1')).toEqual(['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0001']);
    expect(expandIpv6('::')).toHaveLength(8);
    expect(expandIpv6('2001:db8::')).toEqual(['2001', '0db8', '0000', '0000', '0000', '0000', '0000', '0000']);
    expect(expandIpv6('64:ff9b::192.0.2.1').slice(6)).toEqual(['c000', '0201']);
    expect(() => s.consume('not-an-ip', T0, 1, L)).toThrow();
  });

  it('allowlisted: 500/day, no 30-day cap', () => {
    const s = setup().open();
    const A = { ...L, allowlisted: true };
    expect(s.consume('203.0.113.9', T0, 500, A)).toMatchObject({ allowed: true, remaining: 0, limit: 500 });
    expect(s.consume('203.0.113.9', T0, 1, A).allowed).toBe(false);
    for (let d = 1; d <= 31; d++) expect(s.consume('203.0.113.9', T0 + d * DAY, 500, A).allowed).toBe(true);
  });

  it('dd and lookup namespaces are independent; dd is 100/day and daily-only', () => {
    const s = setup().open();
    expect(s.consume('192.0.2.1', T0, 50, L).allowed).toBe(true);
    expect(s.consume('192.0.2.1', T0, 1, L).allowed).toBe(false);
    const D = { ...L, namespace: 'dd' } as const;
    expect(s.consume('192.0.2.1', T0, 100, D)).toMatchObject({ allowed: true, remaining: 0, limit: 100 });
    expect(s.consume('192.0.2.1', T0, 1, D).allowed).toBe(false);
    for (let d = 1; d < 5; d++) expect(s.consume('192.0.2.1', T0 + d * DAY, 100, D).allowed).toBe(true);
  });

  it('ladder keys are namespaced HMACs, not raw IPs, and a rejected batch spends nothing', () => {
    const { path, open } = setup();
    const s = open();
    expect(s.consume('192.0.2.1', T0, 51, L).allowed).toBe(false);
    expect(s.consume('192.0.2.1', T0, 50, L).remaining).toBe(0);
    const db = new Database(path, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) c FROM anonymous_tool_days').get()).toEqual({ c: 2 });
    expect(JSON.stringify(db.prepare('SELECT identity_hash FROM anonymous_tool_days').all())).not.toContain('192.0.2');
    db.close();
  });
});
