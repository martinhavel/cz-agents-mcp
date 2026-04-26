import { describe, it, expect } from 'vitest';
import { IsirClient, buildEnvelope } from '../client.js';

const SAMPLE_RESPONSE = `<?xml version='1.0' encoding='UTF-8'?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns2:getIsirWsPublicDataResponse xmlns:ns2="http://isirpublicws.cca.cz/types/">
      <data>
        <id>1246</id>
        <datumZalozeniUdalosti>2008-01-02T12:22:11.000+01:00</datumZalozeniUdalosti>
        <datumZverejneniUdalosti>2008-01-02T12:30:00.000+01:00</datumZverejneniUdalosti>
        <dokumentUrl>https://isir.justice.cz:8443/isir_public_ws/doc/Document?idDokument=1246</dokumentUrl>
        <spisovaZnacka>INS 1/2008</spisovaZnacka>
        <typUdalosti>5</typUdalosti>
        <popisUdalosti>Insolvenční návrh</popisUdalosti>
        <oddil>A</oddil>
        <cisloVOddilu>1</cisloVOddilu>
      </data>
      <data>
        <id>1247</id>
        <datumZalozeniUdalosti>2008-01-02T12:22:11.000+01:00</datumZalozeniUdalosti>
        <datumZverejneniUdalosti>2008-01-02T12:30:00.000+01:00</datumZverejneniUdalosti>
        <spisovaZnacka>INS 1/2008</spisovaZnacka>
        <typUdalosti>1</typUdalosti>
        <popisUdalosti>Změna osoby</popisUdalosti>
      </data>
      <status>
        <stav>OK</stav>
      </status>
    </ns2:getIsirWsPublicDataResponse>
  </soap:Body>
</soap:Envelope>`;

const FAULT_RESPONSE = `<?xml version='1.0' encoding='UTF-8'?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Client</faultcode>
      <faultstring>Data nejsou validní</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;

describe('buildEnvelope', () => {
  it('emits well-formed SOAP envelope with idPodnetu inside default namespace', () => {
    const xml = buildEnvelope(42);
    expect(xml).toContain('<idPodnetu>42</idPodnetu>');
    expect(xml).toContain('xmlns:tns="http://isirpublicws.cca.cz/types/"');
    expect(xml).toContain('<tns:getIsirWsPublicIdDataRequest');
  });

  it('floors fractional ids', () => {
    expect(buildEnvelope(1.9)).toContain('<idPodnetu>1</idPodnetu>');
  });
});

describe('IsirClient.parseResponse', () => {
  it('parses sample response into IsirEvent[]', () => {
    const c = new IsirClient({ stub: true });
    const result = c.parseResponse(SAMPLE_RESPONSE);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.id).toBe(1246);
    expect(result.events[0]!.spisova_znacka).toBe('INS 1/2008');
    expect(result.events[0]!.typ_udalosti).toBe('5');
    expect(result.events[0]!.cislo_v_oddilu).toBe(1);
    expect(result.last_id).toBe(1247);
    expect(result.status).toBe('OK');
  });

  it('throws on SOAP fault', () => {
    const c = new IsirClient({ stub: true });
    expect(() => c.parseResponse(FAULT_RESPONSE)).toThrow(/Data nejsou validní/);
  });

  it('throws on missing body', () => {
    const c = new IsirClient({ stub: true });
    expect(() => c.parseResponse('<garbage/>')).toThrow();
  });
});

describe('IsirClient (stub mode)', () => {
  it('pollEvents returns empty result without network call', async () => {
    const c = new IsirClient({ stub: true });
    const r = await c.pollEvents(100);
    expect(r.events).toEqual([]);
    expect(r.last_id).toBe(100);
  });

  it('checkActiveInsolvency returns null', async () => {
    const c = new IsirClient({ stub: true });
    expect(await c.checkActiveInsolvency('12345678')).toBeNull();
  });

  it('getProceedingDetail returns null', async () => {
    const c = new IsirClient({ stub: true });
    expect(await c.getProceedingDetail(1)).toBeNull();
  });

  it('listRecentProceedings returns []', async () => {
    const c = new IsirClient({ stub: true });
    expect(await c.listRecentProceedings('2026-01-01')).toEqual([]);
  });
});

describe('IsirClient (live mode, mocked fetch)', () => {
  it('pollEvents posts SOAP envelope and parses real response', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(SAMPLE_RESPONSE, { status: 200 });
    }) as typeof fetch;

    const c = new IsirClient({ stub: false, fetchImpl: mockFetch });
    const r = await c.pollEvents(0);
    expect(capturedUrl).toContain('isir.justice.cz');
    expect(capturedBody).toContain('<idPodnetu>0</idPodnetu>');
    expect(capturedHeaders['Content-Type']).toBe('text/xml; charset=utf-8');
    expect(r.events).toHaveLength(2);
    expect(r.last_id).toBe(1247);
  });

  it('pollEvents surfaces HTTP error', async () => {
    const mockFetch = (async () => new Response(FAULT_RESPONSE, { status: 500 })) as typeof fetch;
    const c = new IsirClient({ stub: false, fetchImpl: mockFetch });
    await expect(c.pollEvents(0)).rejects.toThrow(/HTTP 500.*Data nejsou validní/);
  });
});
