import { afterEach, describe, expect, it, vi } from 'vitest';

interface Query {
  sql: string;
  params: unknown[];
}

function row(ico = '12345678') {
  return {
    ico,
    network_size: 4,
    shared_role_link_count: 2,
    coverage_pct: '88.50',
    as_of: new Date('2026-06-22T00:00:00.000Z'),
  };
}

async function loadModule(
  vrRows: unknown[],
  cacheRowsOrQuery: unknown[] | ((sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) = [],
) {
  vi.resetModules();
  const vrQueries: Query[] = [];
  const cacheQueries: Query[] = [];

  vi.doMock('./vr-client.js', () => ({
    vrClient: {
      query: async (sql: string, params: unknown[]) => {
        vrQueries.push({ sql, params });
        return { rows: vrRows };
      },
    },
  }));

  vi.doMock('pg', () => ({
    Pool: class {
      async query(sql: string, params: unknown[]) {
        cacheQueries.push({ sql, params });
        if (typeof cacheRowsOrQuery === 'function') {
          return cacheRowsOrQuery(sql, params);
        }
        return { rows: cacheRowsOrQuery };
      }
    },
  }));

  const module = await import('./ownership-network.js');
  return { getOwnershipNetwork: module.getOwnershipNetwork, vrQueries, cacheQueries };
}

afterEach(() => {
  delete process.env.OWNERSHIP_CACHE_DATABASE_URL;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('getOwnershipNetwork', () => {
  it('reads teaser summary from ownership cache when OWNERSHIP_CACHE_DATABASE_URL is set', async () => {
    process.env.OWNERSHIP_CACHE_DATABASE_URL = 'postgres://cache';
    const { getOwnershipNetwork, vrQueries, cacheQueries } = await loadModule([], [row()]);

    const result = await getOwnershipNetwork(' 12345678 ', { level: 'summary' });

    expect(vrQueries).toHaveLength(0);
    expect(cacheQueries[0]?.sql).toContain('ownership_cache.company_network_summary');
    expect(cacheQueries[0]?.params).toEqual(['12345678']);
    expect(result).toMatchObject({ ico: '12345678', network_size: 4, coverage_pct: 88.5, as_of: '2026-06-22' });
  });

  it('falls back to VR summary when ownership cache URL is absent', async () => {
    const { getOwnershipNetwork, vrQueries, cacheQueries } = await loadModule([row()]);

    const result = await getOwnershipNetwork('12345678', { level: 'summary' });

    expect(cacheQueries).toHaveLength(0);
    expect(vrQueries[0]?.sql).toContain('vr.company_network_summary');
    expect(result.network_size).toBe(4);
  });

  it('returns an empty teaser when no precomputed row exists', async () => {
    const { getOwnershipNetwork } = await loadModule([]);

    await expect(getOwnershipNetwork('12345678', { level: 'summary' })).resolves.toMatchObject({
      ico: '12345678',
      network_size: 0,
      shared_role_link_count: 0,
      coverage_pct: 0,
      as_of: null,
      _teaser: true,
    });
  });

  it('records a cache miss without waiting for the queue write', async () => {
    process.env.OWNERSHIP_CACHE_DATABASE_URL = 'postgres://cache';
    const { getOwnershipNetwork, cacheQueries } = await loadModule([], []);

    await expect(getOwnershipNetwork('12345678', { level: 'summary' })).resolves.toMatchObject({
      ico: '12345678',
      network_size: 0,
    });

    await vi.waitFor(() => {
      expect(cacheQueries[1]?.sql).toContain('ownership_cache.fill_requests');
      expect(cacheQueries[1]?.params).toEqual(['12345678']);
    });
  });

  it('does not propagate fill request write errors', async () => {
    process.env.OWNERSHIP_CACHE_DATABASE_URL = 'postgres://cache';
    const { getOwnershipNetwork } = await loadModule([], async (sql) => {
      if (sql.includes('fill_requests')) {
        throw new Error('cache write failed');
      }
      return { rows: [] };
    });

    await expect(getOwnershipNetwork('12345678', { level: 'summary' })).resolves.toMatchObject({
      ico: '12345678',
      network_size: 0,
    });
  });
});
