import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeCountry } from '../country.js';
import { HostedEntitlementResolver, accountContextFromToken, DDPLUS_CAPABILITIES } from '../resolver.js';
import { EntitlementStore, applyMigration } from '../store.js';
import type { HostedAccountContext } from '../types.js';
import type { TokenRecord } from '../../billing/types.js';

describe('hosted entitlement resolver', () => {
  let dir:string; let store:EntitlementStore;
  beforeEach(()=>{ dir=mkdtempSync(join(tmpdir(),'entitlements-'));store=new EntitlementStore(join(dir,'tokens.db'));store.seedPolicy('test','unit'); });
  afterEach(()=>{store.close();rmSync(dir,{recursive:true,force:true});});

  const core=():HostedAccountContext=>accountContextFromToken(null,'free-client','test-salt');
  const extended=():HostedAccountContext=>({...core(),accountId:'acct_paid',planCoverageTier:'extended',planDepthTier:'ddplus'});
  const check=(resolver:HostedEntitlementResolver,account:HostedAccountContext,country:string,requestedDepth:'basic'|'ddplus'='basic')=>
    resolver.check({account,country,requestedDepth,endpoint:'mcp:get_company',requestId:'req-1'});

  it('allows Core country for Core account and gates Extended',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test/upgrade',cacheTtlMs:0});
    expect(check(resolver,core(),'CZ').decision).toBe('allowed');
    const de=check(resolver,core(),'DE');
    expect(de).toMatchObject({decision:'gated',dimension:'coverage',requiredTier:'extended',upstreamAllowed:false,country:'DE'});
    expect(de.error).toMatchObject({error:'tier_required',country:'DE',country_group:'extended'});
  });

  it('allows Extended country for Extended account',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    expect(check(resolver,extended(),'DE')).toMatchObject({decision:'allowed',upstreamAllowed:true});
  });

  it('classifies implemented EE and NO connectors as enabled Extended coverage',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    for (const country of ['EE','NO']) {
      expect(check(resolver,core(),country)).toMatchObject({
        decision:'gated',countryGroup:'extended',requiredTier:'extended',upstreamAllowed:false,
      });
      expect(check(resolver,extended(),country)).toMatchObject({
        decision:'allowed',countryGroup:'extended',upstreamAllowed:true,
      });
    }
  });

  it('maps paid Compliance and Agency plan tokens to Extended plus DD+',()=>{
    for (const tier of ['pro','agency'] as const) {
      const token:TokenRecord={token:`token-${tier}`,service:'dd',tier,stripe_customer_id:`cus-${tier}`,
        stripe_subscription_id:`sub-${tier}`,monthly_quota:100,counter:0,credits:null,
        period_started_at:Date.now(),created_at:Date.now(),updated_at:Date.now(),revoked_at:null};
      expect(accountContextFromToken(token,'unused','test-salt')).toMatchObject({
        accountId:`cus-${tier}`,planCoverageTier:'extended',planDepthTier:'ddplus',source:'plan',
      });
    }
  });

  it('keeps coverage and depth independent',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    expect(check(resolver,core(),'CZ','basic').decision).toBe('allowed');
    expect(check(resolver,core(),'CZ','ddplus')).toMatchObject({decision:'gated',dimension:'depth',requiredTier:'ddplus'});
    expect(check(resolver,extended(),'CZ','ddplus').decision).toBe('allowed');
  });

  it('supports account allow and deny country overrides',()=>{
    const account=core();
    store.putCountryOverride({accountId:account.accountId,countryCode:'DE',effect:'allow',source:'promotion',actor:'test',changeSource:'unit'});
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    expect(check(resolver,account,'DE').decision).toBe('allowed');
    store.putCountryOverride({accountId:account.accountId,countryCode:'DE',effect:'deny',source:'manual',actor:'test',changeSource:'unit'});
    expect(check(resolver,account,'DE')).toMatchObject({decision:'gated',upstreamAllowed:false});
  });

  it('ignores expired overrides and resolves grandfathered entitlement',()=>{
    const account=core(); const past=Date.now()-10_000;
    store.putCountryOverride({accountId:account.accountId,countryCode:'DE',effect:'allow',source:'trial',validFrom:past-1000,validUntil:past,actor:'test',changeSource:'unit'});
    let resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    expect(check(resolver,account,'DE').decision).toBe('gated');
    store.putAccountEntitlement({accountId:account.accountId,coverageTier:'extended',source:'grandfathered',actor:'test',changeSource:'unit'});
    resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    expect(check(resolver,account,'DE')).toMatchObject({decision:'allowed',source:'grandfathered'});
  });

  it('normalizes UK aliases and rejects unknown/disabled countries',()=>{
    const snapshot=store.loadPolicySnapshot();
    for(const value of ['UK','uk','GB','United Kingdom','  united   kingdom  ','ＵＫ']) {
      expect(normalizeCountry(value,snapshot)).toEqual({ok:true,country:'GB'});
    }
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    expect(check(resolver,core(),'XX')).toMatchObject({decision:'invalid',upstreamAllowed:false,error:{error:'invalid_country'}});
    expect(check(resolver,extended(),'BE')).toMatchObject({decision:'invalid',error:{error:'country_disabled'}});
  });

  it('reloads a changed policy version without redeploy',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test',cacheTtlMs:0});
    expect(check(resolver,core(),'DE').decision).toBe('gated');
    const version=store.setCountryPolicy({countryCode:'DE',coverageGroup:'core',enabled:true,aliases:['Germany'],actor:'test',changeSource:'unit'});
    expect(version).toBe(2);
    expect(check(resolver,core(),'DE')).toMatchObject({decision:'allowed',policyVersion:2});
  });

  it('observe records would-gate while allowing upstream',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'observe',upgradeUrl:'https://example.test'});
    expect(check(resolver,core(),'DE')).toMatchObject({decision:'gated',wouldGate:true,upstreamAllowed:true});
  });

  it('reports gated intent, upgrade CTA, and avoided upstream without account IDs',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    const decision=check(resolver,core(),'DE');
    resolver.record(decision,false);

    expect(store.intentReport(Date.now()-1_000)).toContainEqual({
      country:'DE',unique_accounts:1,requests:1,gated:1,upgrade_ctas:1,upstream_avoided:1,
    });
    expect(JSON.stringify(store.intentReport(Date.now()-1_000))).not.toContain(core().accountId);
  });

  it('a probe check (would-I-be-allowed, no real attempt) never emits an upgrade_cta',()=>{
    // Mirrors packages/dd/src/http.ts rest:entitlement_check: it calls record()
    // with isProbe so the self-check endpoint doesn't inflate the CTA funnel.
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    const decision=check(resolver,core(),'DE');
    resolver.record(decision,false,{isProbe:true});

    expect(store.intentReport(Date.now()-1_000)).toContainEqual({
      country:'DE',unique_accounts:1,requests:1,gated:1,upgrade_ctas:0,upstream_avoided:1,
    });
  });

  it('tier_required errors list what the paid tier unlocks, with no pricing',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test/upgrade'});

    const coverageError=check(resolver,core(),'DE').error as import('../types.js').TierRequiredError;
    expect(coverageError.available_in_tier).toContain('DE');
    expect(coverageError.available_in_tier).not.toContain('BE'); // disabled in current policy: not actually available
    expect(coverageError.available_in_tier).toEqual([...coverageError.available_in_tier].sort());
    expect(coverageError.message).not.toMatch(/€|\$|eur\b|usd\b|\/\s?mo\b/i);
    expect(coverageError.upgrade_url).toBe('https://example.test/upgrade');

    const depthError=check(resolver,core(),'CZ','ddplus').error as import('../types.js').TierRequiredError;
    expect(depthError.available_in_tier).toEqual([...DDPLUS_CAPABILITIES]);
    expect(depthError.message).not.toMatch(/€|\$|eur\b|usd\b|\/\s?mo\b/i);
    expect(depthError.upgrade_url).toBe('https://example.test/upgrade');
  });

  it('records a feature-flagged x402 preview offer only for an enforced DD+ denial',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    const decision=check(resolver,core(),'CZ','ddplus');
    resolver.record(decision,false,{x402Preview:true});
    expect(store.x402PreviewCounts()).toEqual({offered:1,intents:0,intentsAnonymous:0,intentsIdentified:0});
    const anon={identityClass:'anonymous' as const,identityAgeDays:null};
    expect(store.recordX402PreviewIntent(core().accountPseudonym,'req-1',anon)).toBe(true);
    expect(store.recordX402PreviewIntent(core().accountPseudonym,'req-1',anon)).toBe(true);
    expect(store.x402PreviewCounts()).toEqual({offered:1,intents:1,intentsAnonymous:1,intentsIdentified:0});
    expect(store.x402PreviewCounts(Date.now()+1)).toEqual({offered:0,intents:0,intentsAnonymous:0,intentsIdentified:0});
  });

  it('does not record a preview for a probe, coverage decision, or allowed request',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    resolver.record(check(resolver,core(),'CZ','ddplus'),false,{x402Preview:true,isProbe:true});
    resolver.record(check(resolver,core(),'DE'),false,{x402Preview:true});
    resolver.record(check(resolver,extended(),'CZ','ddplus'),true,{x402Preview:true});
    expect(store.x402PreviewCounts()).toEqual({offered:0,intents:0,intentsAnonymous:0,intentsIdentified:0});
  });

  it('classifies a stored token with a stable account id as identified, everything else as anonymous',()=>{
    const twoDaysAgo=Date.now()-2*86_400_000;
    const token=(over:Partial<TokenRecord>={}):TokenRecord=>({token:'tok-live',service:'dd',tier:'pay-per-report',
      stripe_customer_id:'cus-live',stripe_subscription_id:null,monthly_quota:null,counter:0,credits:3,
      period_started_at:twoDaysAgo,created_at:twoDaysAgo,updated_at:twoDaysAgo,revoked_at:null,...over});
    expect(accountContextFromToken(token(),'1.2.3.4','test-salt'))
      .toMatchObject({identityClass:'identified',identityAgeDays:2});
    // No token at all — the pseudonym is only an IP hash.
    expect(accountContextFromToken(null,'1.2.3.4','test-salt'))
      .toMatchObject({identityClass:'anonymous',identityAgeDays:null});
    // The synthetic free-tier record the auth guard hands to anonymous callers.
    expect(accountContextFromToken(token({token:'__anonymous__',stripe_customer_id:''}),'1.2.3.4','test-salt'))
      .toMatchObject({identityClass:'anonymous',identityAgeDays:null});
    // A real token whose account id is empty falls back to an IP-derived
    // pseudonym, so it must not be counted as a durable identity.
    expect(accountContextFromToken(token({stripe_customer_id:''}),'1.2.3.4','test-salt'))
      .toMatchObject({identityClass:'anonymous',identityAgeDays:null});
  });

  it('separates anonymous from identified declarations and reports the denominator',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    const paidCreditToken:TokenRecord={token:'tok-ppr',service:'dd',tier:'pay-per-report',
      stripe_customer_id:'cus-ppr',stripe_subscription_id:null,monthly_quota:null,counter:0,credits:2,
      period_started_at:Date.now()-5*86_400_000,created_at:Date.now()-5*86_400_000,
      updated_at:Date.now(),revoked_at:null};
    const identified=accountContextFromToken(paidCreditToken,'9.9.9.9','test-salt');
    const anonymous=core();

    // Both callers hit the DD+ depth gate and are offered the preview.
    resolver.record(resolver.check({account:anonymous,country:'CZ',requestedDepth:'ddplus',
      endpoint:'mcp:get_dd_report',requestId:'req-anon'}),false,{x402Preview:true});
    resolver.record(resolver.check({account:identified,country:'CZ',requestedDepth:'ddplus',
      endpoint:'mcp:get_dd_report',requestId:'req-id'}),false,{x402Preview:true});

    expect(store.recordX402PreviewIntent(anonymous.accountPseudonym,'req-anon',
      {identityClass:'anonymous',identityAgeDays:null})).toBe(true);
    expect(store.recordX402PreviewIntent(identified.accountPseudonym,'req-id',
      {identityClass:'identified',identityAgeDays:identified.identityAgeDays})).toBe(true);
    // An intent for an offer that was never made to this pseudonym is refused.
    expect(store.recordX402PreviewIntent(identified.accountPseudonym,'req-anon',
      {identityClass:'identified',identityAgeDays:5})).toBe(false);

    const report=store.x402PreviewReport();
    expect(report).toMatchObject({gateCalls:2,gatedCalls:2,offers:2,offersAnonymous:1,offersIdentified:1,
      intentsAnonymous:1,intentsIdentified:1,identifiedIdentities:1,identifiedRepeatIdentities:0});
    expect(report.byEndpoint).toEqual([{endpoint:'mcp:get_dd_report',gateCalls:2,gatedCalls:2,offers:2,
      intentsAnonymous:1,intentsIdentified:1}]);
    expect(report.interpretation).toMatch(/^POSITIVE SIGNAL/);
  });

  it('stores age and call volume on the declaration, and never any account identifier',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    const token:TokenRecord={token:'tok-age',service:'dd',tier:'pay-per-report',stripe_customer_id:'cus-age',
      stripe_subscription_id:null,monthly_quota:null,counter:0,credits:1,
      period_started_at:Date.now()-11*86_400_000,created_at:Date.now()-11*86_400_000,
      updated_at:Date.now(),revoked_at:null};
    const account=accountContextFromToken(token,'8.8.8.8','test-salt');
    // Two earlier checks give this identity a history to lose.
    for (const requestId of ['hist-1','hist-2']) {
      resolver.record(resolver.check({account,country:'CZ',requestedDepth:'basic',
        endpoint:'mcp:get_company',requestId}),true);
    }
    resolver.record(resolver.check({account,country:'CZ',requestedDepth:'ddplus',
      endpoint:'mcp:get_dd_report',requestId:'req-age'}),false,{x402Preview:true});
    store.recordX402PreviewIntent(account.accountPseudonym,'req-age',
      {identityClass:'identified',identityAgeDays:account.identityAgeDays});

    const rows=readEvents(join(dir,'tokens.db'),'x402_preview_intent');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({identity_class:'identified',identity_age_days:11,identity_calls:3});
    expect(JSON.stringify(rows[0])).not.toContain('cus-age');
    expect(JSON.stringify(rows[0])).not.toContain('tok-age');
    expect(JSON.stringify(rows[0])).not.toContain('8.8.8.8');
  });

  it('reads an empty window as empty, not as a finding',()=>{
    expect(store.x402PreviewReport().interpretation).toMatch(/^EMPTY WINDOW/);
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    resolver.record(resolver.check({account:core(),country:'CZ',requestedDepth:'ddplus',
      endpoint:'mcp:get_dd_report',requestId:'req-only-anon'}),false,{x402Preview:true});
    // Offers exist but every one went to an anonymous caller: an identified
    // zero here is a fact about signup, not about willingness to pay.
    expect(store.x402PreviewReport().interpretation).toMatch(/^IDENTITY CEILING/);
  });

  it('survives losing the migration race, but still dies on any other schema error',()=>{
    // dd, ares and eu-registry all open the same tokens.db. Booting together,
    // two of them can both see a column missing and both issue the ALTER.
    const db=new Database(join(dir,'raced.db'));
    try {
      db.exec('CREATE TABLE t (a TEXT)');
      // A check that lies — exactly what the losing process sees, because the
      // winner added the column between its check and its apply.
      const lying={check:"SELECT 1 FROM pragma_table_info('t') WHERE name='nonexistent'",
        apply:'ALTER TABLE t ADD COLUMN a TEXT'};
      expect(()=>applyMigration(db,lying)).not.toThrow();
      // ...and the column is there, which is the only outcome that matters.
      expect(db.prepare("SELECT 1 FROM pragma_table_info('t') WHERE name='a'").get()).toBeTruthy();
      // Any other schema failure must still abort the boot.
      expect(()=>applyMigration(db,{check:lying.check,apply:'ALTER TABLE does_not_exist ADD COLUMN x TEXT'}))
        .toThrow(/no such table/i);
    } finally { db.close(); }
  });

  it('adds the identity columns to a database created before they existed',()=>{
    const legacyPath=join(dir,'legacy.db');
    const legacy=new Database(legacyPath);
    legacy.exec(`CREATE TABLE entitlement_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
      event_kind TEXT NOT NULL DEFAULT 'entitlement_check', account_pseudonym TEXT NOT NULL,
      country TEXT, country_group TEXT, coverage_tier TEXT NOT NULL, depth_tier TEXT NOT NULL,
      decision TEXT NOT NULL, dimension TEXT NOT NULL, required_tier TEXT, policy_version INTEGER,
      source TEXT NOT NULL, mode TEXT NOT NULL, would_gate INTEGER NOT NULL,
      upstream_called INTEGER NOT NULL, upstream_avoided INTEGER NOT NULL,
      endpoint TEXT NOT NULL, request_id TEXT NOT NULL)`);
    legacy.prepare(`INSERT INTO entitlement_events(timestamp,event_kind,account_pseudonym,coverage_tier,
      depth_tier,decision,dimension,source,mode,would_gate,upstream_called,upstream_avoided,endpoint,request_id)
      VALUES(?,'x402_preview_offered','old-pseudo','core','basic','gated','depth','plan','enforce',1,0,1,'mcp:get_dd_report','old-req')`)
      .run(Date.now());
    legacy.close();

    const migrated=new EntitlementStore(legacyPath);
    try {
      const report=migrated.x402PreviewReport();
      // The pre-existing row keeps a NULL identity class: it is counted as an
      // offer, but never silently attributed to either identity class.
      expect(report).toMatchObject({offers:1,offersAnonymous:0,offersIdentified:0,
        intentsAnonymous:0,intentsIdentified:0});
      expect(migrated.recordX402PreviewIntent('old-pseudo','old-req',
        {identityClass:'identified',identityAgeDays:3})).toBe(true);
      expect(migrated.x402PreviewReport()).toMatchObject({intentsIdentified:1});
    } finally { migrated.close(); }
  });

  it('coverage available_in_tier reflects live policy changes without redeploy',()=>{
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test',cacheTtlMs:0});
    expect((check(resolver,core(),'DE').error as import('../types.js').TierRequiredError).available_in_tier).not.toContain('BE');
    store.setCountryPolicy({countryCode:'BE',coverageGroup:'extended',enabled:true,aliases:['Belgium'],actor:'test',changeSource:'unit'});
    expect((check(resolver,core(),'DE').error as import('../types.js').TierRequiredError).available_in_tier).toContain('BE');
  });

  it('fails closed when no valid policy snapshot exists',()=>{
    const empty=new EntitlementStore(join(dir,'unseeded.db'));
    try {
      const resolver=new HostedEntitlementResolver(empty,{mode:'enforce',upgradeUrl:'https://example.test'});
      expect(check(resolver,core(),'CZ')).toMatchObject({decision:'invalid',upstreamAllowed:false,error:{error:'policy_unavailable'}});
    } finally { empty.close(); }
  });

  it('enforces configured usage independently',()=>{
    const account=core();
    store.putAccountEntitlement({accountId:account.accountId,usageLimits:{requests_per_day:1},source:'manual',actor:'test',changeSource:'unit'});
    const resolver=new HostedEntitlementResolver(store,{mode:'enforce',upgradeUrl:'https://example.test'});
    const input={account,country:'CZ',requestedDepth:'basic' as const,endpoint:'rest',requestId:'one',usageMetric:'requests_per_day' as const};
    expect(resolver.check(input).decision).toBe('allowed');
    expect(resolver.check({...input,requestId:'two'})).toMatchObject({decision:'invalid',dimension:'usage',error:{error:'usage_limit_exceeded'}});
  });
});

/**
 * Reads the rows back through a second connection rather than through the
 * store's own reporting methods — a report that agrees with the writer proves
 * nothing about what was actually persisted.
 */
function readEvents(dbPath:string,eventKind:string):Array<Record<string,unknown>> {
  const db=new Database(dbPath,{readonly:true});
  try { return db.prepare('SELECT * FROM entitlement_events WHERE event_kind=? ORDER BY id')
    .all(eventKind) as Array<Record<string,unknown>>; }
  finally { db.close(); }
}
