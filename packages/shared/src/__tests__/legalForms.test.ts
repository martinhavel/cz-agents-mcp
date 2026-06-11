import { describe, it, expect } from 'vitest';
import { resolveLegalForm } from '../legalForms.js';

describe('resolveLegalForm', () => {
  it('resolves known ARES legal form codes', () => {
    expect(resolveLegalForm('112')).toBe('s.r.o.');
    expect(resolveLegalForm('121')).toBe('a.s.');
  });

  it('resolves numeric codes present in codebook', () => {
    expect(resolveLegalForm('999')).toBe('Ostatní');
    // truly unknown code falls back to the code itself
    expect(resolveLegalForm('998')).toBe('998');
  });

  it('passes through non-numeric values', () => {
    expect(resolveLegalForm('spolek')).toBe('spolek');
  });
});
