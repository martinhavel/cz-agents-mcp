import { describe, it, expect } from 'vitest';
import { AdisClient, buildBasicEnvelope, buildSubjectV2Envelope, buildListEnvelope, icoToDic } from '../client.js';

const SUBJECT_V2_SAMPLE = `<?xml version='1.0' encoding='UTF-8'?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns:StatusNespolehlivySubjektRozsirenyResponse xmlns:ns="http://adis.mfcr.cz/rozhraniCRPDPH/">
      <ns:status odpovedGenerovana="2026-04-27" statusCode="0" statusText="OK"/>
      <ns:statusSubjektu dic="CZ27074358" nespolehlivyPlatce="NE" cisloFu="009" typSubjektu="PLATCE_DPH">
        <ns:nazevSubjektu>Alza.cz a.s.</ns:nazevSubjektu>
        <ns:adresa>
          <ns:uliceCislo>Jankovcova 1522/53</ns:uliceCislo>
          <ns:mesto>Praha</ns:mesto>
          <ns:psc>17000</ns:psc>
          <ns:stat>CZ</ns:stat>
        </ns:adresa>
        <ns:zverejneneUcty>
          <ns:standardniUcet predcisli="123" cislo="4567890123" kodBanky="0100" datumZverejneni="2020-01-01"/>
          <ns:standardniUcet cislo="9876543210" kodBanky="0300" datumZverejneni="2018-06-15"/>
        </ns:zverejneneUcty>
      </ns:statusSubjektu>
      <ns:statusSubjektu dic="CZ12345678" nespolehlivyPlatce="ANO" datumZverejneniNespolehlivosti="2024-03-15" typSubjektu="NESPOLEHLIVA_OSOBA">
        <ns:nazevSubjektu>Podezřelá s.r.o.</ns:nazevSubjektu>
      </ns:statusSubjektu>
      <ns:statusSubjektu dic="CZ99999999" nespolehlivyPlatce="NENALEZEN"/>
    </ns:StatusNespolehlivySubjektRozsirenyResponse>
  </soap:Body>
</soap:Envelope>`;

const BASIC_SAMPLE = `<?xml version='1.0' encoding='UTF-8'?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns:StatusNespolehlivyPlatceResponse xmlns:ns="http://adis.mfcr.cz/rozhraniCRPDPH/">
      <ns:status odpovedGenerovana="2026-04-27" statusCode="0" statusText="OK"/>
      <ns:statusPlatceDPH dic="CZ27074358" nespolehlivyPlatce="NE" cisloFu="009"/>
      <ns:statusPlatceDPH dic="CZ12345678" nespolehlivyPlatce="ANO" datumZverejneniNespolehlivosti="2024-03-15"/>
    </ns:StatusNespolehlivyPlatceResponse>
  </soap:Body>
</soap:Envelope>`;

