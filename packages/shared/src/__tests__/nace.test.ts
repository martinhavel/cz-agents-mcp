import { describe, it, expect } from 'vitest';
import { resolveNace } from '../nace.js';

describe('resolveNace', () => {
  it('resolves 2-digit code', () => {
    expect(resolveNace('62')).toBe('programování, poradenství a činnosti v oblasti IT');
  });

  it('resolves 5-digit code by first 2 digits', () => {
    expect(resolveNace('62010')).toBe('programování, poradenství a činnosti v oblasti IT');
  });

  it('resolves 6-digit code', () => {
    expect(resolveNace('620100')).toBe('programování, poradenství a činnosti v oblasti IT');
  });

  it('resolves sector 35 (energy)', () => {
    expect(resolveNace('35')).toBe('výroba a rozvod elektřiny, plynu a tepla');
  });

  it('resolves sector 86 (healthcare)', () => {
    expect(resolveNace('86')).toBe('zdravotní péče');
  });

  it('resolves sector 68 (real estate)', () => {
    expect(resolveNace('68200')).toBe('činnosti v oblasti nemovitostí');
  });

  it('resolves sector 46 (wholesale)', () => {
    expect(resolveNace('46900')).toBe('velkoobchod');
  });

  it('resolves sector 47 (retail)', () => {
    expect(resolveNace('47')).toBe('maloobchod');
  });

  it('returns undefined for unknown 2-digit code', () => {
    expect(resolveNace('04')).toBeUndefined();
  });

  it('returns undefined for 5-digit code with unknown 2-digit prefix', () => {
    expect(resolveNace('04000')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(resolveNace(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(resolveNace('')).toBeUndefined();
  });

  it('returns undefined for non-numeric input', () => {
    expect(resolveNace('AB')).toBeUndefined();
  });

  it('trims whitespace before resolving', () => {
    expect(resolveNace('  62  ')).toBe('programování, poradenství a činnosti v oblasti IT');
  });
});
