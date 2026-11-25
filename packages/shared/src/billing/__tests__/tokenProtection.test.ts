import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { TokenStore } from '../tokenStore.js';
import { protectToken } from '../tokenProtection.js';

describe('F1 expand and dual write', () => {
  let dir: string;
  let store: TokenStore | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'token-f1-'));
    vi.stubEnv('CZ_AGENTS_TOKEN_F1', '1');
    vi.stubEnv('CZ_AGENTS_TOKEN_HMAC_PEPPER', Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('CZ_AGENTS_TOKEN_HMAC_KEY_ID', 'fixture-v1');
  });
  afterEach(() => { store?.close(); store = undefined; rmSync(dir, { recursive: true }); vi.unstubAllEnvs(); });

  it('rejects incomplete enabled startup before creating the token database', () => {
    const settings = {
      CZ_AGENTS_TOKEN_HMAC_PEPPER: Buffer.alloc(32, 7).toString('base64'),
      CZ_AGENTS_TOKEN_HMAC_KEY_ID: 'fixture-v1',
    };
    const path = join(dir, 'fresh', 'tokens.db');
    const valid = () => {
      vi.stubEnv('CZ_AGENTS_TOKEN_F1', '1');
      for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
    };
    for (const name of Object.keys(settings)) {
      for (const value of ['', '!invalid!']) {
        valid(); vi.stubEnv(name, value);
        expect(() => new TokenStore(path)).toThrow('TOKEN_F1_CONFIGURATION');
        expect(existsSync(join(dir, 'fresh'))).toBe(false);
      }
    }
    valid(); vi.stubEnv('CZ_AGENTS_TOKEN_F1', 'invalid');
    expect(() => new TokenStore(path)).toThrow('TOKEN_F1_CONFIGURATION');
    expect(existsSync(join(dir, 'fresh'))).toBe(false);
    for (const flag of [undefined, '0']) {
      vi.stubEnv('CZ_AGENTS_TOKEN_F1', flag);
      for (const name of Object.keys(settings)) vi.stubEnv(name, '');
      new TokenStore(path).close();
    }
    valid();
    vi.stubEnv('CZ_AGENTS_TOKEN_ESCROW_KEY', '');
    vi.stubEnv('CZ_AGENTS_TOKEN_ESCROW_KEY_ID', '');
    new TokenStore(path).close(); // MCP must never require the webapp-only escrow key.
  });

  it('expands a legacy database without changing its bearer, metadata or raw-reader contract', () => {
    const path = join(dir, 'tokens.db');
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE tokens (token TEXT PRIMARY KEY,service TEXT NOT NULL,tier TEXT NOT NULL,
      stripe_customer_id TEXT NOT NULL,stripe_subscription_id TEXT,monthly_quota INTEGER,
      counter INTEGER NOT NULL DEFAULT 0,credits INTEGER,period_started_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revoked_at INTEGER);
      INSERT INTO tokens VALUES ('czat_legacy','sanctions','pro','fixture',NULL,100,7,NULL,1,2,3,NULL)`);
    legacy.close();
    store = new TokenStore(path);
    expect(store.find('czat_legacy')).toMatchObject({ token: 'czat_legacy', counter: 7, created_at: 2 });
    expect(protectToken('czat_legacy', 'sanctions').token_prefix).toBe('');
    const minted = store.mint({ service: 'identity', tier: 'free', stripe_customer_id: 'identity_fixture',
      stripe_subscription_id: null, monthly_quota: 2000, credits: null });
    const reader = new Database(path);
    try {
      const row = reader.prepare('SELECT * FROM tokens WHERE token=?').get(minted.token) as Record<string, unknown>;
      expect(row.token_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.token_hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(row.hmac_key_id).toBe('fixture-v1');
      expect(row.token_prefix).toBe(minted.token.slice(0, 12));
      expect(row.outbound_ct).toBeNull();
      expect(store.find(row.token_hmac as string)).toBeNull();
      expect(store.consumeIdentity(minted.token, 1).counter).toBe(1);
      expect(store.find('czat_legacy')?.counter).toBe(7);
    } finally { reader.close(); }
  });

  it('refuses a missing pepper without insertion and preserves the existing MCP mint contract', () => {
    store = new TokenStore(join(dir, 'tokens.db'));
    const identity = { service: 'identity' as const, tier: 'free' as const,
      stripe_customer_id: 'identity_fixture', stripe_subscription_id: null, monthly_quota: 2000, credits: null };
    vi.stubEnv('CZ_AGENTS_TOKEN_HMAC_PEPPER', '');
    expect(() => store!.mint(identity)).toThrow('TOKEN_PROTECTION_KEY_REQUIRED');
    expect(store.stats('identity').active).toBe(0);
    vi.stubEnv('CZ_AGENTS_TOKEN_HMAC_PEPPER', Buffer.alloc(32, 7).toString('base64'));
    const minted = store.mint({ ...identity, service: 'dd' });
    expect(store.find(minted.token)?.service).toBe('dd');
    expect(store.stats('dd').active).toBe(1);
  });
});
