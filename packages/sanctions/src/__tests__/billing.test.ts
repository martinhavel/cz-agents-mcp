import { describe, it, expect } from 'vitest';
import { buildSanctionsBilling } from '../billing.js';

// Fixture price ids — NOT real Stripe ids. Sanctions screening is bundled into
// the Compliance tier, so it maps to the SAME canonical Compliance prices as dd
// (no standalone sanctions product, no SANCTIONS_* env names).
const ENV_FULL = {
  STRIPE_PRICE_API_EUR: 'price_fixture_api_eur',
  STRIPE_PRICE_API_FM: 'price_fixture_api_fm',
  STRIPE_PRICE_AGENCY_EUR: 'price_fixture_agency_eur',
} as NodeJS.ProcessEnv;

describe('buildSanctionsBilling', () => {
  it('maps canonical Compliance env price ids to the right tier kinds', () => {
    const cfg = buildSanctionsBilling(ENV_FULL);
    expect(cfg.service).toBe('sanctions');
    expect(cfg.priceTiers['price_fixture_api_eur']?.kind).toBe('pro');
    expect(cfg.priceTiers['price_fixture_api_fm']?.kind).toBe('pro');
    expect(cfg.priceTiers['price_fixture_agency_eur']?.kind).toBe('agency');
  });

  it('has no pay-per-report tier (sanctions has no one-time product)', () => {
    const cfg = buildSanctionsBilling(ENV_FULL);
    expect(cfg.payPerReportPriceId).toBeUndefined();
    for (const tier of Object.values(cfg.priceTiers)) {
      expect(tier.kind).not.toBe('pay-per-report');
    }
  });

  it('API Founding Member is optional — omitted env leaves it unmapped', () => {
    const env = { ...ENV_FULL };
    delete env.STRIPE_PRICE_API_FM;
    const cfg = buildSanctionsBilling(env);
    expect(cfg.priceTiers['price_fixture_api_fm']).toBeUndefined();
    expect(cfg.priceTiers['price_fixture_api_eur']?.kind).toBe('pro');
  });

  it.each([
    'STRIPE_PRICE_API_EUR',
    'STRIPE_PRICE_AGENCY_EUR',
  ])('fail-fast: missing %s throws naming the env var', (missing) => {
    const env = { ...ENV_FULL };
    delete env[missing];
    expect(() => buildSanctionsBilling(env)).toThrow(missing);
  });
});
