import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlKrsAdapter } from '../adapters/pl-krs.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PlKrsAdapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

  beforeEach(() => {
    handler = () => jsonResponse({});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (...args: FetchArgs) => {
        const url = args[0] instanceof URL ? args[0].toString() : String(args[0]);
        return handler(url, args[1]);
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('searchByName maps KRS odpisy to companies', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    handler = (url, init) => {
      captured = { url, init };
      return jsonResponse({
        liczbaOdpisow: 1,
        odpisy: [
          {
            numerKRS: '0000123456',
            nazwa: 'ACME POLSKA SP. Z O.O.',
            statusPodmiotu: 'czynny',
            adres: 'ul. Testowa 1, 00-001 Warszawa',
          },
        ],
      });
    };

    const adapter = new PlKrsAdapter();
    const result = await adapter.searchByName('ACME', 5);

    expect(captured?.url).toBe(
      'https://api-krs.ms.gov.pl/api/krs/WyszukiwanieKRS/podmiot?nazwaForPodmiotu=ACME&rejestry=P%2CS&strona=1&rekordyNaStronie=5',
    );
    expect(captured?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      total_results: 1,
      companies: [
        {
          id: '0000123456',
          country: 'pl',
          name: 'ACME POLSKA SP. Z O.O.',
          status: 'active',
          address: 'ul. Testowa 1, 00-001 Warszawa',
          registered_on: undefined,
          source_url: 'https://ekrs.ms.gov.pl/web/wyszukiwarka-krs/strona-glowna/wyszukaj?numer=0000123456',
        },
      ],
    });
  });

  it('getById returns company and parses registered_on from nested path', async () => {
    handler = () =>
      jsonResponse({
        odpis: {
          naglowekA: {
            numerKRS: '0000123456',
          },
          dane: {
            dzial1: {
              danePodmiotu: {
                nazwa: 'ACME POLSKA SP. Z O.O.',
                statusPodmiotu: 'czynny',
              },
              siedzibaIAdres: {
                adres: {
                  ulica: 'Testowa',
                  nrDomu: '1',
                  kodPocztowy: '00-001',
                  miejscowosc: 'Warszawa',
                },
              },
              dataRejestracjiWKRS: '2021-03-04',
            },
          },
        },
      });

    const adapter = new PlKrsAdapter();

    await expect(adapter.getById('0000123456')).resolves.toEqual({
      id: '0000123456',
      country: 'pl',
      name: 'ACME POLSKA SP. Z O.O.',
      status: 'active',
      address: 'Testowa, 1, 00-001, Warszawa',
      registered_on: '2021-03-04',
      source_url: 'https://ekrs.ms.gov.pl/web/wyszukiwarka-krs/strona-glowna/wyszukaj?numer=0000123456',
    });
  });

  it('non-200 from searchByName returns empty results gracefully', async () => {
    handler = () => jsonResponse({}, 500);
    const adapter = new PlKrsAdapter();

    await expect(adapter.searchByName('ACME')).resolves.toEqual({ companies: [], total_results: 0 });
  });

  it('maps statusPodmiotu wykreślony to dissolved', async () => {
    handler = () =>
      jsonResponse({
        liczbaOdpisow: 1,
        odpisy: [
          {
            numerKRS: '0000654321',
            nazwa: 'OLD POLSKA SP. Z O.O.',
            statusPodmiotu: 'wykreślony',
          },
        ],
      });

    const adapter = new PlKrsAdapter();
    const result = await adapter.searchByName('OLD');

    expect(result.companies[0]?.status).toBe('dissolved');
  });
});
