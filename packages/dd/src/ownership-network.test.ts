import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('getOwnershipNetwork', () => {
  it('returns teaser summary from on-demand ownership entity query', async () => {
    vi.doMock('./ownership-entity-query.js', () => ({
      getCompanyNetwork: vi.fn().mockResolvedValue({
        network_size: 7,
        shared_role_link_count: 3,
        coverage: 0.83,
        edges: [],
        collapsed_hubs: [],
      }),
    }));
    const { getOwnershipNetwork } = await import('./ownership-network.js');

    const result = await getOwnershipNetwork(' 12345678 ', { level: 'summary' });

    expect(result).toMatchObject({
      ico: '12345678',
      network_size: 7,
      shared_role_link_count: 3,
      coverage_pct: 0.83,
      _teaser: true,
    });
    expect(result.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('preserves empty teaser shape when the company has no adjacency', async () => {
    vi.doMock('./ownership-entity-query.js', () => ({
      getCompanyNetwork: vi.fn().mockResolvedValue({
        network_size: 0,
        shared_role_link_count: 0,
        coverage: 0,
        edges: [],
        collapsed_hubs: [],
      }),
    }));
    const { getOwnershipNetwork } = await import('./ownership-network.js');

    await expect(getOwnershipNetwork('12345678', { level: 'summary' })).resolves.toMatchObject({
      ico: '12345678',
      network_size: 0,
      shared_role_link_count: 0,
      coverage_pct: 0,
      as_of: null,
      _teaser: true,
    });
  });
});
