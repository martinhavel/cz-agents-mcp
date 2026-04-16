import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CnbClient } from '../client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(join(__dirname, 'fixtures/denni_kurz.txt'), 'utf-8');

describe('CnbClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(fixtureText, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }) as any,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('getDailyRates returns parsed sheet', async () => {
    const c = new CnbClient();
    const sheet = await c.getDailyRates();
    expect(sheet.date).toBe('2026-04-16');
    expect(sheet.sequence).toBe(73);
    expect(sheet.rates.length).toBe(32);
  });

  it('caches getDailyRates — single fetch for repeated calls with same key', async () => {
    const c = new CnbClient();
    await c.getDailyRates();
    await c.getDailyRates();
    await c.getDailyRates();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('separate cache keys for today vs explicit date', async () => {
    const c = new CnbClient();
    await c.getDailyRates();
    await c.getDailyRates('2026-04-15');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const url = fetchSpy.mock.calls[1]![0] as string;
    expect(url).toContain('date=15.04.2026'); // DD.MM.YYYY for ČNB
  });

  it('convert EUR → CZK uses sheet rate', async () => {
    const c = new CnbClient();
    const r = await c.convert(100, 'EUR', 'CZK');
    // EUR=24.605, amount=1 → 100 EUR = 2460.5 CZK
    expect(r.amount).toBe(2460.5);
    expect(r.from).toBe('EUR');
    expect(r.to).toBe('CZK');
    expect(r.rate).toBe(24.605);
    expect(r.sheetDate).toBe('2026-04-16');
  });

  it('convert CZK → USD inverts rate', async () => {
    const c = new CnbClient();
    const r = await c.convert(1000, 'CZK', 'USD');
    // USD=22.987 → 1000/22.987 ≈ 43.50
    expect(r.amount).toBeCloseTo(43.5, 1);
  });

  it('convert handles per-100 currencies (JPY)', async () => {
    const c = new CnbClient();
    const r = await c.convert(10_000, 'JPY', 'CZK');
    // JPY: 100 JPY = 14.982 CZK → 10000 JPY = 1498.2 CZK
    expect(r.amount).toBeCloseTo(1498.2, 1);
  });

  it('convert USD → EUR via CZK triangulation', async () => {
    const c = new CnbClient();
    const r = await c.convert(100, 'USD', 'EUR');
    // 100 USD * (22.987 / 24.605) ≈ 93.42 EUR
    expect(r.amount).toBeCloseTo(93.42, 1);
  });

  it('convert is case-insensitive for currency codes', async () => {
    const c = new CnbClient();
    const r = await c.convert(1, 'eur', 'czk');
    expect(r.from).toBe('EUR');
    expect(r.to).toBe('CZK');
  });

  it('convert throws for unknown currency', async () => {
    const c = new CnbClient();
    await expect(c.convert(1, 'ZZZ', 'CZK')).rejects.toThrow(/ZZZ not found/);
  });

  it('CZK → CZK is identity', async () => {
    const c = new CnbClient();
    const r = await c.convert(42, 'CZK', 'CZK');
    expect(r.amount).toBe(42);
    expect(r.rate).toBe(1);
  });
});
