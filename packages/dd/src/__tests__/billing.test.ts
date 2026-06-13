import { describe, it, expect } from 'vitest';
import { buildDdBilling } from '../billing.js';

// Fixture price ids — NOT real Stripe ids. The builder only cares that the env
// value is non-empty and maps to the right tier kind; real ids live in env on prod.
const ENV_FULL = {
  STRIPE_PRICE_API_EUR: 'price_fixture_api_eur',
  STRIPE_PRICE_API_FM: 'price_fixture_api_fm',
  STRIPE_PRICE_AGENCY_EUR: 'price_fixture_agency_eur',
  STRIPE_PRICE_PAY_PER_REPORT: 'price_fixture_ppr',
} as NodeJS.ProcessEnv;

describe('buildDdBilling', () => {
  it('maps canonical env price ids to the right tier kinds', () => {
    const cfg = buildDdBilling(ENV_FULL);
    expect(cfg.service).toBe('dd');
    expect(cfg.priceTiers['price_fixture_api_eur']?.kind).toBe('pro');
    expect(cfg.priceTiers['price_fixture_api_fm']?.kind).toBe('pro');
    expect(cfg.priceTiers['price_fixture_agency_eur']?.kind).toBe('agency');
    expect(cfg.priceTiers['price_fixture_ppr']?.kind).toBe('pay-per-report');
  });

  it('sets payPerReportPriceId from STRIPE_PRICE_PAY_PER_REPORT', () => {
    const cfg = buildDdBilling(ENV_FULL);
    expect(cfg.payPerReportPriceId).toBe('price_fixture_ppr');
  });

  it('pay-per-report grants 1 credit per unit; subscriptions have null credits', () => {
    const cfg = buildDdBilling(ENV_FULL);
    expect(cfg.priceTiers['price_fixture_ppr']?.credits_per_purchase).toBe(1);
    expect(cfg.priceTiers['price_fixture_ppr']?.monthly_quota).toBeNull();
    expect(cfg.priceTiers['price_fixture_api_eur']?.credits_per_purchase).toBeNull();
    expect(cfg.priceTiers['price_fixture_agency_eur']?.credits_per_purchase).toBeNull();
  });

  it('API Founding Member is optional — omitted env leaves it unmapped', () => {
    const env = { ...ENV_FULL };
    delete env.STRIPE_PRICE_API_FM;
    const cfg = buildDdBilling(env);
    expect(cfg.priceTiers['price_fixture_api_fm']).toBeUndefined();
    expect(cfg.priceTiers['price_fixture_api_eur']?.kind).toBe('pro');
  });

  it('does NOT map Web Compliance (basic, web-only) — those ids stay unmapped', () => {
    const env = { ...ENV_FULL, STRIPE_PRICE_WEB_EUR: 'price_fixture_web' } as NodeJS.ProcessEnv;
    const cfg = buildDdBilling(env);
    expect(cfg.priceTiers['price_fixture_web']).toBeUndefined();
  });

  it.each([
    'STRIPE_PRICE_API_EUR',
    'STRIPE_PRICE_AGENCY_EUR',
    'STRIPE_PRICE_PAY_PER_REPORT',
  ])('fail-fast: missing %s throws naming the env var', (missing) => {
    const env = { ...ENV_FULL };
    delete env[missing];
    expect(() => buildDdBilling(env)).toThrow(missing);
  });
});
