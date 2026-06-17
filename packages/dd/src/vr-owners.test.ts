import { describe, expect, it } from 'vitest';
import type { AresLike, VrLike } from './clients.js';
import { buildDdServer } from './server.js';
import { buildOwnersMarkdown, lookupOwners, OWNERS_SQL } from './vr-owners.js';

interface MockRow {
  ico: string;
  name: string | null;
  depth: number;
  path: string[];
  cycle: boolean;
  as_of: string | null;
  owners: Array<{
    kind: 'person' | 'company';
    name: string | null;
    ico: string | null;
    person_id: string | null;
    birth_year: number | null;
    share: string | null;
    type: string | null;
    role: string | null;
    valid_from: string | null;
    namesake_flag: boolean;
  }>;
}

function mockVr(rows: MockRow[]): VrLike {
  return {
    query: async () => ({ rows }),
  };
}

function mockAres(): AresLike {
  return {
    getByIco: async () => null,
    getBankAccounts: async () => [],
    getVrRecord: async () => null,
    search: async () => ({ pocetCelkem: 0, ekonomickeSubjekty: [] }),
  };
}

describe('lookupOwners', () => {
  it('uses a recursive VR query over member_ico ownership edges', () => {
    expect(OWNERS_SQL).toContain('WITH RECURSIVE');
    expect(OWNERS_SQL).toContain('r.member_ico');
    expect(OWNERS_SQL).toContain('r.member_ico = ANY(n.path)');
    expect(OWNERS_SQL).toContain('vr.import_log');
  });

  it('returns only direct owners when no company owner exists', async () => {
    const result = await lookupOwners(mockVr([
      row({
        ico: '12345679',
        name: 'Solo s.r.o.',
        owners: [
          personOwner({ name: 'Jan Novak', birth_year: 1978, share: 'SPOLECNIK_OSOBA | 100%' }),
        ],
      }),
    ]), { ico: '12345679' });

    expect(result.direct_owners).toHaveLength(1);
    expect(result.direct_owners[0]?.name).toBe('Jan Novak');
    expect(result.direct_owners[0]?.birth_year).toBe(1978);
    expect(result.direct_owners[0]?.share_percent).toBe(100);
    expect(result.root.children).toHaveLength(0);

    const markdown = buildOwnersMarkdown(result);
    expect(markdown).toContain('| Jan Novak (nar. 1978) |');
    expect(markdown).toContain('Bez nadřazené právnické osoby');
    expect(markdown).toContain('Zdroj: veřejný rejstřík (VR), data k 2026-06-16T12:00:00.000Z');
    expect(markdown).not.toContain('1978-');
  });

  it('builds an upstream company ownership chain through member_ico', async () => {
    const result = await lookupOwners(mockVr([
      row({
        ico: '11111111',
        name: 'Operating s.r.o.',
        owners: [
          companyOwner({ name: 'Holding s.r.o.', ico: '22222222', share: 'SPOLECNIK_OSOBA | 80%' }),
          personOwner({ name: 'Eva Prima', birth_year: 1980, share: 'SPOLECNIK_OSOBA | 20%' }),
        ],
      }),
      row({
        ico: '22222222',
        name: 'Holding s.r.o.',
        depth: 1,
        path: ['11111111', '22222222'],
        owners: [
          personOwner({ name: 'Koncovy Vlastnik', birth_year: 1965, share: 'SPOLECNIK_OSOBA | 100%' }),
        ],
      }),
    ]), { ico: '11111111', maxDepth: 5 });

    expect(result.root.children[0]?.ico).toBe('22222222');
    expect(result.chains[0]).toEqual([
      'Operating s.r.o. (11111111)',
      'Holding s.r.o. (22222222)',
    ]);
    expect(buildOwnersMarkdown(result)).toContain('Operating s.r.o. (11111111) -> Holding s.r.o. (22222222)');
  });

  it('marks cross-ownership cycles without expanding forever', async () => {
    const result = await lookupOwners(mockVr([
      row({
        ico: '11111111',
        name: 'A s.r.o.',
        owners: [companyOwner({ name: 'B s.r.o.', ico: '22222222', share: 'SPOLECNIK_OSOBA | 100%' })],
      }),
      row({
        ico: '22222222',
        name: 'B s.r.o.',
        depth: 1,
        path: ['11111111', '22222222'],
        owners: [companyOwner({ name: 'A s.r.o.', ico: '11111111', share: 'SPOLECNIK_OSOBA | 100%' })],
      }),
      row({
        ico: '11111111',
        name: 'A s.r.o.',
        depth: 2,
        path: ['11111111', '22222222', '11111111'],
        cycle: true,
        owners: [companyOwner({ name: 'B s.r.o.', ico: '22222222', share: 'SPOLECNIK_OSOBA | 100%' })],
      }),
    ]), { ico: '11111111', maxDepth: 5 });

    const cycleNode = result.root.children[0]?.children[0];
    expect(cycleNode?.cycle).toBe(true);
    expect(buildOwnersMarkdown(result)).toContain('[cyklus]');
  });

  it('keeps same-name physical owners ambiguous instead of silently merging', async () => {
    const result = await lookupOwners(mockVr([
      row({
        ico: '12345679',
        name: 'Namesake s.r.o.',
        owners: [
          personOwner({ person_id: '1', name: 'Jan Novak', birth_year: 1978, share: 'SPOLECNIK_OSOBA | 50%', namesake_flag: true }),
          personOwner({ person_id: '2', name: 'Jan Novak', birth_year: 1978, share: 'SPOLECNIK_OSOBA | 50%', namesake_flag: true }),
        ],
      }),
    ]), { ico: '12345679' });

    expect(result.direct_owners).toHaveLength(2);
    expect(result.direct_owners.every((owner) => owner.confidence.ambiguous)).toBe(true);
    expect(result.warnings).toContain('namesake_ambiguity');
  });
});

