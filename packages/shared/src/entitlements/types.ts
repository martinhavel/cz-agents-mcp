import type { TokenRecord } from '../billing/types.js';

export type CoverageTier = 'core' | 'extended';
export type DepthTier = 'basic' | 'ddplus';
export type CoverageGroup = CoverageTier;
export type EntitlementSource = 'plan' | 'trial' | 'grandfathered' | 'manual' | 'promotion';
export type EntitlementMode = 'off' | 'observe' | 'enforce';
export type EntitlementDimension = 'coverage' | 'depth' | 'usage';
export type EntitlementDecisionKind = 'allowed' | 'gated' | 'invalid';

export interface UsageLimits {
  requests_per_day?: number;
  extended_requests_per_month?: number;
  ddplus_reports_per_month?: number;
  monitoring_entities?: number;
}

export type UsageMetric = keyof UsageLimits;

export interface CountryPolicy {
  countryCode: string;
  coverageGroup: CoverageGroup;
  enabled: boolean;
  aliases: string[];
  policyVersion: number;
  updatedAt: number;
  updatedBy: string;
  changeSource: string;
}

export interface CountryPolicySnapshot {
  version: number;
  loadedAt: number;
  countries: ReadonlyMap<string, CountryPolicy>;
  aliases: ReadonlyMap<string, string>;
  stale: boolean;
}

export interface HostedAccountContext {
  accountId: string;
  accountPseudonym: string;
  token: TokenRecord | null;
  planCoverageTier: CoverageTier;
  planDepthTier: DepthTier;
  source: EntitlementSource;
}

export interface EntitlementCheckInput {
  account: HostedAccountContext;
  country: string;
  requestedDepth?: DepthTier;
  endpoint: string;
  requestId: string;
  usageMetric?: UsageMetric;
}

export interface TierRequiredError {
  error: 'tier_required';
  dimension: 'coverage' | 'depth';
  required_tier: 'extended' | 'ddplus';
  country: string;
  country_group?: CoverageGroup;
  upgrade_url: string;
  message: string;
}

export interface EntitlementDecision {
  decision: EntitlementDecisionKind;
  dimension: EntitlementDimension;
  mode: EntitlementMode;
  country: string | null;
  countryGroup: CoverageGroup | null;
  coverageTier: CoverageTier;
  depthTier: DepthTier;
  policyVersion: number | null;
  source: EntitlementSource;
  requiredTier: 'extended' | 'ddplus' | null;
  wouldGate: boolean;
  upstreamAllowed: boolean;
  usageLimits: UsageLimits;
  endpoint: string;
  requestId: string;
  accountPseudonym: string;
  error?: TierRequiredError | EntitlementValidationError;
}

export interface EntitlementValidationError {
  error: 'invalid_country' | 'country_disabled' | 'policy_unavailable' | 'usage_limit_exceeded';
  dimension: 'coverage' | 'usage';
  country?: string;
  policy_version?: number;
  message: string;
}

export interface AccountEntitlementRow {
  id: string;
  accountId: string;
  coverageTier: CoverageTier | null;
  depthTier: DepthTier | null;
  usageLimits: UsageLimits;
  policyVersion: number;
  source: EntitlementSource;
  validFrom: number;
  validUntil: number | null;
  createdAt: number;
}

export interface AccountCountryOverrideRow {
  id: string;
  accountId: string;
  countryCode: string;
  effect: 'allow' | 'deny';
  source: EntitlementSource;
  validFrom: number;
  validUntil: number | null;
  createdAt: number;
}

export interface EntitlementEventInput {
  timestamp?: number;
  accountPseudonym: string;
  country: string | null;
  countryGroup: CoverageGroup | null;
  coverageTier: CoverageTier;
  depthTier: DepthTier;
  decision: EntitlementDecisionKind;
  dimension: EntitlementDimension;
  requiredTier: string | null;
  policyVersion: number | null;
  source: EntitlementSource;
  mode: EntitlementMode;
  wouldGate: boolean;
  upstreamCalled: boolean;
  upstreamAvoided: boolean;
  endpoint: string;
  requestId: string;
  eventKind?: 'entitlement_check' | 'upgrade_cta' | 'conversion';
}