const FAULT_SAMPLE = `<?xml version='1.0' encoding='UTF-8'?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>Service unavailable</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;

describe('AdisClient — IČO/DIČ helpers', () => {
  it('icoToDic prepends CZ for plain IČOs', () => {
    expect(icoToDic('27074358')).toBe('CZ27074358');
    expect(icoToDic('  12345678  ')).toBe('CZ12345678');
  });
  it('icoToDic accepts already-prefixed DIČ unchanged', () => {
    expect(icoToDic('CZ27074358')).toBe('CZ27074358');
    expect(icoToDic('cz27074358')).toBe('CZ27074358');
  });
  it('icoToDic rejects garbage', () => {
    expect(() => icoToDic('not-a-number')).toThrow();
    expect(() => icoToDic('12345678901234')).toThrow();
  });
});

describe('AdisClient — envelope builders', () => {
  it('buildBasicEnvelope contains all DIČs and right namespace', () => {
    const xml = buildBasicEnvelope(['CZ27074358', 'CZ12345678']);
    expect(xml).toContain('xmlns:adis="http://adis.mfcr.cz/rozhraniCRPDPH/"');
    expect(xml).toContain('<adis:dic>CZ27074358</adis:dic>');
    expect(xml).toContain('<adis:dic>CZ12345678</adis:dic>');
    expect(xml).toContain('StatusNespolehlivyPlatceRequest');
  });
  it('buildSubjectV2Envelope uses V2 request element', () => {
    const xml = buildSubjectV2Envelope(['CZ27074358']);
    expect(xml).toContain('StatusNespolehlivySubjektRozsirenyV2Request');
    expect(xml).toContain('<adis:dic>CZ27074358</adis:dic>');
  });
  it('buildListEnvelope is empty (no input)', () => {
    const xml = buildListEnvelope();
    expect(xml).toContain('SeznamNespolehlivyPlatceRequest');
    expect(xml).not.toContain('<adis:dic>');
  });
});

describe('AdisClient — response parsing', () => {
  const c = new AdisClient({ stub: true });

  it('parses subject V2 response with mixed reliability', () => {
    const result = c.parseSubjectV2Response(SUBJECT_V2_SAMPLE);
    expect(result.service.status_code).toBe(0);
    expect(result.service.status_text).toBe('OK');
    expect(result.service.generated_on).toBe('2026-04-27');
    expect(result.results).toHaveLength(3);

    const alza = result.results[0]!;
    expect(alza.dic).toBe('CZ27074358');
    expect(alza.ico).toBe('27074358');
    expect(alza.reliability).toBe('NE');
    expect(alza.subject_type).toBe('PLATCE_DPH');
    expect(alza.subject_name).toBe('Alza.cz a.s.');
    expect(alza.address?.mesto).toBe('Praha');
    expect(alza.address?.psc).toBe('17000');
    expect(alza.tax_office).toBe('009');
    expect(alza.accounts).toHaveLength(2);
    expect(alza.accounts[0]!.formatted).toBe('123-4567890123/0100');
    expect(alza.accounts[1]!.formatted).toBe('9876543210/0300');

    const unreliable = result.results[1]!;
    expect(unreliable.reliability).toBe('ANO');
    expect(unreliable.unreliable_since).toBe('2024-03-15');
    expect(unreliable.subject_type).toBe('NESPOLEHLIVA_OSOBA');

    const notFound = result.results[2]!;
    expect(notFound.reliability).toBe('NENALEZEN');
    expect(notFound.accounts).toEqual([]);
  });

  it('parses basic response with status attributes', () => {
    const result = c.parseBasicResponse(BASIC_SAMPLE);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.reliability).toBe('NE');
    expect(result.results[0]!.subject_name).toBeUndefined();
    expect(result.results[1]!.reliability).toBe('ANO');
    expect(result.results[1]!.unreliable_since).toBe('2024-03-15');
  });

  it('throws on SOAP Fault', () => {
    expect(() => c.parseSubjectV2Response(FAULT_SAMPLE)).toThrow(/SOAP Fault.*Service unavailable/);
  });

  it('throws on malformed envelope', () => {
    expect(() => c.parseSubjectV2Response('<not-a-soap-response/>')).toThrow();
  });
});

describe('AdisClient — stub mode', () => {
  it('checkPayer returns null in stub mode', async () => {
    const c = new AdisClient({ stub: true });
    const result = await c.checkPayer({ ico: '27074358' });
    expect(result).toBeNull();
  });
  it('checkBulk returns NENALEZEN entries in stub mode', async () => {
    const c = new AdisClient({ stub: true });
    const result = await c.checkBulk({ icos: ['27074358', '12345678'] });
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.reliability).toBe('NENALEZEN');
    expect(result.results[1]!.reliability).toBe('NENALEZEN');
  });
  it('checkBulk rejects >100 DIČs', async () => {
    const c = new AdisClient({ stub: true });
    const dics = Array.from({ length: 101 }, (_, i) => `CZ${String(i).padStart(8, '0')}`);
    await expect(c.checkBulk({ dics })).rejects.toThrow(/limit is 100/);
  });
  it('listUnreliable returns empty in stub mode', async () => {
    const c = new AdisClient({ stub: true });
    const result = await c.listUnreliable();
    expect(result.unreliable).toEqual([]);
  });
});
