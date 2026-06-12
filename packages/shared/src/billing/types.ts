/**
 * Billing types — shared across sanctions + dd. The schema is intentionally
 * service-agnostic: a single tokens table can host tokens for multiple services
 * (`service` column distinguishes sanctions/dd), so a customer who buys both
 * has two rows but one Stripe customer.
 */

export type TierKind = 'free' | 'starter' | 'pro' | 'agency' | 'pay-per-report' | 're_pro' | 're_agency';
export type ServiceKind = 'sanctions' | 'dd' | 'realestate';

export interface Tier {
  kind: TierKind;
  /** Monthly call quota. Null for pay-per-report (uses credits) and free (rate-limited externally). */
  monthly_quota: number | null;
  /** Initial credit balance for one-time purchases (pay-per-report). Null for subscriptions. */
  credits_per_purchase: number | null;
  /** Daily quota for the free tier — enforced even without a token, by IP. */
  daily_free_quota?: number;
}

/** A package's price→tier mapping. Provided by sanctions/dd at startup. */
export interface BillingConfig {
  service: ServiceKind;
  /** Map of Stripe price IDs to tier definitions. Unknown price IDs → ignored event. */
  priceTiers: Record<string, Tier>;
  /** Default credits granted when buying N units of pay-per-report at quantity Q. */
  payPerReportPriceId?: string;
}

export interface TokenRecord {
  /** Random opaque secret (UUID-shaped), this is what the client sends in Authorization header. */
  token: string;
  service: ServiceKind;
  tier: TierKind;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  /** Subscription tier monthly quota OR null for pay-per-report. */
  monthly_quota: number | null;
  /** Used calls in current billing period (resets monthly for subscriptions). */
  counter: number;
  /** Remaining credits for pay-per-report tokens. Null for subscriptions. */
  credits: number | null;
  expires_at?: number | null;
  /** Start of current counter period (epoch ms). */
  period_started_at: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

export type AuthOutcome =
  | { ok: true; token: TokenRecord }
  | { ok: false; status: 401 | 402 | 429 | 500; reason: string };
