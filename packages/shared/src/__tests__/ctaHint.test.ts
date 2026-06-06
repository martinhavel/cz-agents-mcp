import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRequestIp, getCTAHint, resetCTAHintState, setRequestIp } from '../icoTracker.js';

const DEFAULT_HINT =
  "💡 watch_entity('26168685') ohlídá změny (statutár, adresa, vlastník, insolvence) za vás — 1 firma zdarma.";
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

  it('returns the default value-framed hint', () => {
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe(DEFAULT_HINT);
  });

  it('returns the escalation hint at the configured threshold', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe(DEFAULT_HINT);
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT);
  });

  it('frequency-caps the escalation hint after it has been shown once', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe(DEFAULT_HINT);
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT);
    expect(getCTAHint('26168685')).toBe(DEFAULT_HINT);
    expect(getCTAHint('26168685')).toBe(DEFAULT_HINT);
  });

  it('reset helper clears repeat state', () => {
    vi.stubEnv('CTA_ESCALATION_THRESHOLD', '2');
    setRequestIp('203.0.113.10');

    expect(getCTAHint('26168685')).toBe(DEFAULT_HINT);
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT);

    resetCTAHintState();

    expect(getCTAHint('26168685')).toBe(DEFAULT_HINT);
    expect(getCTAHint('26168685')).toBe(ESCALATED_HINT);
  });
});
