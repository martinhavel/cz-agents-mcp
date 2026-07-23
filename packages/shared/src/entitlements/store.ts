import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildAliasIndex } from './country.js';
import type {
  AccountCountryOverrideRow,
  AccountEntitlementRow,
  CountryPolicy,
  CountryPolicySnapshot,
  EntitlementEventInput,
  EntitlementSource,
  UsageLimits,
  UsageMetric,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entitlement_policy_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  change_source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS country_policies (
  country_code TEXT PRIMARY KEY,
  coverage_group TEXT NOT NULL CHECK (coverage_group IN ('core','extended')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  aliases_json TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  change_source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_entitlements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  coverage_tier TEXT CHECK (coverage_tier IS NULL OR coverage_tier IN ('core','extended')),
  depth_tier TEXT CHECK (depth_tier IS NULL OR depth_tier IN ('basic','ddplus')),
  usage_limits_json TEXT NOT NULL DEFAULT '{}',
  policy_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('plan','trial','grandfathered','manual','promotion')),
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  change_source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_entitlements_active
  ON account_entitlements(account_id, valid_from, valid_until);
CREATE TABLE IF NOT EXISTS account_country_overrides (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  source TEXT NOT NULL CHECK (source IN ('plan','trial','grandfathered','manual','promotion')),
  policy_version INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  change_source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_country_overrides_active
  ON account_country_overrides(account_id, country_code, valid_from, valid_until);
CREATE TABLE IF NOT EXISTS entitlement_usage (
  account_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  period_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, metric, period_key)
);
CREATE TABLE IF NOT EXISTS entitlement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_kind TEXT NOT NULL DEFAULT 'entitlement_check',
  account_pseudonym TEXT NOT NULL,
  country TEXT,
  country_group TEXT,
  coverage_tier TEXT NOT NULL,
  depth_tier TEXT NOT NULL,
  decision TEXT NOT NULL,
  dimension TEXT NOT NULL,
  required_tier TEXT,
  policy_version INTEGER,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  would_gate INTEGER NOT NULL,
  upstream_called INTEGER NOT NULL,
  upstream_avoided INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  request_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entitlement_events_country_time
  ON entitlement_events(country, timestamp);
CREATE INDEX IF NOT EXISTS idx_entitlement_events_decision_time
  ON entitlement_events(decision, timestamp);
CREATE INDEX IF NOT EXISTS idx_entitlement_events_x402_preview
  ON entitlement_events(event_kind, account_pseudonym, request_id);
CREATE TABLE IF NOT EXISTS entitlement_policy_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  actor TEXT NOT NULL,
  change_source TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  policy_version INTEGER NOT NULL
);
`;

interface CountryRow {
  country_code: string;
  coverage_group: 'core' | 'extended';
  enabled: number;
  aliases_json: string;
  policy_version: number;
  updated_at: number;
  updated_by: string;
  change_source: string;
}

interface EntitlementRow {
  id: string;
  account_id: string;
  coverage_tier: 'core' | 'extended' | null;
  depth_tier: 'basic' | 'ddplus' | null;
  usage_limits_json: string;
  policy_version: number;
  source: EntitlementSource;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
}

interface OverrideRow {
  id: string;
  account_id: string;
  country_code: string;
  effect: 'allow' | 'deny';
  source: EntitlementSource;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
}

interface X402PreviewEventRow {
  timestamp: number;
  account_pseudonym: string;
  country: string | null;
  country_group: 'core' | 'extended' | null;
  coverage_tier: 'core' | 'extended';
  depth_tier: 'basic' | 'ddplus';
  decision: 'allowed' | 'gated' | 'invalid';
  dimension: 'coverage' | 'depth' | 'usage';
  required_tier: string | null;
  policy_version: number | null;
  source: EntitlementSource;
  mode: 'off' | 'observe' | 'enforce';
  would_gate: number;
  endpoint: string;
  request_id: string;
}

export class EntitlementStore {
  private readonly db: DatabaseType;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  loadPolicySnapshot(now = Date.now()): CountryPolicySnapshot {
    return this.db.transaction(() => {
      const meta = this.db.prepare('SELECT active_version FROM entitlement_policy_meta WHERE id = 1')
        .get() as { active_version: number } | undefined;
      if (!meta) throw new Error('POLICY_NOT_INITIALIZED');
      const rows = this.db.prepare('SELECT * FROM country_policies ORDER BY country_code').all() as CountryRow[];
      if (rows.length === 0) throw new Error('POLICY_EMPTY');
      const countries = new Map<string, CountryPolicy>();
      for (const row of rows) {
        if (row.policy_version > meta.active_version) throw new Error('POLICY_VERSION_INCONSISTENT');
        const aliases = parseStringArray(row.aliases_json, `aliases:${row.country_code}`);
        countries.set(row.country_code, {
          countryCode: row.country_code,
          coverageGroup: row.coverage_group,
          enabled: row.enabled === 1,
          aliases,
          policyVersion: row.policy_version,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by,
          changeSource: row.change_source,
        });
      }
      return {
        version: meta.active_version,
        loadedAt: now,
        countries,
        aliases: buildAliasIndex(countries),
        stale: false,
      };
    })();
  }

  getActiveEntitlements(accountId: string, now = Date.now()): AccountEntitlementRow[] {
    const rows = this.db.prepare(`
      SELECT id, account_id, coverage_tier, depth_tier, usage_limits_json,
             policy_version, source, valid_from, valid_until, created_at
      FROM account_entitlements
      WHERE account_id = ? AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)
      ORDER BY created_at ASC
    `).all(accountId, now, now) as EntitlementRow[];
    return rows.map((row) => ({
      id: row.id, accountId: row.account_id, coverageTier: row.coverage_tier,
      depthTier: row.depth_tier, usageLimits: parseUsageLimits(row.usage_limits_json),
      policyVersion: row.policy_version, source: row.source, validFrom: row.valid_from,
      validUntil: row.valid_until, createdAt: row.created_at,
    }));
  }

  getActiveCountryOverrides(accountId: string, country: string, now = Date.now()): AccountCountryOverrideRow[] {
    const rows = this.db.prepare(`
      SELECT id, account_id, country_code, effect, source, valid_from, valid_until, created_at
      FROM account_country_overrides
      WHERE account_id = ? AND country_code = ? AND valid_from <= ?
        AND (valid_until IS NULL OR valid_until > ?)
      ORDER BY created_at ASC
    `).all(accountId, country, now, now) as OverrideRow[];
    return rows.map((row) => ({ id: row.id, accountId: row.account_id,
      countryCode: row.country_code, effect: row.effect, source: row.source,
      validFrom: row.valid_from, validUntil: row.valid_until, createdAt: row.created_at }));
  }

  consumeUsage(accountId: string, metric: UsageMetric, limit: number, now = Date.now()): boolean {
    if (!Number.isInteger(limit) || limit < 0) throw new Error('INVALID_USAGE_LIMIT');
    const periodKey = usagePeriodKey(metric, now);
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO entitlement_usage(account_id,metric,period_key,counter,updated_at)
        VALUES(?,?,?,0,?) ON CONFLICT(account_id,metric,period_key) DO NOTHING`)
        .run(accountId, metric, periodKey, now);
      const result = this.db.prepare(`UPDATE entitlement_usage SET counter=counter+1,updated_at=?
        WHERE account_id=? AND metric=? AND period_key=? AND counter < ?`)
        .run(now, accountId, metric, periodKey, limit);
      return result.changes === 1;
    })();
  }

  recordEvent(event: EntitlementEventInput): void {
    this.db.prepare(`INSERT INTO entitlement_events(
      timestamp,event_kind,account_pseudonym,country,country_group,coverage_tier,depth_tier,
      decision,dimension,required_tier,policy_version,source,mode,would_gate,
      upstream_called,upstream_avoided,endpoint,request_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.timestamp ?? Date.now(), event.eventKind ?? 'entitlement_check', event.accountPseudonym,
      event.country, event.countryGroup, event.coverageTier, event.depthTier, event.decision,
      event.dimension, event.requiredTier, event.policyVersion, event.source, event.mode,
      event.wouldGate ? 1 : 0, event.upstreamCalled ? 1 : 0, event.upstreamAvoided ? 1 : 0,
      event.endpoint, event.requestId,
    );
  }

  /**
   * Records a preview intent only when it is tied to one previously offered
   * preview for the same pseudonymous account. The request id also makes this
   * idempotent, so a retry cannot inflate the experiment funnel.
   */
  recordX402PreviewIntent(accountPseudonym: string, requestId: string): boolean {
    return this.db.transaction(() => {
      const offer = this.db.prepare(`SELECT timestamp,account_pseudonym,country,country_group,
        coverage_tier,depth_tier,decision,dimension,required_tier,policy_version,source,mode,
        would_gate,endpoint,request_id FROM entitlement_events
        WHERE event_kind='x402_preview_offered' AND account_pseudonym=? AND request_id=?
        ORDER BY id DESC LIMIT 1`).get(accountPseudonym, requestId) as X402PreviewEventRow | undefined;
      if (!offer) return false;
      const existing = this.db.prepare(`SELECT 1 FROM entitlement_events
        WHERE event_kind='x402_preview_intent' AND account_pseudonym=? AND request_id=?`).get(accountPseudonym, requestId);
      if (existing) return true;
      this.recordEvent({ timestamp: Date.now(), eventKind:'x402_preview_intent',
        accountPseudonym:offer.account_pseudonym,country:offer.country,countryGroup:offer.country_group,
        coverageTier:offer.coverage_tier,depthTier:offer.depth_tier,decision:offer.decision,
        dimension:offer.dimension,requiredTier:offer.required_tier,policyVersion:offer.policy_version,
        source:offer.source,mode:offer.mode,wouldGate:offer.would_gate===1,
        upstreamCalled:false,upstreamAvoided:false,endpoint:offer.endpoint,requestId:offer.request_id });
      return true;
    })();
  }

  x402PreviewCounts(since?: number): { offered: number; intents: number } {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN event_kind='x402_preview_offered' THEN 1 ELSE 0 END) offered,
      SUM(CASE WHEN event_kind='x402_preview_intent' THEN 1 ELSE 0 END) intents
      FROM entitlement_events WHERE (? IS NULL OR timestamp >= ?)`).get(since ?? null, since ?? null) as { offered: number | null; intents: number | null };
    return { offered: row.offered ?? 0, intents: row.intents ?? 0 };
  }

  seedPolicy(actor: string, changeSource: string): number {
    const rows = initialPolicyRows();
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT active_version FROM entitlement_policy_meta WHERE id=1').get();
      if (existing) throw new Error('POLICY_ALREADY_INITIALIZED');
      const now = Date.now();
      const version = 1;
      const insert = this.db.prepare(`INSERT INTO country_policies
        (country_code,coverage_group,enabled,aliases_json,policy_version,updated_at,updated_by,change_source)
        VALUES(?,?,?,?,?,?,?,?)`);
      for (const row of rows) insert.run(row.code,row.group,row.enabled ? 1 : 0,JSON.stringify(row.aliases),version,now,actor,changeSource);
      this.db.prepare(`INSERT INTO entitlement_policy_meta(id,active_version,updated_at,change_source)
        VALUES(1,?,?,?)`).run(version,now,changeSource);
      this.db.prepare(`INSERT INTO entitlement_policy_audit(timestamp,actor,change_source,action,subject,after_json,policy_version)
        VALUES(?,?,?,?,?,?,?)`).run(now,actor,changeSource,'seed','country_policy',JSON.stringify(rows),version);
      return version;
    })();
  }

  setCountryPolicy(input: { countryCode: string; coverageGroup: 'core' | 'extended'; enabled: boolean;
    aliases: string[]; actor: string; changeSource: string }): number {
    return this.db.transaction(() => {
      const meta = this.db.prepare('SELECT active_version FROM entitlement_policy_meta WHERE id=1')
        .get() as { active_version: number } | undefined;
      if (!meta) throw new Error('POLICY_NOT_INITIALIZED');
      const before = this.db.prepare('SELECT * FROM country_policies WHERE country_code=?').get(input.countryCode);
      const version = meta.active_version + 1;
      const now = Date.now();
      this.db.prepare(`INSERT INTO country_policies(country_code,coverage_group,enabled,aliases_json,
        policy_version,updated_at,updated_by,change_source) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(country_code) DO UPDATE SET coverage_group=excluded.coverage_group,
        enabled=excluded.enabled,aliases_json=excluded.aliases_json,policy_version=excluded.policy_version,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by,change_source=excluded.change_source`)
        .run(input.countryCode,input.coverageGroup,input.enabled ? 1 : 0,JSON.stringify(input.aliases),version,now,input.actor,input.changeSource);
      this.db.prepare('UPDATE entitlement_policy_meta SET active_version=?,updated_at=?,change_source=? WHERE id=1')
        .run(version,now,input.changeSource);
      const after = this.db.prepare('SELECT * FROM country_policies WHERE country_code=?').get(input.countryCode);
      this.db.prepare(`INSERT INTO entitlement_policy_audit(timestamp,actor,change_source,action,subject,before_json,after_json,policy_version)
        VALUES(?,?,?,?,?,?,?,?)`).run(now,input.actor,input.changeSource,'set_country',input.countryCode,
          before ? JSON.stringify(before) : null,JSON.stringify(after),version);
      this.loadPolicySnapshot(now);
      return version;
    })();
  }

  putAccountEntitlement(input: { accountId: string; coverageTier?: 'core'|'extended'|null;
    depthTier?: 'basic'|'ddplus'|null; usageLimits?: UsageLimits; source: EntitlementSource;
    validFrom?: number; validUntil?: number|null; actor: string; changeSource: string }): string {
    const now = Date.now(); const id = randomUUID();
    const version = (this.db.prepare('SELECT active_version FROM entitlement_policy_meta WHERE id=1').get() as {active_version:number}|undefined)?.active_version ?? 0;
    this.db.prepare(`INSERT INTO account_entitlements(id,account_id,coverage_tier,depth_tier,usage_limits_json,
      policy_version,source,valid_from,valid_until,created_at,updated_at,updated_by,change_source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.accountId,input.coverageTier ?? null,input.depthTier ?? null,
      JSON.stringify(input.usageLimits ?? {}),version,input.source,input.validFrom ?? now,input.validUntil ?? null,
      now,now,input.actor,input.changeSource);
    return id;
  }

  putCountryOverride(input: { accountId: string; countryCode: string; effect:'allow'|'deny';
    source:EntitlementSource; validFrom?:number; validUntil?:number|null; actor:string; changeSource:string }): string {
    const now=Date.now(); const id=randomUUID();
    const version=(this.db.prepare('SELECT active_version FROM entitlement_policy_meta WHERE id=1').get() as {active_version:number}|undefined)?.active_version ?? 0;
    this.db.prepare(`INSERT INTO account_country_overrides(id,account_id,country_code,effect,source,policy_version,
      valid_from,valid_until,created_at,updated_at,updated_by,change_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,input.accountId,input.countryCode,input.effect,input.source,version,input.validFrom ?? now,
        input.validUntil ?? null,now,now,input.actor,input.changeSource);
    return id;
  }

  intentReport(since: number): Array<{country:string;unique_accounts:number;requests:number;gated:number;upgrade_ctas:number;upstream_avoided:number}> {
    return this.db.prepare(`SELECT country,
      COUNT(DISTINCT CASE WHEN event_kind='entitlement_check' THEN account_pseudonym END) unique_accounts,
      SUM(CASE WHEN event_kind='entitlement_check' THEN 1 ELSE 0 END) requests,
      SUM(CASE WHEN event_kind='entitlement_check' AND (decision='gated' OR would_gate=1) THEN 1 ELSE 0 END) gated,
      SUM(CASE WHEN event_kind='upgrade_cta' THEN 1 ELSE 0 END) upgrade_ctas,
      SUM(CASE WHEN event_kind='entitlement_check' THEN upstream_avoided ELSE 0 END) upstream_avoided FROM entitlement_events
      WHERE timestamp >= ? AND country IS NOT NULL GROUP BY country ORDER BY gated DESC,requests DESC`)
      .all(since) as Array<{country:string;unique_accounts:number;requests:number;gated:number;upgrade_ctas:number;upstream_avoided:number}>;
  }

  /**
   * Count of `upgrade_cta_fanout` events — the single representative CTA a
   * multi-country `search_company` fanout call emits (see
   * `HostedEntitlementResolver.record`'s `ctaFanout` option). These events
   * carry `country: null` by design (attributing the fanout's one CTA to
   * whichever adapter happens to be first in registration order would be a
   * measurement artifact, not demand), so `intentReport()` — which groups by
   * country and filters `country IS NOT NULL` — never sees them. Reported as
   * a sibling figure here instead of folding it into `upgrade_ctas` on any
   * country row, so the funnel is visible without contaminating per-country
   * attribution.
   */
  intentReportFanoutCtas(since: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) count FROM entitlement_events
      WHERE timestamp >= ? AND event_kind = 'upgrade_cta_fanout'`).get(since) as { count: number };
    return row.count;
  }
}

function parseStringArray(json: string, label: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`INVALID_JSON:${label}`);
  return value;
}

function parseUsageLimits(json: string): UsageLimits {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_USAGE_LIMITS');
  const allowed = new Set(['requests_per_day','extended_requests_per_month','ddplus_reports_per_month','monitoring_entities']);
  const result: UsageLimits = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key) || !Number.isInteger(raw) || (raw as number) < 0) throw new Error('INVALID_USAGE_LIMITS');
    Object.assign(result, { [key]: raw });
  }
  return result;
}

function usagePeriodKey(metric: UsageMetric, now: number): string {
  const iso = new Date(now).toISOString();
  return metric === 'requests_per_day' ? iso.slice(0,10) : iso.slice(0,7);
}

function initialPolicyRows(): Array<{code:string;group:'core'|'extended';enabled:boolean;aliases:string[]}> {
  return [
    {code:'GB',group:'core',enabled:true,aliases:['UK','United Kingdom','Great Britain']},
    {code:'CZ',group:'core',enabled:true,aliases:['Czechia','Czech Republic','Česko','Česká republika']},
    {code:'SK',group:'core',enabled:true,aliases:['Slovakia','Slovensko']},
    {code:'PL',group:'core',enabled:true,aliases:['Poland','Polsko']},
    {code:'NL',group:'core',enabled:true,aliases:['Netherlands','The Netherlands','Nizozemsko']},
    {code:'DE',group:'extended',enabled:true,aliases:['Germany','Deutschland','Německo']},
    {code:'ES',group:'extended',enabled:true,aliases:['Spain','España','Španělsko']},
    {code:'IT',group:'extended',enabled:true,aliases:['Italy','Italia','Itálie']},
    {code:'FR',group:'extended',enabled:true,aliases:['France','Francie']},
    {code:'AT',group:'extended',enabled:true,aliases:['Austria','Österreich','Rakousko']},
    {code:'DK',group:'extended',enabled:true,aliases:['Denmark','Danmark','Dánsko']},
    {code:'BE',group:'extended',enabled:false,aliases:['Belgium','België','Belgique','Belgie']},
    {code:'FI',group:'extended',enabled:true,aliases:['Finland','Suomi','Finsko']},
    {code:'LT',group:'extended',enabled:false,aliases:['Lithuania','Lietuva','Litva']},
    {code:'SE',group:'extended',enabled:true,aliases:['Sweden','Sverige','Švédsko']},
    {code:'EE',group:'extended',enabled:true,aliases:['Estonia','Eesti','Estonsko']},
    {code:'NO',group:'extended',enabled:true,aliases:['Norway','Norge','Norsko']},
  ];
}
