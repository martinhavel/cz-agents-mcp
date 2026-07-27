/**
 * `createX402MetricsListener` je to jediné, co spojuje `metrics.ts` se
 * skutečným provozem — bez něj `getX402Metrics()` navěky vrací jen prázdné
 * HELP/TYPE hlavičky, ať se v produkci děje cokoli. Testuje se přes SKUTEČNOU
 * bránu (`createX402Gate`) a skutečné `redeem()`/`offer()` volání, ne přes
 * ručně sestavené `GateEvent` objekty — zajímá nás, že čítače se reálně HÝBOU
 * při reálném provozu brány, ne že funkce `inc()` sama o sobě funguje (to už
 * hlídá `metrics.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createX402Gate, createX402MetricsListener, priceToAtomic } from '../gate.js';
import { loadX402Config } from '../config.js';
import type { Facilitator } from '../facilitator.js';
import {
  getX402Metrics, resetX402Metrics,
  x402OffersTotal, x402SettlementsTotal, x402FacilitatorErrorsTotal, x402CheckRejectionsTotal,
} from '../metrics.js';

const NOW = 1_800_000_000_000;
const nowSec = Math.floor(NOW / 1000);
const PAY_TO = '0x1111111111111111111111111111111111111111';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NETWORK = 'eip155:84532';

const config = () =>
  loadX402Config({
    X402_ENABLED: 'true',
    X402_NETWORK: NETWORK,
    X402_ASSET: ASSET,
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR_URL: 'https://x402.org/facilitator',
    X402_PRICE_USD: '0.005',
  })!;

const resourceUrl = (r: string) => `https://cz-agents.dev/x402/${encodeURIComponent(r)}`;

const goodPayload = (resource: string) => ({
  x402Version: 2,
  resource: { url: resourceUrl(resource), description: 'x', mimeType: 'application/json' },
  accepted: { network: NETWORK, asset: ASSET },
  payload: {
    authorization: {
      from: '0x2222222222222222222222222222222222222222',
      to: PAY_TO,
      value: priceToAtomic(0.005),
      validAfter: String(nowSec - 60),
      validBefore: String(nowSec + 600),
      nonce: '0x' + 'ab'.repeat(32),
    },
  },
});

const facilitator = (over: Partial<Facilitator> = {}): Facilitator => ({
  supported: vi.fn().mockResolvedValue({ kinds: [] }),
  verify: vi.fn().mockResolvedValue({ isValid: true, payer: '0xAe59' }),
  settle: vi.fn().mockResolvedValue({ success: true, transaction: '0xtx', network: NETWORK }),
  ...over,
});

afterEach(() => {
  resetX402Metrics();
});

describe('createX402MetricsListener napojený na skutečnou bránu', () => {
  it('offer() inkrementuje x402_offers_total pro (service,tool) zvolené VOLAJÍCÍM', async () => {
    const gate = createX402Gate(config(), facilitator(), {
      onEvent: createX402MetricsListener({ service: 'sanctions', tool: 'rescreen_portfolio' }),
    });
    expect(getX402Metrics()).not.toMatch(/x402_offers_total\{[^}]*\} \d/);
    gate.offer('t:1');
    gate.offer('t:1');
    expect(getX402Metrics()).toContain('cz_agents_x402_offers_total{service="sanctions",tool="rescreen_portfolio"} 2');
  });

  it('úspěšný redeem inkrementuje settlements_total{result="success"}', async () => {
    const gate = createX402Gate(config(), facilitator(), {
      onEvent: createX402MetricsListener({ service: 'payqr', tool: 'qr_payment_batch' }),
    });
    const result = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(result.released).toBe(true);
    expect(getX402Metrics()).toContain('cz_agents_x402_settlements_total{service="payqr",tool="qr_payment_batch",result="success"} 1');
  });

  it('resource_mismatch (naše kontrola) inkrementuje check_rejections_total{check}', async () => {
    const gate = createX402Gate(config(), facilitator(), {
      onEvent: createX402MetricsListener({ service: 'sanctions', tool: 'rescreen_portfolio' }),
    });
    const result = await gate.redeem({ payload: goodPayload('t:levny'), expectedResource: 't:drahy', now: NOW });
    expect(result.released).toBe(false);
    expect(getX402Metrics()).toContain('cz_agents_x402_check_rejections_total{service="sanctions",check="resource_mismatch"} 1');
  });

  it('facilitátor odmítne platbu → settlements_total{result="verify_failed"}', async () => {
    const f = facilitator({ verify: vi.fn().mockResolvedValue({ isValid: false, invalidReason: 'invalid_signature' }) });
    const gate = createX402Gate(config(), f, {
      onEvent: createX402MetricsListener({ service: 'sanctions', tool: 'rescreen_portfolio' }),
    });
    await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(getX402Metrics()).toContain('cz_agents_x402_settlements_total{service="sanctions",tool="rescreen_portfolio",result="verify_failed"} 1');
  });

  it('settle selže → settlements_total{result="settle_failed"} a chybová hláška z facilitátoru se odloguje', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = facilitator({ settle: vi.fn().mockResolvedValue({ success: false, errorReason: 'invalid_exact_evm_transaction_failed', transaction: '', network: NETWORK }) });
    const gate = createX402Gate(config(), f, {
      onEvent: createX402MetricsListener({ service: 'sanctions', tool: 'rescreen_portfolio' }),
    });
    await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(getX402Metrics()).toContain('cz_agents_x402_settlements_total{service="sanctions",tool="rescreen_portfolio",result="settle_failed"} 1');
    // Přesně tohle chybělo 27. 7.: kód facilitátoru se ztratil. Teď musí být v logu.
    expect(errorLog.mock.calls.some((call) => call.join(' ').includes('invalid_exact_evm_transaction_failed'))).toBe(true);
    errorLog.mockRestore();
  });

  it('výpadek facilitátoru při verify → facilitator_errors_total{phase="verify"} a settlements_total{result="facilitator_unavailable"}', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = facilitator({ verify: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const gate = createX402Gate(config(), f, {
      onEvent: createX402MetricsListener({ service: 'sanctions', tool: 'rescreen_portfolio' }),
    });
    await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    const text = getX402Metrics();
    expect(text).toContain('cz_agents_x402_facilitator_errors_total{service="sanctions",phase="verify"} 1');
    expect(text).toContain('cz_agents_x402_settlements_total{service="sanctions",tool="rescreen_portfolio",result="facilitator_unavailable"} 1');
    expect(errorLog.mock.calls.some((call) => call.join(' ').includes('ECONNREFUSED'))).toBe(true);
    errorLog.mockRestore();
  });

  it('výpadek facilitátoru při settle → facilitator_errors_total{phase="settle"} a settlements_total{result="settlement_unknown"}', async () => {
    const f = facilitator({ settle: vi.fn().mockRejectedValue(new Error('timeout')) });
    const gate = createX402Gate(config(), f, {
      onEvent: createX402MetricsListener({ service: 'sanctions', tool: 'rescreen_portfolio' }),
    });
    await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    const text = getX402Metrics();
    expect(text).toContain('cz_agents_x402_facilitator_errors_total{service="sanctions",phase="settle"} 1');
    expect(text).toContain('cz_agents_x402_settlements_total{service="sanctions",tool="rescreen_portfolio",result="settlement_unknown"} 1');
  });

  it('bez posluchače (options.onEvent vynechané) brána funguje beze změny — jen nic neměří', async () => {
    const gate = createX402Gate(config(), facilitator());
    const result = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(result.released).toBe(true);
    expect(getX402Metrics()).not.toMatch(/_total\{[^}]*\} \d/);
  });
});

describe('přímé volání inc() přes existující čítače (referenční, ne duplicitní)', () => {
  it('sanity: importované čítače jsou tytéž instance, které renderuje getX402Metrics()', () => {
    x402OffersTotal.inc({ service: 'x', tool: 'y' });
    x402SettlementsTotal.inc({ service: 'x', tool: 'y', result: 'z' });
    x402FacilitatorErrorsTotal.inc({ service: 'x', phase: 'verify' });
    x402CheckRejectionsTotal.inc({ service: 'x', check: 'replay' });
    const text = getX402Metrics();
    expect(text).toContain('cz_agents_x402_offers_total{service="x",tool="y"} 1');
    expect(text).toContain('cz_agents_x402_settlements_total{service="x",tool="y",result="z"} 1');
    expect(text).toContain('cz_agents_x402_facilitator_errors_total{service="x",phase="verify"} 1');
    expect(text).toContain('cz_agents_x402_check_rejections_total{service="x",check="replay"} 1');
  });
});
