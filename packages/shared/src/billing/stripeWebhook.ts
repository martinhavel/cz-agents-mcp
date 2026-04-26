/**
 * Stripe webhook handler — verifies signature, dispatches events to TokenStore.
 *
 * Signature verification done manually (HMAC-SHA256 of `${timestamp}.${body}`)
 * to avoid pulling the entire `stripe` SDK (~5 MB). This implements Stripe's
 * documented `Stripe-Signature` header format:
 *   t=<unix_ts>,v1=<hmac_sha256_hex>
 *
 * Events handled:
 *   - checkout.session.completed → mint token (returned in response so frontend
 *     can show it on the success page; also email-deliverable later)
 *   - customer.subscription.deleted / .updated (cancel) → revoke all tokens for sub
 *   - invoice.paid (subscription renewal) → reset counter for existing token
 *
 * Other events ignored with 200 OK so Stripe doesn't retry.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TokenStore } from './tokenStore.js';
import type { BillingConfig, TokenRecord } from './types.js';

const SIGNATURE_TOLERANCE_S = 5 * 60;

export interface WebhookResult {
  status: number;
  body: string;
  /** When a new token was minted, the caller may want to email it. */
  minted_token?: TokenRecord;
}

export class WebhookError extends Error {
  constructor(public override readonly message: string, public readonly status: number) {
    super(message);
  }
}

/**
 * Process a raw webhook payload. Throws WebhookError on signature failure.
 * Returns minted token in result so the HTTP layer can pass it to the customer.
 */
export function handleStripeWebhook(opts: {
  rawBody: string;
  signatureHeader: string | undefined;
  webhookSecret: string;
  store: TokenStore;
  config: BillingConfig;
  /** Override "now" for tests. */
  now?: number;
}): WebhookResult {
  if (!opts.signatureHeader) throw new WebhookError('Missing Stripe-Signature header', 400);

  verifySignature(opts.rawBody, opts.signatureHeader, opts.webhookSecret, opts.now);

  let event: StripeEvent;
  try {
    event = JSON.parse(opts.rawBody) as StripeEvent;
  } catch {
    throw new WebhookError('Invalid JSON body', 400);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event, opts.store, opts.config);
    case 'customer.subscription.deleted':
    case 'customer.subscription.updated':
      return handleSubscriptionChange(event, opts.store);
    case 'invoice.paid':
      return handleInvoicePaid(event, opts.store);
    default:
      return { status: 200, body: JSON.stringify({ received: true, ignored: event.type }) };
  }
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function handleCheckoutCompleted(
  event: StripeEvent,
  store: TokenStore,
  config: BillingConfig,
): WebhookResult {
  const session = event.data.object as Record<string, unknown>;
  const customer_id = String(session['customer'] ?? '');
  if (!customer_id) {
    return { status: 200, body: JSON.stringify({ received: true, skipped: 'no customer' }) };
  }

  // Stripe Checkout includes line items. We need the price_id; for subscriptions
  // it's also accessible via the subscription object expansion. The cleanest
  // path is the `metadata.price_id` set on the Checkout Session at creation,
  // which we'll standardize on. Falls back to `subscription` lookup.
  const metadata = (session['metadata'] ?? {}) as Record<string, string>;
  const price_id = metadata['price_id'] ?? extractPriceFromSession(session);
  const subscription_id = (session['subscription'] as string | null) ?? null;
  const session_id = (session['id'] as string | null) ?? null;

  if (!price_id) {
    return { status: 200, body: JSON.stringify({ received: true, skipped: 'no price_id' }) };
  }

  const tier = config.priceTiers[price_id];
  if (!tier) {
    return { status: 200, body: JSON.stringify({ received: true, skipped: `price ${price_id} not in tier map` }) };
  }

  const quantity = Number(metadata['quantity'] ?? session['quantity'] ?? 1);
  const credits = tier.credits_per_purchase !== null ? tier.credits_per_purchase * quantity : null;

  // Idempotency: if a token already exists for this subscription, top up / refresh instead of double-mint
  if (subscription_id) {
    const existing = store.findBySubscription(subscription_id);
    if (existing) {
      store.resetCounter(existing.token);
      return {
        status: 200,
        body: JSON.stringify({ received: true, refreshed: existing.token }),
        minted_token: existing,
      };
    }
  }

  const minted = store.mint({
    service: config.service,
    tier: tier.kind,
    stripe_customer_id: customer_id,
    stripe_subscription_id: subscription_id,
    stripe_session_id: session_id,
    monthly_quota: tier.monthly_quota,
    credits,
  });

  return {
    status: 200,
    body: JSON.stringify({ received: true, minted: minted.token }),
    minted_token: minted,
  };
}

function handleSubscriptionChange(event: StripeEvent, store: TokenStore): WebhookResult {
  const sub = event.data.object as Record<string, unknown>;
  const sub_id = String(sub['id'] ?? '');
  const status = sub['status'] as string | undefined;

  // Only revoke when subscription is actually inactive
  if (
    event.type === 'customer.subscription.deleted' ||
    status === 'canceled' ||
    status === 'incomplete_expired' ||
    status === 'unpaid'
  ) {
    const revoked = store.revokeBySubscription(sub_id);
    return { status: 200, body: JSON.stringify({ received: true, revoked }) };
  }

  return { status: 200, body: JSON.stringify({ received: true, status }) };
}

function handleInvoicePaid(event: StripeEvent, store: TokenStore): WebhookResult {
  const invoice = event.data.object as Record<string, unknown>;
  const sub_id = invoice['subscription'] as string | null;
  if (!sub_id) {
    return { status: 200, body: JSON.stringify({ received: true, skipped: 'no subscription' }) };
  }
  const token = store.findBySubscription(sub_id);
  if (!token) {
    return { status: 200, body: JSON.stringify({ received: true, skipped: 'no token for subscription' }) };
  }
  store.resetCounter(token.token);
  return { status: 200, body: JSON.stringify({ received: true, reset: token.token }) };
}

function extractPriceFromSession(session: Record<string, unknown>): string | null {
  // Stripe Checkout Session has `display_items` (legacy) or `line_items` (with expand)
  const lineItems = (session['line_items'] as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data;
  if (lineItems && lineItems.length > 0) {
    return lineItems[0]?.price?.id ?? null;
  }
  return null;
}

/**
 * Verify Stripe webhook signature (HMAC-SHA256 of `${t}.${body}`).
 * Throws WebhookError on any failure. Constant-time comparison.
 */
export function verifySignature(
  rawBody: string,
  header: string,
  secret: string,
  now?: number,
): void {
  const parts = header.split(',').reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) throw new WebhookError('Malformed Stripe-Signature header', 400);

  const ts = Number(t);
  const nowS = Math.floor((now ?? Date.now()) / 1000);
  if (Number.isNaN(ts) || Math.abs(nowS - ts) > SIGNATURE_TOLERANCE_S) {
    throw new WebhookError('Stripe signature timestamp out of tolerance', 400);
  }

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(v1, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookError('Stripe signature mismatch', 400);
  }
}
