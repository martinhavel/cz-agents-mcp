import { afterEach, describe, expect, it } from 'vitest';
import { getCompanyNetwork, setOwnershipEntityQueryClientForTests } from './ownership-entity-query.js';

class FakeClient {
  queries: Array<{ sql: string; params: unknown[] }> = [];

  async query<T>(sql: string, params: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    if (sql.includes('FROM vr.company_entity_edge e') && sql.includes('WHERE e.company_ico = $1')) {
      return {
        rows: [
          { canonical_key: 'p:normal', repr_full_name: 'Normal Person', role_types: ['jednatel'] },
          { canonical_key: 'p:hub', repr_full_name: 'Hub Person', role_types: ['clen_organu'] },
        ] as T[],
      };
    }
    if (sql.includes('FROM vr.entity_degree')) {
      return {
        rows: [
          { canonical_key: 'p:normal', company_count: 3 },
          { canonical_key: 'p:hub', company_count: 51 },
        ] as T[],
      };
    }
    if (sql.includes('FROM vr.companies')) {
      return {
        rows: [
          { ico: '22222222', name: 'BAIRTA GROUP s.r.o. v likvidaci' },
          { ico: '33333333', name: 'Active Group s.r.o.' },
        ] as T[],
      };
    }
    return {
      rows: [
        { company_ico: '22222222', canonical_key: 'p:normal', role_types: ['jednatel'] },
        { company_ico: '33333333', canonical_key: 'p:normal', role_types: ['spolecnik'] },
      ] as T[],
    };
  }
}

afterEach(() => {
  setOwnershipEntityQueryClientForTests(undefined);
});

describe('getCompanyNetwork', () => {
  it('filters high-degree hubs before two-hop expansion', async () => {
    const client = new FakeClient();
    setOwnershipEntityQueryClientForTests(client);

    const result = await getCompanyNetwork('12345678', { maxDegree: 50, maxNodes: 200 });

    expect(client.queries[2]?.params).toEqual([['p:normal'], '12345678']);
    expect(result.collapsed_hubs).toEqual(['p:hub']);
    expect(result.edges.map((edge) => edge.dst_ico)).toEqual(['22222222', '33333333']);
    expect(result.entities_1hop).toEqual([
      { canonical_key: 'p:normal', repr_full_name: 'Normal Person', role_types: ['jednatel'], is_hub: false },
      { canonical_key: 'p:hub', repr_full_name: 'Hub Person', role_types: ['clen_organu'], is_hub: true },
    ]);
    expect(result.companies_2hop).toEqual([
      {
        ico: '22222222',
        name: 'BAIRTA GROUP s.r.o. v likvidaci',
        is_liquidated: true,
        shared_entities: ['p:normal'],
      },
      {
        ico: '33333333',
        name: 'Active Group s.r.o.',
        is_liquidated: false,
        shared_entities: ['p:normal'],
      },
    ]);
    expect(result.network_size).toBe(5);
    expect(result.shared_role_link_count).toBe(4);
    expect(result.coverage).toBe(0.5);
  });

  it('caps two-hop company nodes by maxNodes', async () => {
    const client = new FakeClient();
    setOwnershipEntityQueryClientForTests(client);

    const result = await getCompanyNetwork('12345678', { maxDegree: 50, maxNodes: 1 });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ src_ico: '12345678', dst_ico: '22222222', canonical_key: 'p:normal' });
    expect(result.network_size).toBe(4);
    expect(result.coverage).toBe(0.25);
  });

  it('returns an empty network when the company has no first-hop adjacency', async () => {
    setOwnershipEntityQueryClientForTests({
      query: async <T>() => ({ rows: [] as T[] }),
    });

    await expect(getCompanyNetwork('12345678')).resolves.toEqual({
      network_size: 0,
      shared_role_link_count: 0,
      coverage: 0,
      edges: [],
      entities_1hop: [],
      companies_2hop: [],
      collapsed_hubs: [],
    });
  });
});
