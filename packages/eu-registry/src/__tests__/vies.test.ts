import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupCompanyByVat, parseVat } from '../vies.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('VIES lookup', () => {
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

  it('parses VAT country and number', () => {
    expect(parseVat(' nl 123.456-789b01 ')).toEqual({
      country: 'nl',
      number: '123456789B01',
      vat: 'NL123456789B01',
    });
  });

  it('maps valid VAT with disclosed name and address', async () => {
    let capturedUrl = '';
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse({
        isValid: true,
        name: 'ACME B.V.',
        address: 'Main Street 1\\nAmsterdam',
      });
    };

    const company = await lookupCompanyByVat('NL123456789B01');

    expect(capturedUrl).toBe(
      'https://ec.europa.eu/taxation_customs/vies/rest-api/ms/NL/vat/123456789B01',
    );
    expect(company).toEqual({
      id: 'NL123456789B01',
      country: 'nl',
      name: 'ACME B.V.',
      status: 'active',
      address: 'Main Street 1\\nAmsterdam',
      source_url: capturedUrl,
    });
  });

  it('keeps valid ES/DE VAT result when name is not disclosed', async () => {
    handler = () => jsonResponse({ isValid: true });

    await expect(lookupCompanyByVat('ESB12345678')).resolves.toMatchObject({
      id: 'ESB12345678',
      country: 'es',
      name: 'VIES valid VAT ESB12345678 (name/address not disclosed)',
      status: 'active',
    });

    await expect(lookupCompanyByVat('DE123456789')).resolves.toMatchObject({
      id: 'DE123456789',
      country: 'de',
      name: 'VIES valid VAT DE123456789 (name/address not disclosed)',
      status: 'active',
    });
  });

  it('maps invalid VAT to unknown status without throwing', async () => {
    handler = () => jsonResponse({ isValid: false });

    await expect(lookupCompanyByVat('IT12345678901')).resolves.toMatchObject({
      id: 'IT12345678901',
      country: 'it',
      name: 'VIES invalid VAT IT12345678901 (name/address not disclosed)',
      status: 'unknown',
    });
  });
});
