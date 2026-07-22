import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GleifAdapter } from '../adapters/de-gleif.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' },
  });
}

const LT_RECORD = {
  id: 'LTGLEIF0000000001',
  attributes: {
    entity: {
      legalName: { name: 'Telia Lietuva, AB' },
      status: 'ACTIVE',
      jurisdiction: 'LT',
      creationDate: '1992-02-06T00:00:00Z',
      legalAddress: {
        addressLines: ['Saltoniskiu g. 7A'],
        city: 'Vilnius',
        postalCode: 'LT-08126',
        country: 'LT',
      },
    },
  },
};

describe('GleifAdapter (LT)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('searchByName uses LT jurisdiction filter', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return jsonResponse({ data: [LT_RECORD], meta: { pagination: { total: 1 } } });
    }) as typeof fetch);

    const adapter = new GleifAdapter('LT');
    const result = await adapter.searchByName('Telia', 5);

    expect(capturedUrl).toContain('filter%5Bentity.jurisdiction%5D=LT');
    expect(result.companies[0]?.country).toBe('lt');
    expect(result.companies[0]?.name).toBe('Telia Lietuva, AB');
    expect(result.companies[0]?.lei).toBe('LTGLEIF0000000001');
  });

  it('getById returns company with lt country code', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: LT_RECORD }));
    const adapter = new GleifAdapter('LT');
    const company = await adapter.getById('LTGLEIF0000000001');
    expect(company?.country).toBe('lt');
    expect(company?.name).toBe('Telia Lietuva, AB');
  });
});
