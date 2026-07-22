import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GleifAdapter } from '../adapters/de-gleif.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' },
  });
}

const BE_RECORD = {
  id: 'BEGLEIF0000000001',
  attributes: {
    entity: {
      legalName: { name: 'NV KBC Bank' },
      status: 'ACTIVE',
      jurisdiction: 'BE',
      creationDate: '1998-01-01T00:00:00Z',
      legalAddress: {
        addressLines: ['Havenlaan 2'],
        city: 'Brussels',
        postalCode: '1080',
        country: 'BE',
      },
    },
  },
};

describe('GleifAdapter (BE)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('searchByName uses BE jurisdiction filter', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return jsonResponse({ data: [BE_RECORD], meta: { pagination: { total: 1 } } });
    }) as typeof fetch);

    const adapter = new GleifAdapter('BE');
    const result = await adapter.searchByName('KBC', 5);

    expect(capturedUrl).toContain('filter%5Bentity.jurisdiction%5D=BE');
    expect(result.companies[0]?.country).toBe('be');
    expect(result.companies[0]?.name).toBe('NV KBC Bank');
    expect(result.companies[0]?.lei).toBe('BEGLEIF0000000001');
  });

  it('getById returns company with be country code', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: BE_RECORD }));
    const adapter = new GleifAdapter('BE');
    const company = await adapter.getById('BEGLEIF0000000001');
    expect(company?.country).toBe('be');
    expect(company?.name).toBe('NV KBC Bank');
  });
});
