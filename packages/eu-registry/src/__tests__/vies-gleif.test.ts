import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GleifAdapter } from '../adapters/de-gleif.js';
import { ViesGleifAdapter } from '../adapters/vies-gleif.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GLEIF_RECORD = {
  id: '529900T8BM49AURSDO55',
  attributes: {
    entity: {
      legalName: { name: 'Banco Bilbao Vizcaya Argentaria, S.A.' },
      status: 'ACTIVE',
      jurisdiction: 'ES',
      legalAddress: {
        addressLines: ['Plaza San Nicolas 4'],
        city: 'Bilbao',
        postalCode: '48005',
      },
    },
  },
};

describe('ViesGleifAdapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let handler: (url: string) => Response | Promise<Response>;

  beforeEach(() => {
    handler = () => jsonResponse({});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (...args: FetchArgs) => {
        const url = args[0] instanceof URL ? args[0].toString() : String(args[0]);
        return handler(url);
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('routes paywall-country getById VAT lookup through VIES', async () => {
    let capturedUrl = '';
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse({ isValid: true, name: 'ACME IT S.R.L.', address: 'Via Roma 1' });
    };

    const adapter = new ViesGleifAdapter('it', new GleifAdapter('IT'));
    const company = await adapter.getById('IT12345678901');

    expect(capturedUrl).toContain('/vies/rest-api/ms/IT/vat/12345678901');
    expect(company).toMatchObject({
      id: 'IT12345678901',
      country: 'it',
      name: 'ACME IT S.R.L.',
      status: 'active',
    });
  });

  it('routes paywall-country name search through GLEIF', async () => {
    let capturedUrl = '';
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse({ data: [GLEIF_RECORD], meta: { pagination: { total: 1 } } });
    };

    const adapter = new ViesGleifAdapter('es', new GleifAdapter('ES'));
    const result = await adapter.searchByName('Banco', 3);

    expect(capturedUrl).toContain('api.gleif.org/api/v1/lei-records');
    expect(capturedUrl).toContain('filter%5Bentity.jurisdiction%5D=ES');
    expect(capturedUrl).toContain('page%5Bsize%5D=3');
    expect(result.companies[0]).toMatchObject({
      id: '529900T8BM49AURSDO55',
      country: 'es',
      lei: '529900T8BM49AURSDO55',
      name: 'Banco Bilbao Vizcaya Argentaria, S.A.',
    });
  });
});
