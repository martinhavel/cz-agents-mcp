/**
 * SQLite-backed token store. Single file, embedded — no external deps in
 * production. Each service (sanctions, dd) opens its own DB or shares one;
 * the `service` column keeps rows distinct.
 *
 * Atomic counter increments via `UPDATE ... SET counter = counter + 1`.
 * Period rollover handled at lookup time (lazy, no cron required).
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ServiceKind, Tier, TokenRecord } from './types.js';

// Two-phase init so ALTER TABLE migrations run before any index that
// references a newly-added column:
//   1) CREATE_TABLE — base table only
//   2) MIGRATIONS — add columns absent on legacy DBs
//   3) CREATE_INDEXES — indexes (may reference migrated columns)
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS tokens (
  token                  TEXT PRIMARY KEY,
  service                TEXT NOT NULL,
  tier                   TEXT NOT NULL,
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT,
  stripe_session_id      TEXT,
  monthly_quota          INTEGER,
  counter                INTEGER NOT NULL DEFAULT 0,
  credits                INTEGER,
  period_started_at      INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  revoked_at             INTEGER
);
`;

const MIGRATIONS: Array<{ check: string; apply: string }> = [
  {
    check: "SELECT 1 FROM pragma_table_info('tokens') WHERE name='stripe_session_id'",
    apply: 'ALTER TABLE tokens ADD COLUMN stripe_session_id TEXT',
  },
];

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tokens_customer ON tokens(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_tokens_subscription ON tokens(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_tokens_session ON tokens(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_tokens_service_active ON tokens(service, revoked_at);
`;

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export class TokenStore {
  private readonly db: DatabaseType;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(CREATE_TABLE);
    for (const m of MIGRATIONS) {
      const present = this.db.prepare(m.check).get();
      if (!present) this.db.exec(m.apply);
    }
    this.db.exec(CREATE_INDEXES);
  }

  close(): void {
    this.db.close();
  }

  /** Mint a new token. Caller passes Stripe customer + subscription + tier resolved from price_id. */
  mint(input: {
    service: ServiceKind;
    tier: Tier['kind'];
    stripe_customer_id: string;
    stripe_subscription_id: string | null;
    stripe_session_id?: string | null;
    monthly_quota: number | null;
    credits: number | null;
  }): TokenRecord {
    const token = generateToken();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO tokens (token, service, tier, stripe_customer_id, stripe_subscription_id,
                          stripe_session_id, monthly_quota, counter, credits,
                          period_started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      token,
      input.service,
      input.tier,
      input.stripe_customer_id,
      input.stripe_subscription_id,
      input.stripe_session_id ?? null,
      input.monthly_quota,
      input.credits,
      now,
      now,
      now,
    );
    return this.find(token)!;
  }

  /**
   * One-shot lookup by Stripe Checkout session_id. Returns the token once,
   * then clears the session_id mapping so a leaked session_id can't be
   * replayed later. Returns null if unknown / already retrieved.
   */
  retrieveBySession(stripe_session_id: string): TokenRecord | null {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare<[string], TokenRecord>(
          'SELECT * FROM tokens WHERE stripe_session_id = ? AND revoked_at IS NULL',
        )
        .get(stripe_session_id);
      if (!row) return null;
      this.db
        .prepare('UPDATE tokens SET stripe_session_id = NULL, updated_at = ? WHERE token = ?')
        .run(Date.now(), row.token);
      return row;
    });
    return tx();
  }

  /** Look up a token by its opaque secret. Returns null for unknown or revoked. */
  find(token: string): TokenRecord | null {
    const row = this.db
      .prepare<[string], TokenRecord>('SELECT * FROM tokens WHERE token = ? AND revoked_at IS NULL')
      .get(token);
    return row ?? null;
  }

  /**
   * Increment counter / decrement credits atomically. Returns the post-update record.
   * Also rolls the counter period over if a month has passed since `period_started_at`.
   * Throws if no rows updated (unknown token, revoked, or pay-per-report exhausted).
   */
  consume(token: string): TokenRecord {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      const record = this.find(token);
      if (!record) {
        throw new Error('TOKEN_NOT_FOUND');
      }

      // Rollover monthly counter for subscriptions
      if (record.monthly_quota !== null && now - record.period_started_at >= ONE_MONTH_MS) {
        this.db.prepare(
          'UPDATE tokens SET counter = 0, period_started_at = ?, updated_at = ? WHERE token = ?',
        ).run(now, now, token);
        record.counter = 0;
        record.period_started_at = now;
      }

      // Pay-per-report: decrement credits, refuse if none left
      if (record.credits !== null) {
        if (record.credits <= 0) throw new Error('CREDITS_EXHAUSTED');
        this.db.prepare(
          'UPDATE tokens SET credits = credits - 1, counter = counter + 1, updated_at = ? WHERE token = ? AND credits > 0',
        ).run(now, token);
      } else if (record.monthly_quota !== null) {
        if (record.counter >= record.monthly_quota) throw new Error('QUOTA_EXCEEDED');
        this.db.prepare(
          'UPDATE tokens SET counter = counter + 1, updated_at = ? WHERE token = ?',
        ).run(now, token);
      } else {
        // No quota and no credits — token shouldn't exist, but treat as free
        this.db.prepare('UPDATE tokens SET counter = counter + 1, updated_at = ? WHERE token = ?').run(now, token);
      }

      return this.find(token)!;
    });

    return tx();
  }

  /** Mark token revoked (soft delete). Used when subscription cancelled. */
  revoke(token: string): void {
    this.db.prepare('UPDATE tokens SET revoked_at = ?, updated_at = ? WHERE token = ?').run(Date.now(), Date.now(), token);
  }

  /** Revoke all tokens for a subscription (e.g. on subscription.deleted webhook). */
  revokeBySubscription(stripe_subscription_id: string): number {
    const result = this.db.prepare(
      'UPDATE tokens SET revoked_at = ?, updated_at = ? WHERE stripe_subscription_id = ? AND revoked_at IS NULL',
    ).run(Date.now(), Date.now(), stripe_subscription_id);
    return result.changes;
  }

  /** Find existing token for a subscription (used when invoice.paid renews and we want to reset counter). */
  findBySubscription(stripe_subscription_id: string): TokenRecord | null {
    const row = this.db
      .prepare<[string], TokenRecord>(
        'SELECT * FROM tokens WHERE stripe_subscription_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get(stripe_subscription_id);
    return row ?? null;
  }

  /** Reset counter (called on invoice.paid for recurring subs). */
  resetCounter(token: string): void {
    const now = Date.now();
    this.db.prepare(
      'UPDATE tokens SET counter = 0, period_started_at = ?, updated_at = ? WHERE token = ?',
    ).run(now, now, token);
  }

  /** Top up credits for pay-per-report (called on additional one-time purchase). */
  topUpCredits(token: string, amount: number): void {
    if (amount <= 0) return;
    this.db.prepare(
      'UPDATE tokens SET credits = COALESCE(credits, 0) + ?, updated_at = ? WHERE token = ?',
    ).run(amount, Date.now(), token);
  }

  /** Stats for /health endpoint. */
  stats(service: ServiceKind): { active: number; revoked: number; by_tier: Record<string, number> } {
    const active = (this.db.prepare(
      'SELECT COUNT(*) AS c FROM tokens WHERE service = ? AND revoked_at IS NULL',
    ).get(service) as { c: number }).c;
    const revoked = (this.db.prepare(
      'SELECT COUNT(*) AS c FROM tokens WHERE service = ? AND revoked_at IS NOT NULL',
    ).get(service) as { c: number }).c;
    const byTier = this.db
      .prepare<[ServiceKind], { tier: string; c: number }>(
        'SELECT tier, COUNT(*) AS c FROM tokens WHERE service = ? AND revoked_at IS NULL GROUP BY tier',
      )
      .all(service);
    return {
      active,
      revoked,
      by_tier: Object.fromEntries(byTier.map((r) => [r.tier, r.c])),
    };
  }
}

function generateToken(): string {
  // 32 bytes of entropy, base64url-encoded → 43 char opaque secret
  return 'czat_' + randomBytes(32).toString('base64url');
}
