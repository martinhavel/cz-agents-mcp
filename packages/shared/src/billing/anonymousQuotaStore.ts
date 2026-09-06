import Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ANONYMOUS_DAILY_TOOL_LIMIT = 100;
const DAY_MS = 86_400_000;

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

  /** Consume one accepted tool-call attempt, before executing its handler. */
  consume(ip: string, now = Date.now(), calls = 1): { allowed: boolean; remaining: number; resetAt: number } {
    if (!ip || ip === 'unknown' || !Number.isFinite(now)) throw new Error('Anonymous quota identity unavailable');
    if (!Number.isSafeInteger(calls) || calls < 1) throw new Error('Invalid tool-call count');
    const day = Math.floor(now / DAY_MS);
    const key = createHmac('sha256', this.salt).update(ip).digest('hex');
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
    this.db.prepare('DELETE FROM anonymous_tool_days WHERE utc_day < ?').run(day - 1);
    return {
      allowed: result !== undefined,
      remaining: ANONYMOUS_DAILY_TOOL_LIMIT - used,
      resetAt: (day + 1) * DAY_MS,
    };
  }

  close(): void { this.db.close(); }
}
