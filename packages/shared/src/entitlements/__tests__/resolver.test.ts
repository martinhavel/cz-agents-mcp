import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeCountry } from '../country.js';
import { HostedEntitlementResolver, accountContextFromToken, DDPLUS_CAPABILITIES } from '../resolver.js';
import { EntitlementStore } from '../store.js';
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
