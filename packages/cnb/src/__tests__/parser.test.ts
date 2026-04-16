import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCnbDailyText } from '../client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(join(__dirname, 'fixtures/denni_kurz.txt'), 'utf-8');

describe('parseCnbDailyText', () => {
  it('parses date and sequence from header', () => {
    const sheet = parseCnbDailyText(fixtureText);
    expect(sheet.date).toBe('2026-04-16');
    expect(sheet.sequence).toBe(73);
  });

  it('parses all rates (32 rows in fixture)', () => {
    const sheet = parseCnbDailyText(fixtureText);
    expect(sheet.rates.length).toBe(32);
  });

  it('parses USD/EUR/GBP/JPY with correct structure', () => {
    const sheet = parseCnbDailyText(fixtureText);
    const usd = sheet.rates.find((r) => r.code === 'USD');
    expect(usd).toMatchObject({ code: 'USD', amount: 1, rate: 22.987, country: 'USA' });

    const eur = sheet.rates.find((r) => r.code === 'EUR');
    expect(eur?.rate).toBe(24.605);

    const jpy = sheet.rates.find((r) => r.code === 'JPY');
    expect(jpy?.amount).toBe(100); // JPY is quoted per 100

    const gbp = sheet.rates.find((r) => r.code === 'GBP');
    expect(gbp?.rate).toBe(28.876);
  });

  it('converts comma decimal separator to dot', () => {
    const sheet = parseCnbDailyText(fixtureText);
    for (const r of sheet.rates) {
      expect(Number.isFinite(r.rate)).toBe(true);
      expect(Number.isFinite(r.amount)).toBe(true);
    }
  });

  it('uppercases ISO codes', () => {
    const sheet = parseCnbDailyText(fixtureText);
    expect(sheet.rates.every((r) => r.code === r.code.toUpperCase())).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const crlf = fixtureText.replace(/\n/g, '\r\n');
    const sheet = parseCnbDailyText(crlf);
    expect(sheet.date).toBe('2026-04-16');
    expect(sheet.rates.length).toBe(32);
  });

  it('throws on malformed header', () => {
    expect(() => parseCnbDailyText('garbage\nzeme|mena\n')).toThrow(/Unexpected ČNB header/);
  });

  it('throws on too-short input', () => {
    expect(() => parseCnbDailyText('')).toThrow(/too short/);
  });

  it('skips malformed data rows gracefully', () => {
    const text = '16.04.2026 #73\nzemě|měna|množství|kód|kurz\nbadrow\nUSA|dolar|1|USD|22,987\n';
    const sheet = parseCnbDailyText(text);
    expect(sheet.rates.length).toBe(1);
    expect(sheet.rates[0]!.code).toBe('USD');
  });
});
