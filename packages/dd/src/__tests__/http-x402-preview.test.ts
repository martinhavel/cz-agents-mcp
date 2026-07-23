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
});
