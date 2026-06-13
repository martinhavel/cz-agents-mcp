/**
 * Service-specific billing config for dd.
 *
 * Price→tier mapping is built at runtime from canonical Stripe price-id env vars
 * (the same names the webapp + billing topology use). This is a PUBLIC repo, so
 * NO price ids are hardcoded — they are injected via env on the production host.
 *
 * Tier semantics (per billing topology 2026-05-18 / stripe-ids 2026-05-08):
 *   - STRIPE_PRICE_API_EUR  — API Compliance €99/mo  → kind 'pro'
 *   - STRIPE_PRICE_API_FM   — API Compliance Founding €69/mo → kind 'pro'
 *   - STRIPE_PRICE_AGENCY_EUR — Agency €199/mo → kind 'agency'
 *   - STRIPE_PRICE_PAY_PER_REPORT — one-time €1; quantity at checkout → credits
 *
 * Web Compliance (STRIPE_PRICE_WEB_EUR / STRIPE_PRICE_WEB_FM = basic) is WEB-ONLY:
 * it does NOT mint an MCP token, so those price ids are intentionally NOT mapped
 * here — an unmapped price id is ignored by the webhook (no token issued).
 */
import type { BillingConfig, Tier } from '@czagents/shared';

/**
 * Build the dd billing config from environment. Constructs the price→tier map
 * runtime so no Stripe price id ever lives in this public source tree.
 *
 * Required: STRIPE_PRICE_API_EUR, STRIPE_PRICE_AGENCY_EUR, STRIPE_PRICE_PAY_PER_REPORT.
 * Optional: STRIPE_PRICE_API_FM (Founding Member; mapped to 'pro' if present).
 */
export function buildDdBilling(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const apiEur = requireEnvFrom(env, 'STRIPE_PRICE_API_EUR');
  const agencyEur = requireEnvFrom(env, 'STRIPE_PRICE_AGENCY_EUR');
  const payPerReport = requireEnvFrom(env, 'STRIPE_PRICE_PAY_PER_REPORT');
  const apiFm = env['STRIPE_PRICE_API_FM'];

  const pro: Tier = { kind: 'pro', monthly_quota: 5_000, credits_per_purchase: null };
  const agency: Tier = { kind: 'agency', monthly_quota: 25_000, credits_per_purchase: null };

  const priceTiers: Record<string, Tier> = {
    [payPerReport]: { kind: 'pay-per-report', monthly_quota: null, credits_per_purchase: 1 },
    [apiEur]: pro,
    [agencyEur]: agency,
  };
  if (apiFm) {
    priceTiers[apiFm] = pro;
  }

  return {
    service: 'dd',
    priceTiers,
    payPerReportPriceId: payPerReport,
  };
}

function requireEnvFrom(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(
      `[dd billing] missing required env var ${name} — cannot map Stripe price→tier. ` +
        `Set it (canonical Stripe price id) before enabling the Stripe webhook.`,
    );
  }
  return v;
}
