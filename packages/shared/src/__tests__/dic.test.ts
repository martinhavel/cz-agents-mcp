import { describe, it, expect } from 'vitest';
import { formatDic, isValidDic, icoFromDic } from '../dic.js';

describe('formatDic', () => {
  it('uppercases + trims', () => {
    expect(formatDic('  cz26168685  ')).toBe('CZ26168685');
    expect(formatDic('cz 26168685')).toBe('CZ26168685');
  });
});

describe('isValidDic', () => {
  it('accepts valid legal-entity DIČ (CZ + 8-digit IČO with MOD11)', () => {
    expect(isValidDic('CZ26168685')).toBe(true);
    expect(isValidDic('cz27082440')).toBe(true);
  });

  it('rejects DIČ with invalid 8-digit checksum', () => {
    expect(isValidDic('CZ12345678')).toBe(false);
  });

  it('accepts 9-10 digit personal DIČ (format-only, no checksum)', () => {
    expect(isValidDic('CZ1234567890')).toBe(true);
    expect(isValidDic('CZ123456789')).toBe(true);
  });

  it('rejects missing CZ prefix', () => {
    expect(isValidDic('26168685')).toBe(false);
    expect(isValidDic('SK26168685')).toBe(false);
  });

  it('rejects non-numeric tail', () => {
    expect(isValidDic('CZABCDEFGH')).toBe(false);
  });

  it('rejects too short / too long', () => {
    expect(isValidDic('CZ1234567')).toBe(false);   // 7 digits
    expect(isValidDic('CZ12345678901')).toBe(false); // 11 digits
  });
});

describe('icoFromDic', () => {
  it('extracts IČO from CZ + 8-digit DIČ', () => {
    expect(icoFromDic('CZ26168685')).toBe('26168685');
  });

  it('returns null for personal DIČ (9-10 digits)', () => {
    expect(icoFromDic('CZ1234567890')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(icoFromDic('CZ12345')).toBeNull();
    expect(icoFromDic('not-a-dic')).toBeNull();
  });
});
