import { describe, it, expect } from 'vitest';
import { buildChain } from '../chain.js';
import type { AresLike, AresSubjectLike, AresVrLike, AresSearchResultLike } from '../clients.js';

interface MockSpec {
  subjects: Record<string, AresSubjectLike>;
  vrs: Record<string, AresVrLike>;
  /** surname → list of (other) IČOs returned by company-name search */
  reverseLookup: Record<string, string[]>;
}

function mockAres(spec: MockSpec): AresLike {
  return {
    getByIco: async (ico) => spec.subjects[ico] ?? null,
    getBankAccounts: async () => [],
    getVrRecord: async (ico) => spec.vrs[ico] ?? null,
    search: async (params): Promise<AresSearchResultLike> => {
      const surname = params.obchodniJmeno;
      if (!surname) return { pocetCelkem: 0, ekonomickeSubjekty: [] };
      const matches = spec.reverseLookup[surname] ?? [];
      return {
        pocetCelkem: matches.length,
        ekonomickeSubjekty: matches.map((ico) => ({ ico, obchodniJmeno: spec.subjects[ico]?.obchodniJmeno })),
      };
    },
  };
}

describe('buildChain', () => {
  it('returns single-node tree at depth 0 with no statutory data', async () => {
    const ares = mockAres({
      subjects: { '11111111': { ico: '11111111', obchodniJmeno: 'Solo Co.' } },
      vrs: {},
      reverseLookup: {},
    });
    const chain = await buildChain('11111111', ares, { maxDepth: 1 });
    expect(chain.tree.ico).toBe('11111111');
    expect(chain.tree.children).toBeUndefined();
    expect(chain.total_companies).toBe(1);
  });

  it('expands to one level via shared statutory person', async () => {
    const ares = mockAres({
      subjects: {
        '11111111': { ico: '11111111', obchodniJmeno: 'Root' },
        '22222222': { ico: '22222222', obchodniJmeno: 'Other Novak Co.' },
      },
      vrs: {
        '11111111': {
          ico: '11111111',
          statutarniOrgany: [{
            clenoveOrganu: [{
              fyzickaOsoba: { jmeno: 'Pavel', prijmeni: 'Novakovic' },
              funkce: { nazev: 'jednatel' },
            }],
          }],
        },
        '22222222': { ico: '22222222' },
      },
      reverseLookup: {
        Novakovic: ['11111111', '22222222'], // self + sibling
      },
    });

    const chain = await buildChain('11111111', ares, { maxDepth: 1 });
    expect(chain.tree.children?.length).toBe(1);
    expect(chain.tree.children![0]!.ico).toBe('22222222');
    expect(chain.tree.children![0]!.via).toEqual(['Pavel Novakovic']);
    expect(chain.total_companies).toBe(2);
  });

  it('marks cycles instead of recursing', async () => {
    const ares = mockAres({
      subjects: {
        A: { ico: 'A', obchodniJmeno: 'A' },
        B: { ico: 'B', obchodniJmeno: 'B' },
      },
      vrs: {
        A: {
          ico: 'A',
          statutarniOrgany: [{
            clenoveOrganu: [{ fyzickaOsoba: { jmeno: 'Pavel', prijmeni: 'Novakovic' } }],
          }],
        },
        B: {
          ico: 'B',
          statutarniOrgany: [{
            clenoveOrganu: [{ fyzickaOsoba: { jmeno: 'Pavel', prijmeni: 'Novakovic' } }],
          }],
        },
      },
      reverseLookup: { Novakovic: ['A', 'B'] },
    });

    const chain = await buildChain('A', ares, { maxDepth: 3 });
    // A → B → ... B's statutory points back at A → cycle
    const b = chain.tree.children?.find((c) => c.ico === 'B');
    expect(b).toBeDefined();
    const cycleNode = b?.children?.find((c) => c.ico === 'A' && c.cycle);
    expect(cycleNode).toBeDefined();
  });

  it('respects max_depth limit', async () => {
    const ares = mockAres({
      subjects: {
        A: { ico: 'A', obchodniJmeno: 'A' },
        B: { ico: 'B', obchodniJmeno: 'B' },
        C: { ico: 'C', obchodniJmeno: 'C' },
      },
      vrs: {
        A: { ico: 'A', statutarniOrgany: [{ clenoveOrganu: [{ fyzickaOsoba: { jmeno: 'X', prijmeni: 'Linkfoo' } }] }] },
        B: { ico: 'B', statutarniOrgany: [{ clenoveOrganu: [{ fyzickaOsoba: { jmeno: 'X', prijmeni: 'Linkfoo' } }] }] },
        C: { ico: 'C', statutarniOrgany: [{ clenoveOrganu: [{ fyzickaOsoba: { jmeno: 'X', prijmeni: 'Linkfoo' } }] }] },
      },
      reverseLookup: { Linkfoo: ['A', 'B', 'C'] },
    });

    const chain = await buildChain('A', ares, { maxDepth: 1 });
    // From A we go to B and C (depth 1). Their children should NOT be expanded.
    expect(chain.max_depth).toBe(1);
    for (const child of chain.tree.children ?? []) {
      expect(child.children).toBeUndefined();
    }
  });

  it('skips short surnames to avoid common-name explosion', async () => {
    const ares = mockAres({
      subjects: { A: { ico: 'A', obchodniJmeno: 'A' } },
      vrs: {
        A: { ico: 'A', statutarniOrgany: [{ clenoveOrganu: [{ fyzickaOsoba: { jmeno: 'Jan', prijmeni: 'Ki' } }] }] },
      },
      reverseLookup: { Ki: ['B'] },
    });
    const chain = await buildChain('A', ares, { maxDepth: 2, minNameLength: 5 });
    expect(chain.tree.children).toBeUndefined();
  });

  it('auto-skips persons whose surname matches > threshold companies', async () => {
    const fakeAres: AresLike = {
      getByIco: async (ico) => ({ ico, obchodniJmeno: ico }),
      getBankAccounts: async () => [],
      getVrRecord: async (ico) =>
        ico === 'ROOT'
          ? {
              ico: 'ROOT',
              statutarniOrgany: [{
                clenoveOrganu: [
                  { fyzickaOsoba: { jmeno: 'Jan', prijmeni: 'Novakovic' } }, // <= threshold
                  { fyzickaOsoba: { jmeno: 'Petr', prijmeni: 'Tooooocommonsurname' } }, // common
                ],
              }],
            }
          : null,
      search: async (params) => {
        const s = params.obchodniJmeno;
        if (s === 'Novakovic') return { pocetCelkem: 2, ekonomickeSubjekty: [{ ico: 'X' }, { ico: 'Y' }] };
        if (s === 'Tooooocommonsurname') return { pocetCelkem: 999, ekonomickeSubjekty: [] };
        return { pocetCelkem: 0, ekonomickeSubjekty: [] };
      },
    };
    const chain = await buildChain('ROOT', fakeAres, { maxDepth: 1, commonSurnameThreshold: 50 });
    // Novakovic surname (2 matches) should expand to children
    expect(chain.tree.children?.length).toBeGreaterThan(0);
    // Tooooocommonsurname should be in skipped list
    expect(chain.tree.skipped_common_surnames).toBeDefined();
    expect(chain.tree.skipped_common_surnames!.find((s) => s.name.includes('Tooooocommonsurname'))).toBeDefined();
    expect(chain.tree.skipped_common_surnames!.find((s) => s.name.includes('Tooooocommonsurname'))!.total_match_count).toBe(999);
  });
});
