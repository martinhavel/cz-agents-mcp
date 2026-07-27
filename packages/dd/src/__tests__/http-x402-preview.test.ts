import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('DD x402 preview HTTP contract', () => {
  const source = readFileSync(new URL('../http.ts', import.meta.url), 'utf8');

  it('returns the opaque request id required by the intent endpoint', () => {
    expect(source).toContain('intent_request_id:decision.requestId');
  });

  it('rate-limits the preview intent before examining it', () => {
    const limiter = source.indexOf('if (!limiter(req, res)) return true;');
    const intent = source.indexOf("if (url.pathname==='/v1/payment-options/x402/intent')");
    expect(limiter).toBeGreaterThan(-1);
    expect(intent).toBeGreaterThan(limiter);
  });

  it('only exposes the preview for the full DD report gate', () => {
    expect(source).toContain("lookup.tool==='get_dd_report' && lookup.depth==='ddplus'");
    expect(source).toContain("message:'x402 preview only: no payment is accepted or taken.'");
  });

  it('records the declaration before refusing an anonymous one', () => {
    // Order is the contract: an anonymous attempt is a weak signal we keep, not
    // a request we drop. Refusing first would erase the only trace that someone
    // without an identity wanted the report at all.
    const record = source.indexOf('recordX402PreviewIntent(account.accountPseudonym,requestId');
    const refuse = source.indexOf("account.identityClass!=='identified'");
    expect(record).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(record);
    expect(source).toContain("jsonErr(res,401,'identity_required'");
  });

  it('sends an anonymous caller to a free credential, never to the price list', () => {
    const gate = source.indexOf("account.identityClass!=='identified'");
    const message = source.indexOf('A free credential is available at ${X402_PREVIEW_IDENTITY_URL}');
    expect(message).toBeGreaterThan(gate);
    expect(source).toContain("X402_PREVIEW_IDENTITY_URL=process.env.X402_PREVIEW_IDENTITY_URL ??");
  });

  it('keeps the pre-existing intent metric series and adds the split beside it', () => {
    expect(source).toContain('cz_agents_x402_preview_events_total{kind="intent"} ${counts.intents}');
    expect(source).toContain('kind="intent_anonymous"');
    expect(source).toContain('kind="intent_identified"');
  });
});
