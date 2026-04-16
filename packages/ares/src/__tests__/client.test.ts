import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AresClient } from '../client.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AresClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

  beforeEach(() => {
    handler = () => jsonResponse({});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (...args: FetchArgs) => {
        const url = typeof args[0] === 'string' ? args[0] : String(args[0]);
        return handler(url, args[1]);
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('getByIco', () => {
    it('returns subject on 200', async () => {
      handler = () =>
        jsonResponse({
          ico: '26168685',
          obchodniJmeno: 'Seznam.cz, a.s.',
          sidlo: { nazevObce: 'Praha', psc: 15000 },
        });
      const c = new AresClient();
      const s = await c.getByIco('26168685');
      expect(s?.ico).toBe('26168685');
      expect(s?.obchodniJmeno).toBe('Seznam.cz, a.s.');
    });

    it('returns null on 404 (not an error)', async () => {
      handler = () => jsonResponse({ kod: 'NENALEZENO' }, 404);
      const c = new AresClient();
      const s = await c.getByIco('00000000');
      expect(s).toBeNull();
    });

    it('caches lookups — single fetch for repeated IČO', async () => {
      handler = () => jsonResponse({ ico: '27082440', obchodniJmeno: 'Alza.cz a.s.' });
      const c = new AresClient();
      await c.getByIco('27082440');
      await c.getByIco('27082440');
      await c.getByIco('27082440');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('separate cache entries per IČO', async () => {
      handler = (url) => {
        if (url.endsWith('/26168685')) return jsonResponse({ ico: '26168685' });
        if (url.endsWith('/27082440')) return jsonResponse({ ico: '27082440' });
        return jsonResponse({}, 404);
      };
      const c = new AresClient();
      await c.getByIco('26168685');
      await c.getByIco('27082440');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws on 5xx', async () => {
      handler = () => jsonResponse({ error: 'server' }, 500);
      const c = new AresClient();
      await expect(c.getByIco('11111111')).rejects.toThrow();
    });
  });

  describe('search', () => {
    it('sends POST to /vyhledat with JSON body', async () => {
      let captured: { url: string; init?: RequestInit } | null = null;
      handler = (url, init) => {
        captured = { url, init };
        return jsonResponse({ pocetCelkem: 0, ekonomickeSubjekty: [] });
      };
      const c = new AresClient();
      await c.search({ obchodniJmeno: 'Seznam' });
      expect(captured!.url).toMatch(/\/vyhledat$/);
      expect(captured!.init?.method).toBe('POST');
      const body = JSON.parse(captured!.init!.body as string);
      expect(body.obchodniJmeno).toBe('Seznam');
      expect(body.start).toBe(0);
      expect(body.pocet).toBe(10);
    });

    it('maps query → obchodniJmeno when not explicitly set', async () => {
      let body: any;
      handler = (_, init) => {
        body = JSON.parse(init!.body as string);
        return jsonResponse({ pocetCelkem: 0, ekonomickeSubjekty: [] });
      };
      const c = new AresClient();
      await c.search({ query: 'Alza' });
      expect(body.obchodniJmeno).toBe('Alza');
    });

    it('caps pocet at 100', async () => {
      let body: any;
      handler = (_, init) => {
        body = JSON.parse(init!.body as string);
        return jsonResponse({ pocetCelkem: 0, ekonomickeSubjekty: [] });
      };
      const c = new AresClient();
      await c.search({ query: 'x', pocet: 500 });
      expect(body.pocet).toBe(100);
    });

    it('forwards sidlo + czNace filters', async () => {
      let body: any;
      handler = (_, init) => {
        body = JSON.parse(init!.body as string);
        return jsonResponse({ pocetCelkem: 0, ekonomickeSubjekty: [] });
      };
      const c = new AresClient();
      await c.search({
        sidlo: { nazevObce: 'Praha', psc: 11000 },
        czNace: ['62010'],
      });
      expect(body.sidlo).toEqual({ nazevObce: 'Praha', psc: 11000 });
      expect(body.czNace).toEqual(['62010']);
    });

    it('returns parsed search result', async () => {
      handler = () =>
        jsonResponse({
          pocetCelkem: 2,
          ekonomickeSubjekty: [
            { ico: '26168685', obchodniJmeno: 'Seznam.cz, a.s.' },
            { ico: '27082440', obchodniJmeno: 'Alza.cz a.s.' },
          ],
        });
      const c = new AresClient();
      const r = await c.search({ query: 'cz' });
      expect(r.pocetCelkem).toBe(2);
      expect(r.ekonomickeSubjekty).toHaveLength(2);
    });
  });

  describe('getBankAccounts', () => {
    it('returns account list from uctyCslib', async () => {
      handler = () =>
        jsonResponse({
          uctyCslib: [
            { cisloUctu: '123456789', kodBanky: '0100', menaUctu: 'CZK' },
            { cisloUctu: '987654321', kodBanky: '0300', menaUctu: 'EUR' },
          ],
        });
      const c = new AresClient();
      const accounts = await c.getBankAccounts('26168685');
      expect(accounts).toHaveLength(2);
      expect(accounts[0]!.kodBanky).toBe('0100');
    });

    it('returns empty array on 404 (non-VAT subject)', async () => {
      handler = () => jsonResponse({}, 404);
      const c = new AresClient();
      const accounts = await c.getBankAccounts('00000000');
      expect(accounts).toEqual([]);
    });

    it('returns empty array when uctyCslib missing', async () => {
      handler = () => jsonResponse({});
      const c = new AresClient();
      const accounts = await c.getBankAccounts('26168685');
      expect(accounts).toEqual([]);
    });

    it('caches by IČO', async () => {
      handler = () => jsonResponse({ uctyCslib: [] });
      const c = new AresClient();
      await c.getBankAccounts('26168685');
      await c.getBankAccounts('26168685');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getVrRecord', () => {
    it('returns first zaznam on 200', async () => {
      handler = () =>
        jsonResponse({
          zaznamy: [
            {
              ico: '26168685',
              obchodniJmeno: 'Seznam.cz, a.s.',
              statutarniOrgany: [{ nazevOrganu: 'představenstvo' }],
            },
          ],
        });
      const c = new AresClient();
      const r = await c.getVrRecord('26168685');
      expect(r?.ico).toBe('26168685');
      expect(r?.statutarniOrgany?.[0]?.nazevOrganu).toBe('představenstvo');
    });

    it('returns null when zaznamy empty', async () => {
      handler = () => jsonResponse({ zaznamy: [] });
      const c = new AresClient();
      expect(await c.getVrRecord('26168685')).toBeNull();
    });

    it('returns null on 404', async () => {
      handler = () => jsonResponse({}, 404);
      const c = new AresClient();
      expect(await c.getVrRecord('00000000')).toBeNull();
    });

    it('targets VR endpoint (not the main subject endpoint)', async () => {
      let capturedUrl = '';
      handler = (url) => {
        capturedUrl = url;
        return jsonResponse({ zaznamy: [] });
      };
      const c = new AresClient();
      await c.getVrRecord('26168685');
      expect(capturedUrl).toContain('ekonomicke-subjekty-vr');
    });
  });

  describe('getHistory', () => {
    it('returns history payload on 200', async () => {
      handler = () => jsonResponse({ zmeny: [{ datum: '2020-01-01' }] });
      const c = new AresClient();
      const h = await c.getHistory('26168685');
      expect(h).toEqual({ zmeny: [{ datum: '2020-01-01' }] });
    });

    it('returns null on 404', async () => {
      handler = () => jsonResponse({}, 404);
      const c = new AresClient();
      expect(await c.getHistory('00000000')).toBeNull();
    });
  });
});
