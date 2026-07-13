import { createHash } from 'node:crypto';
import type { TokenRecord } from '../billing/types.js';
import { normalizeCountry } from './country.js';
import { EntitlementStore } from './store.js';
import type {
  CountryPolicySnapshot, DepthTier, EntitlementCheckInput, EntitlementDecision,
  EntitlementEventInput, EntitlementMode, EntitlementSource, HostedAccountContext,
  TierRequiredError, UsageLimits,
} from './types.js';

const SOURCE_PRIORITY: Record<EntitlementSource, number> = {
  plan: 0, trial: 1, grandfathered: 2, promotion: 3, manual: 4,
};

export class HostedEntitlementResolver {
  private snapshot: CountryPolicySnapshot | null = null;
  private lastRefreshAttempt = 0;

  constructor(
    private readonly store: EntitlementStore,
    private readonly options: { mode: EntitlementMode; upgradeUrl: string; cacheTtlMs?: number },
  ) {}

  check(input: EntitlementCheckInput, now = Date.now()): EntitlementDecision {
    const effective = this.effectiveAccount(input.account, now);
    if(!effective.storageAvailable)return this.invalid(input,effective,'policy_unavailable','Entitlement storage is unavailable.',null,this.snapshot?.version ?? null);
    const snapshot = this.policy(now);
    if (!snapshot) return this.invalid(input,effective,'policy_unavailable','Policy storage is unavailable.',null,null);
    const normalized = normalizeCountry(input.country,snapshot);
    if (!normalized.ok) return this.invalid(input,effective,'invalid_country','Unknown or unsupported country.',null,snapshot.version);
    const policy = snapshot.countries.get(normalized.country)!;
    if (!policy.enabled) return this.invalid(input,effective,'country_disabled',`${normalized.country} is not enabled in the hosted policy.`,normalized.country,snapshot.version);

    let overrides;
    try { overrides=input.account.accountId
      ? this.store.getActiveCountryOverrides(input.account.accountId,normalized.country,now) : []; }
    catch { return this.invalid(input,effective,'policy_unavailable','Entitlement storage is unavailable.',normalized.country,snapshot.version); }
    const denied = overrides.some((row) => row.effect === 'deny');
    const allowedOverride = !denied && overrides.some((row) => row.effect === 'allow');
    const coverageAllowed = !denied && (allowedOverride || policy.coverageGroup === 'core' || effective.coverageTier === 'extended');
    if (!coverageAllowed) {
      const error: TierRequiredError = { error:'tier_required',dimension:'coverage',required_tier:'extended',
        country:normalized.country,country_group:policy.coverageGroup,upgrade_url:this.options.upgradeUrl,
        message:`Extended European coverage is required for ${countryDisplayName(normalized.country)}.` };
      return this.gated(input,effective,normalized.country,policy.coverageGroup,snapshot.version,'coverage','extended',error);
    }

    if ((input.requestedDepth ?? 'basic') === 'ddplus' && effective.depthTier !== 'ddplus') {
      const error: TierRequiredError = { error:'tier_required',dimension:'depth',required_tier:'ddplus',
        country:normalized.country,upgrade_url:this.options.upgradeUrl,
        message:`DD+ is required for advanced analysis in ${normalized.country}.` };
      return this.gated(input,effective,normalized.country,policy.coverageGroup,snapshot.version,'depth','ddplus',error);
    }

    if (input.usageMetric) {
      const limit = effective.usageLimits[input.usageMetric];
      if (limit !== undefined && !this.store.consumeUsage(input.account.accountId,input.usageMetric,limit,now)) {
        return this.invalid(input,effective,'usage_limit_exceeded',`Usage limit exceeded for ${input.usageMetric}.`,normalized.country,snapshot.version,'usage');
      }
    }

    const decision: EntitlementDecision = { decision:'allowed',dimension:input.requestedDepth === 'ddplus' ? 'depth':'coverage',
      mode:this.options.mode,country:normalized.country,countryGroup:policy.coverageGroup,
      coverageTier:effective.coverageTier,depthTier:effective.depthTier,policyVersion:snapshot.version,
      source:effective.source,requiredTier:null,wouldGate:false,upstreamAllowed:true,
      usageLimits:effective.usageLimits,endpoint:input.endpoint,requestId:input.requestId,
      accountPseudonym:input.account.accountPseudonym };
    return decision;
  }

