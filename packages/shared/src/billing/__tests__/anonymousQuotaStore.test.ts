import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AnonymousQuotaStore } from '../anonymousQuotaStore.js';

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
