import { describe, it, expect } from 'vitest';
import { isoDateSchema } from '../server.js';

describe('isoDateSchema', () => {
  it('accepts a valid calendar date', () => {
    expect(isoDateSchema.safeParse('2026-04-16').success).toBe(true);
    expect(isoDateSchema.safeParse('2024-02-29').success).toBe(true); // leap day
  });

  it('rejects a format-valid but impossible calendar date', () => {
    expect(isoDateSchema.safeParse('2026-13-45').success).toBe(false); // month 13
    expect(isoDateSchema.safeParse('2026-02-30').success).toBe(false); // Feb 30
    expect(isoDateSchema.safeParse('2025-02-29').success).toBe(false); // non-leap
    expect(isoDateSchema.safeParse('2026-00-10').success).toBe(false); // month 0
  });

  it('rejects a wrong shape', () => {
    expect(isoDateSchema.safeParse('16.04.2026').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-4-6').success).toBe(false);
  });
});