  record(decision: EntitlementDecision, upstreamCalled: boolean): void {
    const event: EntitlementEventInput = { accountPseudonym:decision.accountPseudonym,country:decision.country,
      countryGroup:decision.countryGroup,coverageTier:decision.coverageTier,depthTier:decision.depthTier,
      decision:decision.decision,dimension:decision.dimension,requiredTier:decision.requiredTier,
      policyVersion:decision.policyVersion,source:decision.source,mode:decision.mode,wouldGate:decision.wouldGate,
      upstreamCalled,upstreamAvoided:!upstreamCalled && decision.wouldGate,endpoint:decision.endpoint,
      requestId:decision.requestId };
    this.store.recordEvent(event);
    if(!upstreamCalled && decision.error?.error==='tier_required') {
      this.store.recordEvent({...event,eventKind:'upgrade_cta',upstreamAvoided:false});
    }
  }

  private policy(now:number): CountryPolicySnapshot|null {
    if (this.snapshot && now-this.lastRefreshAttempt < (this.options.cacheTtlMs ?? 30_000)) return this.snapshot;
    this.lastRefreshAttempt=now;
    try { this.snapshot=this.store.loadPolicySnapshot(now); return this.snapshot; }
    catch { return this.snapshot ? {...this.snapshot,stale:true} : null; }
  }

  private effectiveAccount(account:HostedAccountContext,now:number): {coverageTier:'core'|'extended';depthTier:DepthTier;usageLimits:UsageLimits;source:EntitlementSource;storageAvailable:boolean} {
    let coverageTier=account.planCoverageTier; let depthTier=account.planDepthTier;
    let usageLimits:UsageLimits={}; let source=account.source; let priority=SOURCE_PRIORITY[source];
    let rows;
    try { rows=account.accountId ? this.store.getActiveEntitlements(account.accountId,now) : []; }
    catch { return {coverageTier,depthTier,usageLimits,source,storageAvailable:false}; }
    for (const row of rows.sort((a,b)=>SOURCE_PRIORITY[a.source]-SOURCE_PRIORITY[b.source] || a.createdAt-b.createdAt)) {
      if (row.coverageTier) coverageTier=row.coverageTier;
      if (row.depthTier) depthTier=row.depthTier;
      usageLimits={...usageLimits,...row.usageLimits};
      if (SOURCE_PRIORITY[row.source]>=priority) { source=row.source; priority=SOURCE_PRIORITY[row.source]; }
    }
    return {coverageTier,depthTier,usageLimits,source,storageAvailable:true};
  }

  private gated(input:EntitlementCheckInput,effective:ReturnType<HostedEntitlementResolver['effectiveAccount']>,country:string,
    group:'core'|'extended',version:number,dimension:'coverage'|'depth',required:'extended'|'ddplus',error:TierRequiredError):EntitlementDecision {
    const wouldGate=true; const enforce=this.options.mode==='enforce';
    return {decision:'gated',dimension,mode:this.options.mode,country,countryGroup:group,
      coverageTier:effective.coverageTier,depthTier:effective.depthTier,policyVersion:version,source:effective.source,
      requiredTier:required,wouldGate,upstreamAllowed:!enforce,usageLimits:effective.usageLimits,
      endpoint:input.endpoint,requestId:input.requestId,accountPseudonym:input.account.accountPseudonym,error};
  }

  private invalid(input:EntitlementCheckInput,effective:ReturnType<HostedEntitlementResolver['effectiveAccount']>,
    code:'invalid_country'|'country_disabled'|'policy_unavailable'|'usage_limit_exceeded',message:string,country:string|null,
    version:number|null,dimension:'coverage'|'usage'='coverage'):EntitlementDecision {
    const enforce=this.options.mode==='enforce';
    return {decision:'invalid',dimension,mode:this.options.mode,country,countryGroup:null,
      coverageTier:effective.coverageTier,depthTier:effective.depthTier,policyVersion:version,source:effective.source,
      requiredTier:null,wouldGate:true,upstreamAllowed:!enforce,usageLimits:effective.usageLimits,
      endpoint:input.endpoint,requestId:input.requestId,accountPseudonym:input.account.accountPseudonym,
      error:{error:code,dimension,country:country ?? undefined,policy_version:version ?? undefined,message}};
  }
}

export function accountContextFromToken(token:TokenRecord|null,pseudonymSeed:string,salt:string):HostedAccountContext {
  const paid = token ? ['pro','agency','enterprise','unlimited'].includes(String(token.tier)) : false;
  const accountId=token?.stripe_customer_id || `anonymous:${pseudonymSeed}`;
  return {accountId,accountPseudonym:createHash('sha256').update(`${salt}|${accountId}`).digest('hex').slice(0,24),
    token,planCoverageTier:paid?'extended':'core',planDepthTier:paid?'ddplus':'basic',
    source:token?.expires_at ? 'trial':'plan'};
}

export function entitlementMode(value:string|undefined):EntitlementMode {
  return value==='observe'||value==='enforce'||value==='off' ? value : 'off';
}

function countryDisplayName(code:string):string {
  return new Intl.DisplayNames(['en'],{type:'region'}).of(code) ?? code;
}
