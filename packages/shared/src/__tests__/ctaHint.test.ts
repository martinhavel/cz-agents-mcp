import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRequestIp,
  getCTAHint,
  getCTAHintBlocks,
  resetCTAHintState,
  setRequestIp,
} from '../icoTracker.js';

const ESCALATED_HINT =
  '💡 Tuhle firmu si u nás můžeš nechat hlídat — použij nástroj watch_entity.';

describe('getCTAHint', () => {
  beforeEach(() => {
    resetCTAHintState();
    clearRequestIp();
  });

  afterEach(() => {
    resetCTAHintState();
    clearRequestIp();
    vi.unstubAllEnvs();
  });

  it('session-scoped: silent below threshold, fires exactly once at it', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '3');

    expect(getCTAHint('26168685', 'sess-A')).toBe(''); // 1st
    expect(getCTAHint('26168685', 'sess-A')).toBe(''); // 2nd
    expect(getCTAHint('26168685', 'sess-A')).toBe(ESCALATED_HINT); // 3rd = repeat
    expect(getCTAHint('26168685', 'sess-A')).toBe(''); // 4th — silent again
  });

  it('session scope is race-free w.r.t. the request IP', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');

    // A different (or concurrent/overwritten) IP per call must NOT reset the
    // per-session counter — scope is the sessionId, not the racy module-level IP.
    setRequestIp('203.0.113.1');
    expect(getCTAHint('26168685', 'sess-X')).toBe('');
    setRequestIp('198.51.100.9');
    expect(getCTAHint('26168685', 'sess-X')).toBe(ESCALATED_HINT);
  });

  it('separate sessions track independently', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');

    expect(getCTAHint('26168685', 'sess-A')).toBe('');
    expect(getCTAHint('26168685', 'sess-B')).toBe(''); // different session, own counter
    expect(getCTAHint('26168685', 'sess-A')).toBe(ESCALATED_HINT);
    expect(getCTAHint('26168685', 'sess-B')).toBe(ESCALATED_HINT);
  });

  it('falls back to anonymized IP prefix when no session scope (stdio)', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe('');
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT);
  });

  it('getCTAHintBlocks returns a block only when the hint fires', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');

    expect(getCTAHintBlocks('26168685', 'sess-Q')).toEqual([]);
    expect(getCTAHintBlocks('26168685', 'sess-Q')).toEqual([
      { type: 'text', text: ESCALATED_HINT },
    ]);
    expect(getCTAHintBlocks('26168685', 'sess-Q')).toEqual([]);
  });

  it('reset helper clears repeat state', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');

    expect(getCTAHint('26168685', 'sess-R')).toBe('');
    expect(getCTAHint('26168685', 'sess-R')).toBe(ESCALATED_HINT);

    resetCTAHintState();

    expect(getCTAHint('26168685', 'sess-R')).toBe('');
    expect(getCTAHint('26168685', 'sess-R')).toBe(ESCALATED_HINT);
  });
});
