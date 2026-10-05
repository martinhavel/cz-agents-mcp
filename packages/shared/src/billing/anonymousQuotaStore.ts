import Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';

export const ANONYMOUS_DAILY_TOOL_LIMIT = 100;
/** HOSTED_QUOTA_LADDER limits. */
export const LADDER_LOOKUP_DAILY_LIMIT = 50;
export const LADDER_LOOKUP_30_DAY_LIMIT = 250;
export const LADDER_ALLOWLISTED_DAILY_LIMIT = 500;
export const LADDER_DD_DAILY_LIMIT = 100;
const DAY_MS = 86_400_000;

export interface AnonymousConsumeOptions {
  namespace?: 'lookup' | 'dd';
  /** Off (default) = legacy single-bucket behaviour, byte-identical key HMAC(ip). */
  ladder?: boolean;
  allowlisted?: boolean;
}
export interface AnonymousConsumeResult {
  allowed: boolean; remaining: number; resetAt: number;
  /** Ladder mode only: limit and window of the bucket that is binding (the one hit when blocked). */
  limit?: number; scope?: 'daily' | 'monthly';
}

/** Expand an IPv6 address (any `::` compression, optional dotted tail) to 8 hex groups. */
export function expandIpv6(ip: string): string[] {
  let addr = ip.split('%')[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr)?.[1];
  if (dotted) {
    const o = dotted.split('.').map(Number);
    addr = addr.slice(0, -dotted.length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [head, tail, extra] = addr.split('::');
  if (extra !== undefined) throw new Error('Anonymous quota identity unavailable');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(Math.max(0, fill)).fill('0'), ...t];
  if (groups.length !== 8) throw new Error('Anonymous quota identity unavailable');
  return groups.map((g) => g.padStart(4, '0'));
}

/** Daily bucket = exact IPv4 | IPv6 /64; 30-day bucket = IPv4 /24 | IPv6 /64. */
function ladderPrefixes(ip: string): { daily: string; monthly: string } {
  const family = isIP(ip.split('%')[0]!);
  if (family === 4) return { daily: ip, monthly: ip.split('.').slice(0, 3).join('.') };
  if (family === 6) { const p = expandIpv6(ip).slice(0, 4).join(':'); return { daily: p, monthly: p }; }
  throw new Error('Anonymous quota identity unavailable');
}

/** One shared database across hosted services; never keyed by service or session. */
export class AnonymousQuotaStore {
  private readonly db: Database.Database;
  private readonly salt: Buffer;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS anonymous_quota_settings (
          name TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS anonymous_tool_days (
          identity_hash TEXT NOT NULL,
          utc_day INTEGER NOT NULL,
          used INTEGER NOT NULL CHECK (used >= 0),
          PRIMARY KEY (identity_hash, utc_day)
        );
      `);
      this.db.prepare('INSERT OR IGNORE INTO anonymous_quota_settings VALUES (?, ?)')
        .run('ip_hmac_salt', randomBytes(32).toString('hex'));
      const row = this.db.prepare('SELECT value FROM anonymous_quota_settings WHERE name = ?')
        .get('ip_hmac_salt') as { value: string };
      if (!/^[a-f0-9]{64}$/.test(row.value)) throw new Error('Invalid anonymous quota configuration');
      this.salt = Buffer.from(row.value, 'hex');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private key(value: string): string {
    return createHmac('sha256', this.salt).update(value).digest('hex');
  }

  /** Consume one accepted tool-call attempt, before executing its handler. */
  consume(ip: string, now = Date.now(), calls = 1, options: AnonymousConsumeOptions = {}): AnonymousConsumeResult {
    if (!ip || ip === 'unknown' || !Number.isFinite(now)) throw new Error('Anonymous quota identity unavailable');
    if (!Number.isSafeInteger(calls) || calls < 1) throw new Error('Invalid tool-call count');
    const day = Math.floor(now / DAY_MS);
    if (options.ladder) return this.consumeLadder(ip, day, calls, options);
    const key = this.key(ip);
    const result = this.db.prepare(`
      INSERT INTO anonymous_tool_days (identity_hash, utc_day, used)
      SELECT ?, ?, ? WHERE ? <= ?
      ON CONFLICT (identity_hash, utc_day) DO UPDATE SET used = used + excluded.used
      WHERE used + excluded.used <= ?
      RETURNING used
    `).get(key, day, calls, calls, ANONYMOUS_DAILY_TOOL_LIMIT, ANONYMOUS_DAILY_TOOL_LIMIT) as { used: number } | undefined;
    const used = result?.used ?? (this.db.prepare(
      'SELECT used FROM anonymous_tool_days WHERE identity_hash = ? AND utc_day = ?',
    ).get(key, day) as { used: number } | undefined)?.used ?? 0;
    this.prune(day);
    return {
      allowed: result !== undefined,
      remaining: ANONYMOUS_DAILY_TOOL_LIMIT - used,
      resetAt: (day + 1) * DAY_MS,
    };
  }

  /** 30 days kept in both modes (legacy only ever reads today). */
  private prune(day: number) {
    this.db.prepare('DELETE FROM anonymous_tool_days WHERE utc_day < ?').run(day - 30);
  }

  private consumeLadder(ip: string, day: number, calls: number, o: AnonymousConsumeOptions): AnonymousConsumeResult {
    const ns = o.namespace ?? 'lookup';
    const prefix = ladderPrefixes(ip);
    const dailyLimit = ns === 'dd' ? LADDER_DD_DAILY_LIMIT : o.allowlisted ? LADDER_ALLOWLISTED_DAILY_LIMIT : LADDER_LOOKUP_DAILY_LIMIT;
    const dKey = this.key(`${ns}:d:${prefix.daily}`);
    const monthly = ns === 'lookup' && !o.allowlisted;
    const mKey = monthly ? this.key(`lookup:m:${prefix.monthly}`) : null;
    const tomorrow = (day + 1) * DAY_MS;
    return this.db.transaction((): AnonymousConsumeResult => {
      const dUsed = (this.db.prepare('SELECT used FROM anonymous_tool_days WHERE identity_hash=? AND utc_day=?')
        .get(dKey, day) as { used: number } | undefined)?.used ?? 0;
      let mUsed = 0; let oldest = day;
      if (mKey) {
        const m = this.db.prepare(`SELECT COALESCE(SUM(used),0) AS used, MIN(utc_day) AS oldest
          FROM anonymous_tool_days WHERE identity_hash=? AND utc_day>? AND utc_day<=?`)
          .get(mKey, day - 30, day) as { used: number; oldest: number | null };
        mUsed = m.used; oldest = m.oldest ?? day;
      }
      const daily = (used: number) => ({ remaining: dailyLimit - used, limit: dailyLimit, scope: 'daily' as const, resetAt: tomorrow });
      const month = (used: number) => ({ remaining: LADDER_LOOKUP_30_DAY_LIMIT - used, limit: LADDER_LOOKUP_30_DAY_LIMIT,
        scope: 'monthly' as const, resetAt: (oldest + 30) * DAY_MS });
      if (dUsed + calls > dailyLimit) return { allowed: false, ...daily(dUsed) };
      if (mKey && mUsed + calls > LADDER_LOOKUP_30_DAY_LIMIT) return { allowed: false, ...month(mUsed) };
      const bump = this.db.prepare(`INSERT INTO anonymous_tool_days (identity_hash, utc_day, used) VALUES (?,?,?)
        ON CONFLICT (identity_hash, utc_day) DO UPDATE SET used = used + excluded.used`);
      bump.run(dKey, day, calls);
      if (mKey) bump.run(mKey, day, calls);
      this.prune(day);
      const d = daily(dUsed + calls);
      if (!mKey) return { allowed: true, ...d };
      const m = month(mUsed + calls);
      return { allowed: true, ...(m.remaining < d.remaining ? m : d) };
    }).immediate();
  }

  close(): void { this.db.close(); }
}
