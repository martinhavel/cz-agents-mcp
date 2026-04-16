import { describe, it, expect } from 'vitest';
import { formatIco, isValidIco, validateIcoInput } from '../ico.js';

describe('formatIco', () => {
  it('zero-pads 7-digit IČO to 8', () => {
    expect(formatIco('1234567')).toBe('01234567');
  });

  it('strips whitespace', () => {
    expect(formatIco('  26168685  ')).toBe('26168685');
  });

  it('accepts numeric input', () => {
    expect(formatIco(26168685)).toBe('26168685');
  });

  it('strips leading zeros before re-padding', () => {
    expect(formatIco('00000001')).toBe('00000001');
  });

  it('throws on non-numeric', () => {
    expect(() => formatIco('abc123')).toThrow(/Invalid IČO/);
  });

  it('throws on >8 digits', () => {
    expect(() => formatIco('123456789')).toThrow(/Invalid IČO/);
  });
});

describe('isValidIco (MOD11 checksum)', () => {
  it.each([
    ['26168685', true],  // Seznam.cz, a.s.
    ['27082440', true],  // Alza.cz a.s.
    ['25596641', true],  // Rohlik.cz s.r.o.
    ['48136450', true],  // ČEZ a.s.
  ])('accepts real Czech IČO %s', (ico, expected) => {
    expect(isValidIco(ico)).toBe(expected);
  });

  it.each([
    ['12345678'], // random, fails MOD11
    ['00000000'],
    ['99999999'],
  ])('rejects invalid checksum %s', (ico) => {
    expect(isValidIco(ico)).toBe(false);
  });

  it('returns false on malformed input (no throw)', () => {
    expect(isValidIco('not-a-number')).toBe(false);
    expect(isValidIco('')).toBe(false);
  });
});

describe('validateIcoInput', () => {
  it('returns normalized IČO on success', () => {
    expect(validateIcoInput('26168685')).toBe('26168685');
    expect(validateIcoInput(26168685)).toBe('26168685');
  });

  it('throws on invalid checksum', () => {
    expect(() => validateIcoInput('12345678')).toThrow(/checksum/);
  });

  it('throws on non-string/number', () => {
    expect(() => validateIcoInput({} as any)).toThrow(/must be string or number/);
    expect(() => validateIcoInput(null as any)).toThrow(/must be string or number/);
  });
});
