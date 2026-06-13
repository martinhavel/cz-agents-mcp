/**
 * Service-specific billing config for sanctions.
 *
 * The standalone sanctions Starter/Pro products were archived (2026-05-08).
 * Sanctions screening is now bundled into the Compliance tier, so this maps to
 * the SAME canonical Compliance price-id env vars as dd — there is no separate
 * sanctions product, and no SANCTIONS_* env names.
 *
 * Price→tier mapping is built at runtime from canonical Stripe price-id env vars
 * (same names the webapp + billing topology use). This is a PUBLIC repo, so NO
 * price ids are hardcoded — they are injected via env on the production host.
 *
 *   - STRIPE_PRICE_API_EUR  — API Compliance €99/mo  → kind 'pro'
 *   - STRIPE_PRICE_API_FM   — API Compliance Founding €69/mo → kind 'pro'
 *   - STRIPE_PRICE_AGENCY_EUR — Agency €199/mo → kind 'agency'
 *
 * Web Compliance (basic) is web-only and does not mint an MCP token, so it is
 * intentionally not mapped — an unmapped price id is ignored by the webhook.
 */
import type { BillingConfig, Tier } from '@czagents/shared';

/**
 * Build the sanctions billing config from environment. Constructs the price→tier
 * map runtime so no Stripe price id ever lives in this public source tree.
 *
 * Required: STRIPE_PRICE_API_EUR, STRIPE_PRICE_AGENCY_EUR.
 * Optional: STRIPE_PRICE_API_FM (Founding Member; mapped to 'pro' if present).
 */
export function buildSanctionsBilling(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const apiEur = requireEnvFrom(env, 'STRIPE_PRICE_API_EUR');
  const agencyEur = requireEnvFrom(env, 'STRIPE_PRICE_AGENCY_EUR');
  const apiFm = env['STRIPE_PRICE_API_FM'];

  const pro: Tier = { kind: 'pro', monthly_quota: 5_000, credits_per_purchase: null };
  const agency: Tier = { kind: 'agency', monthly_quota: 25_000, credits_per_purchase: null };

  const priceTiers: Record<string, Tier> = {
    [apiEur]: pro,
    [agencyEur]: agency,
  };
  if (apiFm) {
    priceTiers[apiFm] = pro;
  }

  return {
    service: 'sanctions',
    priceTiers,
  };
}

function requireEnvFrom(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(
      `[sanctions billing] missing required env var ${name} — cannot map Stripe price→tier. ` +
        `Set it (canonical Stripe price id) before enabling the Stripe webhook.`,
    );
  }
  return v;
}
