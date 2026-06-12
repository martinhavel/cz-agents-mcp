import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { TokenStore } from '../tokenStore.js';
import { handleStripeWebhook, verifySignature, WebhookError } from '../stripeWebhook.js';
import type { BillingConfig } from '../types.js';

const SECRET = 'whsec_test';
const NOW = 1_700_000_000_000; // fixed instant for deterministic signatures

function sign(body: string, ts: number = Math.floor(NOW / 1000), secret: string = SECRET): string {
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

const SANCTIONS_CONFIG: BillingConfig = {
  service: 'sanctions',
  priceTiers: {
    price_pro: { kind: 'pro', monthly_quota: 50_000, credits_per_purchase: null },
    price_starter: { kind: 'starter', monthly_quota: 5_000, credits_per_purchase: null },
  },
};

const DD_CONFIG: BillingConfig = {
  service: 'dd',
  priceTiers: {
    price_ppr: { kind: 'pay-per-report', monthly_quota: null, credits_per_purchase: 1 },
  },
  payPerReportPriceId: 'price_ppr',
};

describe('verifySignature', () => {
  it('passes valid signature within tolerance', () => {
    const body = '{"hello":"world"}';
    const header = sign(body);
    expect(() => verifySignature(body, header, SECRET, NOW)).not.toThrow();
  });

  it('rejects malformed header', () => {
    expect(() => verifySignature('{}', 'no-equals-sign', SECRET, NOW)).toThrow(WebhookError);
  });

  it('rejects expired timestamp', () => {
    const old = Math.floor(NOW / 1000) - 6 * 60; // 6 minutes ago
    const header = sign('{}', old);
    expect(() => verifySignature('{}', header, SECRET, NOW)).toThrow(/tolerance/);
  });

  it('rejects mismatched signature', () => {
    const header = sign('{}', Math.floor(NOW / 1000), 'whsec_other');
    expect(() => verifySignature('{}', header, SECRET, NOW)).toThrow(/mismatch/);
  });

  it('accepts when one of multiple v1 signatures matches (secret rotation)', () => {
    const body = '{"hello":"world"}';
    const ts = Math.floor(NOW / 1000);
    const wrong = createHmac('sha256', 'whsec_old').update(`${ts}.${body}`).digest('hex');
    const right = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    // Matching signature is NOT last — the previous "take last v1" logic would reject this.
    const header = `t=${ts},v1=${wrong},v1=${right},v1=${wrong}`;
    expect(() => verifySignature(body, header, SECRET, NOW)).not.toThrow();
  });

  it('rejects when no v1 signature matches', () => {
    const body = '{"hello":"world"}';
    const ts = Math.floor(NOW / 1000);
    const a = createHmac('sha256', 'whsec_a').update(`${ts}.${body}`).digest('hex');
    const b = createHmac('sha256', 'whsec_b').update(`${ts}.${body}`).digest('hex');
    const header = `t=${ts},v1=${a},v1=${b}`;
    expect(() => verifySignature(body, header, SECRET, NOW)).toThrow(/mismatch/);
  });
});

describe('handleStripeWebhook', () => {
  let tmp: string;
  let store: TokenStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'czat-wh-'));
    store = new TokenStore(join(tmp, 'tokens.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws WebhookError on missing signature', () => {
    expect(() => handleStripeWebhook({
      rawBody: '{}', signatureHeader: undefined, webhookSecret: SECRET, store, config: SANCTIONS_CONFIG, now: NOW,
    })).toThrow(/Missing/);
  });

  it('mints token on checkout.session.completed (subscription)', () => {
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { price_id: 'price_pro' } } },
    });
    const header = sign(body);
    const result = handleStripeWebhook({
      rawBody: body, signatureHeader: header, webhookSecret: SECRET, store, config: SANCTIONS_CONFIG, now: NOW,
    });
    expect(result.status).toBe(200);
    expect(result.minted_token?.tier).toBe('pro');
    expect(result.minted_token?.monthly_quota).toBe(50_000);
  });

  it('mints token with credits on pay-per-report checkout', () => {
    const body = JSON.stringify({
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_2', metadata: { price_id: 'price_ppr', quantity: '10' } } },
    });
    const result = handleStripeWebhook({
      rawBody: body, signatureHeader: sign(body), webhookSecret: SECRET, store, config: DD_CONFIG, now: NOW,
    });
    expect(result.minted_token?.credits).toBe(10);
    expect(result.minted_token?.tier).toBe('pay-per-report');
  });

  it('idempotent: second checkout for same subscription refreshes existing token', () => {
    const body = JSON.stringify({
      id: 'evt_a',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_3', subscription: 'sub_3', metadata: { price_id: 'price_pro' } } },
    });
    const r1 = handleStripeWebhook({ rawBody: body, signatureHeader: sign(body), webhookSecret: SECRET, store, config: SANCTIONS_CONFIG, now: NOW });
    const r2 = handleStripeWebhook({ rawBody: body, signatureHeader: sign(body), webhookSecret: SECRET, store, config: SANCTIONS_CONFIG, now: NOW });
    expect(r2.minted_token?.token).toBe(r1.minted_token?.token);
  });

  it('skips unknown price_id with 200 OK', () => {
    const body = JSON.stringify({
      id: 'evt_3',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_x', metadata: { price_id: 'price_unknown' } } },
    });
    const result = handleStripeWebhook({ rawBody: body, signatureHeader: sign(body), webhookSecret: SECRET, store, config: SANCTIONS_CONFIG, now: NOW });
    expect(result.status).toBe(200);
    expect(result.minted_token).toBeUndefined();
  });

  it('revokes tokens on subscription.deleted', () => {
    const minted = store.mint({
      service: 'sanctions', tier: 'pro', stripe_customer_id: 'cus_4', stripe_subscription_id: 'sub_4',
      monthly_quota: 50_000, credits: null,
    });
    const body = JSON.stringify({
      id: 'evt_d',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_4', status: 'canceled' } },
    });
    const result = handleStripeWebhook({ rawBody: body, signatureHeader: sign(body), webhookSecret: SECRET, store, config: SANCTIONS_CONFIG, now: NOW });
    expect(result.status).toBe(200);
    expect(store.find(minted.token)).toBeNull();
  });

  it('resets counter on invoice.paid', () => {
    const t = store.mint({
      service: 'sanctions', tier: 'pro', stripe_customer_id: 'c', stripe_subscription_id: 'sub_5',
      monthly_quota: 50_000, credits: null,
    });
    store.consume(t.token);
    store.consume(t.token);
    const body = JSON.stringify({
      id: 'evt_i',
      type: 'invoice.paid',
      data: { object: { subscription: 'sub_5' } },
    });
    handleStripeWebhook({ rawBody: body, signatureHeader: sign(body), webhookSecret: SECRET, store, config: SANCTIONS_CONFIG, now: NOW });
    expect(store.find(t.token)!.counter).toBe(0);
  });

  it('ignores unknown event types', () => {
    const body = JSON.stringify({ id: 'evt_x', type: 'price.updated', data: { object: {} } });
    const result = handleStripeWebhook({ rawBody: body, signatureHeader: sign(body), webhookSecret: SECRET, store, config: SANCTIONS_CONFIG, now: NOW });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ignored).toBe('price.updated');
  });
});
