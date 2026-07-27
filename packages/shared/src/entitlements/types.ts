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

/**
 * Whether the caller behind a request has an identity that can be burned.
 *   - 'identified': a stored, revocable token bound to a stable account id, so
 *     the account pseudonym survives an IP change and the account can be
 *     blocked. Declaring an intent therefore costs the caller something.
 *   - 'anonymous': no token (or a token with no stable account id, whose
 *     pseudonym is only an IP hash). Free to produce and free to discard.
 * The distinction is the whole point of the x402 preview's second phase: a
 * declaration that costs nothing measures curiosity, not willingness to pay.
 */
export type IdentityClass = 'anonymous' | 'identified';

/**
 * Non-PII identity dimension attached to x402 preview events. Deliberately
 * only age and volume — never the account id, token, customer id or IP.
 */
export interface IdentitySignal {
  identityClass: IdentityClass;
  /** Whole days since the token record was created. Null when anonymous. */
  identityAgeDays: number | null;
  /** Entitlement checks recorded for this pseudonym so far. Null when unknown. */
  identityCalls: number | null;
}

export interface HostedAccountContext {
  accountId: string;
  accountPseudonym: string;
  token: TokenRecord | null;
  planCoverageTier: CoverageTier;
  planDepthTier: DepthTier;
  source: EntitlementSource;
  identityClass: IdentityClass;
  identityAgeDays: number | null;
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
  /**
   * What the paid tier concretely unlocks, so an agent relaying this error can
   * tell the user what they'd get — never a price (prices live on the pricing
   * page, not in this contract).
   *   - dimension 'coverage': ISO country codes in the Extended group (from the
   *     live policy snapshot, not hardcoded — countries can be added/removed
   *     without a code change).
   *   - dimension 'depth': ddplus tool/capability names (static list).
   */
  available_in_tier: string[];
  /**
   * Optional, feature-flagged discovery metadata for a payment experiment.
   * This is deliberately a preview only: it never accepts or authorizes a
   * payment and is exposed only for the one supported depth-gated report.
   */
  payment_options?: Array<{
    protocol: 'x402';
    status: 'preview';
    intent_url: string;
    intent_request_id: string;
    supported_endpoint: string;
    message: string;
  }>;
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
  identityClass: IdentityClass;
  identityAgeDays: number | null;
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
  eventKind?: 'entitlement_check' | 'upgrade_cta' | 'upgrade_cta_fanout' | 'conversion' |
    'x402_preview_offered' | 'x402_preview_intent';
  /**
   * Set only on x402 preview events. Left undefined elsewhere so the columns
   * stay NULL and "not measured" never reads as "measured anonymous".
   */
  identity?: IdentitySignal;
}

/**
 * One reporting window of the x402 preview funnel. Numerator and denominator
 * always travel together: intents are meaningless without the number of calls
 * that reached the gate at all, so a zero can never be mistaken for an empty
 * window.
 */
export interface X402PreviewReport {
  since: number | null;
  /** Denominator: entitlement checks that reached a gated depth decision. */
  gateCalls: number;
  /** Of those, how many were actually gated (the population that can be offered). */
  gatedCalls: number;
  offers: number;
  offersAnonymous: number;
  offersIdentified: number;
  intentsAnonymous: number;
  intentsIdentified: number;
  /** Distinct identified pseudonyms that declared at least one intent. */
  identifiedIdentities: number;
  /** Identified pseudonyms that declared an intent more than once. */
  identifiedRepeatIdentities: number;
  byEndpoint: Array<{
    endpoint: string;
    gateCalls: number;
    gatedCalls: number;
    offers: number;
    intentsAnonymous: number;
    intentsIdentified: number;
  }>;
  /** Plain-language reading of the numbers above, including the empty case. */
  interpretation: string;
}
