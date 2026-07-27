import { afterEach, describe, expect, it } from 'vitest';
import {
  getX402Metrics,
  resetX402Metrics,
  x402CheckRejectionsTotal,
  x402FacilitatorErrorsTotal,
  x402OffersTotal,
  x402SettlementsTotal,
} from '../metrics.js';

afterEach(() => {
  resetX402Metrics();
});

describe('x402 metrics — formát výstupu', () => {
  it('prázdné čítače vydají jen HELP/TYPE hlavičky, žádné vzorky', () => {
    const text = getX402Metrics();
    expect(text).toContain('# HELP cz_agents_x402_offers_total');
    expect(text).toContain('# TYPE cz_agents_x402_offers_total counter');
    expect(text).toContain('# HELP cz_agents_x402_settlements_total');
    expect(text).toContain('# HELP cz_agents_x402_facilitator_errors_total');
    expect(text).toContain('# HELP cz_agents_x402_check_rejections_total');
    // žádný řádek se vzorkem (obsahuje '{' a hodnotu za '}')
    expect(text).not.toMatch(/_total\{[^}]*\} \d/);
  });

  it('offers_total: inkrementuje podle (service,tool) a sčítá opakované volání', () => {
    x402OffersTotal.inc({ service: 'sanctions', tool: 'rescreen_portfolio' });
    x402OffersTotal.inc({ service: 'sanctions', tool: 'rescreen_portfolio' });
    x402OffersTotal.inc({ service: 'payqr', tool: 'batch_generate' });
    const text = getX402Metrics();
    expect(text).toContain('cz_agents_x402_offers_total{service="sanctions",tool="rescreen_portfolio"} 2');
    expect(text).toContain('cz_agents_x402_offers_total{service="payqr",tool="batch_generate"} 1');
  });

  it('settlements_total: rozlišuje podle result labelu', () => {
    x402SettlementsTotal.inc({ service: 'sanctions', tool: 'rescreen_portfolio', result: 'success' });
    x402SettlementsTotal.inc({ service: 'sanctions', tool: 'rescreen_portfolio', result: 'failure' });
    x402SettlementsTotal.inc({ service: 'sanctions', tool: 'rescreen_portfolio', result: 'success' });
    const text = getX402Metrics();
    expect(text).toContain('cz_agents_x402_settlements_total{service="sanctions",tool="rescreen_portfolio",result="success"} 2');
    expect(text).toContain('cz_agents_x402_settlements_total{service="sanctions",tool="rescreen_portfolio",result="failure"} 1');
  });

  it('facilitator_errors_total: rozlišuje podle phase', () => {
    x402FacilitatorErrorsTotal.inc({ service: 'sanctions', phase: 'verify' });
    x402FacilitatorErrorsTotal.inc({ service: 'sanctions', phase: 'settle' });
    const text = getX402Metrics();
    expect(text).toContain('cz_agents_x402_facilitator_errors_total{service="sanctions",phase="verify"} 1');
    expect(text).toContain('cz_agents_x402_facilitator_errors_total{service="sanctions",phase="settle"} 1');
  });

  it('check_rejections_total: rozlišuje podle check', () => {
    x402CheckRejectionsTotal.inc({ service: 'sanctions', check: 'replay' });
    x402CheckRejectionsTotal.inc({ service: 'sanctions', check: 'replay' });
    x402CheckRejectionsTotal.inc({ service: 'sanctions', check: 'amount_mismatch' });
    const text = getX402Metrics();
    expect(text).toContain('cz_agents_x402_check_rejections_total{service="sanctions",check="replay"} 2');
    expect(text).toContain('cz_agents_x402_check_rejections_total{service="sanctions",check="amount_mismatch"} 1');
  });

  it('chybějící label při inc() vyhodí chybu se jménem toho labelu', () => {
    expect(() => x402OffersTotal.inc({ service: 'sanctions' } as never)).toThrow(/tool/);
  });

  it('escapuje uvozovky a zpětná lomítka v hodnotě labelu', () => {
    x402CheckRejectionsTotal.inc({ service: 'sanctions', check: 'weird"value\\here' });
    const text = getX402Metrics();
    expect(text).toContain('check="weird\\"value\\\\here"');
  });

  it('resetX402Metrics() vyprázdní všechny čtyři série', () => {
    x402OffersTotal.inc({ service: 'sanctions', tool: 'rescreen_portfolio' });
    x402SettlementsTotal.inc({ service: 'sanctions', tool: 'rescreen_portfolio', result: 'success' });
    resetX402Metrics();
    const text = getX402Metrics();
    expect(text).not.toMatch(/_total\{[^}]*\} \d/);
  });
});
