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
import { randomBytes, randomUUID } from 'node:crypto';
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
  {
    check: "SELECT 1 FROM pragma_table_info('tokens') WHERE name='expires_at'",
    apply: 'ALTER TABLE tokens ADD COLUMN expires_at INTEGER',
  },
];

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tokens_customer ON tokens(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_tokens_subscription ON tokens(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_tokens_session ON tokens(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_tokens_service_active ON tokens(service, revoked_at);
`;

const LOOKUP_SCHEMA = `CREATE TABLE IF NOT EXISTS lookup_purchases (
  session_id TEXT PRIMARY KEY, payment_intent_id TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL, price_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'czk'),
  subtotal INTEGER NOT NULL CHECK (subtotal = 49000),
  starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  quota INTEGER NOT NULL DEFAULT 10000 CHECK (quota = 10000),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= quota), refunded_at INTEGER,
  refund_required INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lookup_purchases_account ON lookup_purchases(account);
CREATE TABLE IF NOT EXISTS lookup_reversals (
  payment_intent_id TEXT PRIMARY KEY, reversed_at INTEGER NOT NULL,
  reason TEXT NOT NULL, manual_review INTEGER NOT NULL DEFAULT 0
);`;

const RESERVATION_SCHEMA = `CREATE TABLE IF NOT EXISTS lookup_reservations (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, identity_created_at INTEGER NOT NULL,
  period_started_at INTEGER NOT NULL, calls INTEGER NOT NULL,
  free_calls INTEGER NOT NULL, paid_allocations TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lookup_reservations_expiry ON lookup_reservations(expires_at);`;

interface LookupReservation {
  id: string; account: string; identity_created_at: number; period_started_at: number;
  calls: number; free_calls: number; paid_allocations: string; expires_at: number;
}
export const LOOKUP_RESERVATION_MS = 120_000;

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
    this.db.exec(LOOKUP_SCHEMA);
    this.db.exec(RESERVATION_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Registered lookup quota only; leaves existing paid/report consumption unchanged. */
  consumeIdentity(token: string, calls: number): TokenRecord & { lookupRemaining: number; lookupLimit: number } {
    return this.allocateIdentity(token, calls);
  }

  /** Hold capacity before starting handlers, shared atomically across processes. */
  reserveIdentity(token: string, calls: number) {
    const id = randomUUID();
    const expiresAt = Date.now() + LOOKUP_RESERVATION_MS;
    const snapshot = this.allocateIdentity(token, calls, { id, expiresAt });
    return { id, expiresAt, snapshot };
  }

  private allocateIdentity(token: string, calls: number, reservation?: { id: string; expiresAt: number }):
    TokenRecord & { lookupRemaining: number; lookupLimit: number } {
    if (!Number.isSafeInteger(calls) || calls < 1) throw new Error('INVALID_CALL_COUNT');
    return this.db.transaction(() => {
      const expired = this.db.prepare('SELECT id FROM lookup_reservations WHERE expires_at<=? LIMIT 1000')
        .all(Date.now()) as Array<{ id: string }>;
      for (const row of expired) this.settleReservation(row.id, 0);
      const record = this.find(token);
      if (!record || record.service !== 'identity' || record.tier !== 'free'
        || record.monthly_quota !== 2000 || record.credits !== null) throw new Error('TOKEN_NOT_FOUND');
      const now = Date.now();
      if (record.expires_at != null && now > record.expires_at) throw new Error('TRIAL_EXPIRED');
      if (now - record.period_started_at >= ONE_MONTH_MS) {
        this.db.prepare('UPDATE tokens SET counter = 0, period_started_at = ?, updated_at = ? WHERE token = ?')
          .run(now, now, token);
      }
      const current = this.find(token)!;
      const freeCalls = Math.min(calls, Math.max(0, 2000 - current.counter));
      const paid = this.db.prepare(`SELECT session_id,quota,used FROM lookup_purchases
        WHERE account=? AND refunded_at IS NULL AND refund_required=0 AND starts_at<=? AND expires_at>?
        ORDER BY expires_at,session_id`).all(record.stripe_customer_id, now, now) as
        Array<{ session_id: string; quota: number; used: number }>;
      const available = paid.reduce((sum, row) => sum + row.quota - row.used, 0);
      if (calls - freeCalls > available) throw new Error('QUOTA_EXCEEDED');
      this.db.prepare('UPDATE tokens SET counter=counter+?,updated_at=? WHERE token=?').run(freeCalls, now, token);
      let needed = calls - freeCalls;
      const allocations: Array<{ sessionId: string; calls: number }> = [];
      for (const row of paid) {
        const used = Math.min(needed, row.quota - row.used);
        if (used) this.db.prepare('UPDATE lookup_purchases SET used=used+? WHERE session_id=?').run(used, row.session_id);
        if (used) allocations.push({ sessionId: row.session_id, calls: used });
        needed -= used;
      }
      if (reservation) this.db.prepare(`INSERT INTO lookup_reservations
        (id,account,identity_created_at,period_started_at,calls,free_calls,paid_allocations,expires_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(reservation.id, current.stripe_customer_id, current.created_at,
          current.period_started_at, calls, freeCalls, JSON.stringify(allocations), reservation.expiresAt);
      return { ...this.find(token)!, lookupRemaining: 2000 - current.counter - freeCalls + available - (calls - freeCalls),
        lookupLimit: 2000 + paid.reduce((sum, row) => sum + row.quota, 0) };
    }).immediate();
  }

  /** Delete and release in one transaction: duplicate completion cannot refund twice. */
  settleIdentityReservation(id: string, successfulCalls: number) {
    return this.db.transaction(() => this.settleReservation(id, successfulCalls)).immediate();
  }

  private settleReservation(id: string, successfulCalls: number) {
    const row = this.db.prepare('SELECT * FROM lookup_reservations WHERE id=?').get(id) as LookupReservation | undefined;
    if (!row) return null;
    if (!Number.isSafeInteger(successfulCalls) || successfulCalls < 0 || successfulCalls > row.calls)
      throw new Error('INVALID_CALL_COUNT');
    const expired = Date.now() >= row.expires_at;
    let release = row.calls - (expired ? 0 : successfulCalls);
    const paid = JSON.parse(row.paid_allocations) as Array<{ sessionId: string; calls: number }>;
    // Undo from the end so successful calls still consume free before paid.
    for (const allocation of paid.reverse()) {
      const amount = Math.min(release, allocation.calls);
      if (amount) this.db.prepare('UPDATE lookup_purchases SET used=MAX(0,used-?) WHERE session_id=?')
        .run(amount, allocation.sessionId);
      release -= amount;
    }
    if (release) this.db.prepare(`UPDATE tokens SET counter=MAX(0,counter-?),updated_at=?
      WHERE service='identity' AND stripe_customer_id=? AND created_at=? AND period_started_at=?`)
      .run(release, Date.now(), row.account, row.identity_created_at, row.period_started_at);
    this.db.prepare('DELETE FROM lookup_reservations WHERE id=?').run(id);
    const identity = this.db.prepare("SELECT * FROM tokens WHERE service='identity' AND stripe_customer_id=?")
      .get(row.account) as TokenRecord | undefined;
    if (!identity) throw new Error('TOKEN_NOT_FOUND');
    const now = Date.now();
    const paidBalance = this.db.prepare(`SELECT COALESCE(SUM(quota-used),0) AS remaining, COALESCE(SUM(quota),0) AS quota
      FROM lookup_purchases WHERE account=? AND refunded_at IS NULL AND refund_required=0 AND starts_at<=? AND expires_at>?`)
      .get(row.account, now, now) as { remaining: number; quota: number };
    const rolled = now - identity.period_started_at >= ONE_MONTH_MS;
    return { expired, snapshot: { ...identity,
      period_started_at: rolled ? now : identity.period_started_at,
      lookupRemaining: (rolled ? 2000 : Math.max(0, 2000 - identity.counter)) + paidBalance.remaining,
      lookupLimit: 2000 + paidBalance.quota } };
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
    expires_at?: number | null;
  }): TokenRecord {
    const token = generateToken();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO tokens (token, service, tier, stripe_customer_id, stripe_subscription_id,
                          stripe_session_id, monthly_quota, counter, credits,
                          period_started_at, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
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
      input.expires_at ?? null,
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

      if (record.expires_at != null && now > record.expires_at) {
        throw new Error('TRIAL_EXPIRED');
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
