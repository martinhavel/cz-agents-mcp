import { describe, it, expect } from 'vitest';
import { classifyPersonRisk } from '../vr-person-risk.js';

describe('classifyPersonRisk', () => {
  it('shell-factory: N=10, L=8, batch=7, ln=0.8', () => {
    const result = classifyPersonRisk({ N: 10, L: 8, batch: 7, ln: 0.8 });

    expect(result.classification).toBe('shell-factory');
    expect(result.score).toBe(67);
    expect(result.requires_review).toBe(false);
  });

  it('serial-liquidation: N=25, L=25, batch=2, ln=1.0', () => {
    const result = classifyPersonRisk({ N: 25, L: 25, batch: 2, ln: 1.0 });

    expect(result.classification).toBe('serial-liquidation');
    expect(result.score).toBe(80);
    expect(result.requires_review).toBe(false);
  });

  it('mass-nominee: N=458, L=100, batch=5', () => {
    const result = classifyPersonRisk({ N: 458, L: 100, batch: 5, ln: 100 / 458 });

    expect(result.classification).toBe('mass-nominee');
    expect(result.requires_review).toBe(true);
  });

  it('clean-zero: N=4, L=0, batch=1, ln=0.0', () => {
    const result = classifyPersonRisk({ N: 4, L: 0, batch: 1, ln: 0.0 });

    expect(result.classification).toBe('clean');
    expect(result.score).toBe(0);
    expect(result.requires_review).toBe(false);
  });

  it('clean-churn: N=6, L=4, batch=1, ln=0.67', () => {
    const result = classifyPersonRisk({ N: 6, L: 4, batch: 1, ln: 0.67 });

    expect(result.classification).toBe('clean');
    expect(result.score).toBe(0);
    expect(result.requires_review).toBe(false);
  });
});