describe('get_owners server registration', () => {
  it('returns vr_not_configured when clients.vr is missing', async () => {
    const server = buildDdServer({ ares: mockAres() });
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })
      ._registeredTools.get_owners;

    const response = await tool.handler({ ico: '12345679', max_depth: 5 });
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({ error: 'vr_not_configured' });
  });

  it('returns structuredContent and markdown for configured VR client', async () => {
    const server = buildDdServer({
      ares: mockAres(),
      vr: mockVr([
        row({
          ico: '12345679',
          name: 'Structured s.r.o.',
          owners: [personOwner({ name: 'Jana Testova', birth_year: 1990, share: 'SPOLECNIK_OSOBA | 100%' })],
        }),
      ]),
    });
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ structuredContent: unknown; content: Array<{ text: string }> }> }> })
      ._registeredTools.get_owners;

    const response = await tool.handler({ ico: '12345679', max_depth: 5 });
    expect(response.structuredContent).toMatchObject({ query: { ico: '12345679' }, source: 'vr' });
    expect(response.content[0]?.text).toContain('| Jana Testova (nar. 1990) |');
  });
});

function row(input: Partial<MockRow> & { ico: string; name: string | null; owners: MockRow['owners'] }): MockRow {
  return {
    depth: 0,
    path: [input.ico],
    cycle: false,
    as_of: '2026-06-16T12:00:00.000Z',
    ...input,
  };
}

function personOwner(input: Partial<MockRow['owners'][number]> & { name: string; birth_year: number | null; share: string }): MockRow['owners'][number] {
  return {
    kind: 'person',
    name: input.name,
    ico: null,
    person_id: input.person_id ?? 'person-1',
    birth_year: input.birth_year,
    share: input.share,
    type: input.type ?? 'SPOLECNIK_OSOBA',
    role: input.role ?? 'Společník',
    valid_from: input.valid_from ?? '2020-01-01',
    namesake_flag: input.namesake_flag ?? false,
  };
}

function companyOwner(input: Partial<MockRow['owners'][number]> & { name: string; ico: string; share: string }): MockRow['owners'][number] {
  return {
    kind: 'company',
    name: input.name,
    ico: input.ico,
    person_id: null,
    birth_year: null,
    share: input.share,
    type: input.type ?? 'SPOLECNIK_OSOBA',
    role: input.role ?? 'Společník',
    valid_from: input.valid_from ?? '2020-01-01',
    namesake_flag: false,
  };
}
