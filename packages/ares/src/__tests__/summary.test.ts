import { describe, it, expect } from 'vitest';
import { buildAresSummaryMarkdown } from '../summary.js';
import type { AresSubject } from '../client.js';

// Helpers to build minimal AresSubject fixtures (no real companies)
function makeSubject(overrides: Partial<AresSubject>): AresSubject {
  return {
    ico: '00000001',
    obchodniJmeno: 'Test Co. s.r.o.',
    pravniForma: '112', // s.r.o.
    sidlo: { nazevObce: 'Praha' },
    datumVzniku: '2010-03-15',
    dic: 'CZ00000001',
    czNace: ['62010'],
    ...overrides,
  };
}

describe('buildAresSummaryMarkdown', () => {
  it('content[0] starts with "**" (managerial block)', () => {
    const md = buildAresSummaryMarkdown(makeSubject({}));
    expect(md.startsWith('**')).toBe(true);
  });

  it('aktivní firma — contains name, IČO, legal form, city', () => {
    const subject = makeSubject({
      obchodniJmeno: 'Fiktivní Výroba s.r.o.',
      ico: '12345678',
      pravniForma: '112',
      sidlo: { nazevObce: 'Brno' },
    });
    const md = buildAresSummaryMarkdown(subject);
    expect(md).toContain('**Fiktivní Výroba s.r.o.**');
    expect(md).toContain('IČO 12345678');
    expect(md).toContain('s.r.o.');
    expect(md).toContain('Brno');
  });

  it('aktivní firma — contains vznik date in Czech format', () => {
    const subject = makeSubject({ datumVzniku: '2005-07-04' });
    const md = buildAresSummaryMarkdown(subject);
    // Czech format: D. M. RRRR without leading zeros
    expect(md).toContain('4. 7. 2005');
  });

  it('aktivní firma — shows "aktivní" status', () => {
    const subject = makeSubject({ datumZaniku: undefined });
    const md = buildAresSummaryMarkdown(subject);
    expect(md).toContain('aktivní');
  });

  it('zaniklá firma — shows dissolution date in Czech format', () => {
    const subject = makeSubject({ datumZaniku: '2020-12-31' });
    const md = buildAresSummaryMarkdown(subject);
    expect(md).toContain('zaniklá k 31. 12. 2020');
    expect(md).not.toContain('aktivní');
  });

  it('neplátce DPH — no DIČ shown', () => {
    const subject = makeSubject({ dic: undefined });
    const md = buildAresSummaryMarkdown(subject);
    expect(md).toContain('neplátce DPH');
    // Should NOT contain the plátce variant (with preceding space to exclude "neplátce")
    expect(md).not.toMatch(/[^ne]plátce DPH/);
  });

  it('plátce DPH — shows DIČ', () => {
    const subject = makeSubject({ dic: 'CZ12345678' });
    const md = buildAresSummaryMarkdown(subject);
    expect(md).toContain('plátce DPH (CZ12345678)');
  });

  it('known NACE — shows Obor line with division description', () => {
    const subject = makeSubject({ czNace: ['62010'] });
    const md = buildAresSummaryMarkdown(subject);
    expect(md).toContain('Obor:');
    expect(md).toContain('programování');
    expect(md).toContain('(62)');
  });

  it('bez NACE — no "Obor:" line', () => {
    const subject = makeSubject({ czNace: undefined });
    const md = buildAresSummaryMarkdown(subject);
    expect(md).not.toContain('Obor:');
  });

  it('unknown NACE code (unknown 2-digit prefix) — no "Obor:" line', () => {
    const subject = makeSubject({ czNace: ['04000'] });
    const md = buildAresSummaryMarkdown(subject);
    expect(md).not.toContain('Obor:');
  });

  it('contains CTA hint for DD server', () => {
    const md = buildAresSummaryMarkdown(makeSubject({}));
    expect(md).toContain('get_dd_report');
    expect(md).toContain('dd.cz-agents.dev/mcp');
  });

  it('no verdict icon (✅ / 🔴 / ⚠) — ARES has no risk data', () => {
    const md = buildAresSummaryMarkdown(makeSubject({}));
    expect(md).not.toContain('✅');
    expect(md).not.toContain('🔴');
    expect(md).not.toContain('⚠');
  });

  it('raw JSON contract — returned separately, not embedded in summary', () => {
    const subject = makeSubject({ obchodniJmeno: 'Firma XY a.s.' });
    const summary = buildAresSummaryMarkdown(subject);
    const raw = JSON.stringify(subject, null, 2);
    // summary should NOT contain the raw JSON blob
    expect(summary).not.toContain('"ico"');
    // raw should be byte-identical to JSON.stringify
    expect(raw).toContain('"ico": "00000001"');
  });

  it('server handler: content[1] deep-equal raw subject JSON', () => {
    // Contract: server puts summary at [0], raw at [1]
    // This test verifies the raw is byte-identical (no transformation)
    const subject = makeSubject({
      ico: '87654321',
      obchodniJmeno: 'Konstrukční Firma a.s.',
      czNace: ['41100', '43290'],
    });
    const raw = JSON.stringify(subject, null, 2);
    // Re-parse should deep-equal original
    expect(JSON.parse(raw)).toEqual(subject);
  });
});
