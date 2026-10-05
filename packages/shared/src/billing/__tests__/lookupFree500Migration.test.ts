import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TokenStore } from '../tokenStore.js';

const sql = (name: string, t0: number) =>
  readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8').replaceAll(':T0', String(t0));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it('forward changes only pre-T0 identity rows at 2000; inverse restores the exact pre-state; counters untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig500-')); dirs.push(dir);
  const path = join(dir, 'tokens.db');
  new TokenStore(path).close(); // create schema
  const db = new Database(path);
  const ins = db.prepare(`INSERT INTO tokens (token,service,tier,stripe_customer_id,monthly_quota,counter,credits,
    period_started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const T0 = 1_000_000;
  ins.run('old_id', 'identity', 'free', 'a', 2000, 123, null, 5, T0 - 1, 9);
  ins.run('new_id', 'identity', 'free', 'b', 2000, 7, null, 5, T0, 9);           // created exactly at T0: untouched
  ins.run('old_500', 'identity', 'free', 'c', 500, 4, null, 5, T0 - 5, 9);       // already 500: untouched
  ins.run('old_dd', 'dd', 'pay-per-report', 'd', null, 0, 3, 5, T0 - 1, 9);       // other service
  ins.run('old_sub', 'sanctions', 'pro', 'e', 2000, 11, null, 5, T0 - 1, 9);      // 2000 but not identity
  const snapshot = () => db.prepare('SELECT * FROM tokens ORDER BY token').all();
  const before = snapshot();

  db.exec(sql('lookup-free-500-transition.sql', T0));
  const quotas = () => Object.fromEntries((db.prepare('SELECT token,monthly_quota q FROM tokens').all() as Array<{ token: string; q: number | null }>)
    .map((r) => [r.token, r.q]));
  expect(quotas()).toEqual({ old_id: 500, new_id: 2000, old_500: 500, old_dd: null, old_sub: 2000 });
  const counters = db.prepare('SELECT token,counter,period_started_at,updated_at FROM tokens ORDER BY token').all();
  expect(counters).toEqual(before.map((r: any) => ({ token: r.token, counter: r.counter, period_started_at: r.period_started_at, updated_at: r.updated_at })));

  db.exec(sql('lookup-free-500-transition-inverse.sql', T0));
  // inverse also flips the pre-existing 500 row (documented); everything else is exactly the pre-state
  expect(quotas()).toEqual({ old_id: 2000, new_id: 2000, old_500: 2000, old_dd: null, old_sub: 2000 });
  expect(snapshot().filter((r: any) => r.token !== 'old_500')).toEqual(before.filter((r: any) => r.token !== 'old_500'));
  db.close();
});
