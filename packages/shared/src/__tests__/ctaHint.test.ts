import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRequestIp,
  getCTAHint,
  getCTAHintBlocks,
  resetCTAHintState,
  setRequestIp,
} from '../icoTracker.js';

const ESCALATED_HINT =
  '💡 Tahle firma se vám asi hodí hlídat — ať ji nemusíte kontrolovat ručně. watch_entity, 1 zdarma.';

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

  it('stays silent on casual one-off lookups (below threshold)', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '3');
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe('');
    expect(getCTAHint('26168685')).toBe('');
  });

  it('fires the escalation hint exactly once at the repeat threshold', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '3');
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe(''); // 1st lookup
    expect(getCTAHint('26168685')).toBe(''); // 2nd lookup
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT); // 3rd = repeated interest
    expect(getCTAHint('26168685')).toBe(''); // 4th — silent again
  });

  it('getCTAHintBlocks returns a block only when the hint fires', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');
    setRequestIp('203.0.113.10');

    expect(getCTAHintBlocks('26168685')).toEqual([]);
    expect(getCTAHintBlocks('26168685')).toEqual([{ type: 'text', text: ESCALATED_HINT }]);
    expect(getCTAHintBlocks('26168685')).toEqual([]);
  });

  it('tracks repeat interest per IČO independently', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe('');
    expect(getCTAHint('00000019')).toBe(''); // different IČO, own counter
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT);
    expect(getCTAHint('00000019')).toBe(ESCALATED_HINT);
  });

  it('reset helper clears repeat state', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe('');
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT);

    resetCTAHintState();

    expect(getCTAHint('26168685')).toBe('');
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT);
  });
});
