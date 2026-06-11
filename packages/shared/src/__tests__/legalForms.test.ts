import { describe, it, expect } from 'vitest';
import { resolveLegalForm } from '../legalForms.js';

describe('resolveLegalForm', () => {
  it('resolves known ARES legal form codes', () => {
    expect(resolveLegalForm('112')).toBe('s.r.o.');
    expect(resolveLegalForm('121')).toBe('a.s.');
  });

  it('passes through unknown numeric codes', () => {
    expect(resolveLegalForm('999')).toBe('999');
  });

  it('passes through non-numeric values', () => {
    expect(resolveLegalForm('spolek')).toBe('spolek');
  });
});
