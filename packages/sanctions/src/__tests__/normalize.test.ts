import { describe, it, expect } from 'vitest';
import { normalizeName, tokenSet } from '../normalize.js';

describe('normalizeName', () => {
  it('lowercases', () => {
    expect(normalizeName('John Smith')).toBe('john smith');
  });

  it('strips diacritics', () => {
    expect(normalizeName('Pavlína Šťastná')).toBe('pavlina stastna');
  });

  it('transliterates cyrillic', () => {
    expect(normalizeName('Владимир')).toBe('vladimir');
    expect(normalizeName('Путин')).toBe('putin');
  });

  it('drops punctuation', () => {
    expect(normalizeName('Smith, John A.')).toBe('smith john a');
  });

  it('collapses whitespace', () => {
    expect(normalizeName('  John   Smith  ')).toBe('john smith');
  });

  it('returns empty for empty input', () => {
    expect(normalizeName('')).toBe('');
  });
});

describe('tokenSet', () => {
  it('splits, dedupes, sorts', () => {
    expect(tokenSet('John Smith John')).toEqual(['john', 'smith']);
  });

  it('handles empty input', () => {
    expect(tokenSet('')).toEqual([]);
  });

  it('lets reordered names match', () => {
    expect(tokenSet('Smith, John')).toEqual(tokenSet('John Smith'));
  });
});
