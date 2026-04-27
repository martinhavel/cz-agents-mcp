/**
 * AdisClient — talks to the MFČR Registr CRPDPH SOAP service to determine
 * VAT-payer reliability ("nespolehlivý plátce DPH"), retrieve published
 * bank accounts (§ 96a ZDPH transparent accounts), and resolve subject
 * type / name / address.
 *
 * Endpoint: https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP
 * WSDL:    add ?wsdl
 *
 * Operations used:
 *   - getStatusNespolehlivySubjektRozsirenyV2  (single/bulk lookup with full info)
 *   - getStatusNespolehlivyPlatce              (lighter bulk lookup, no name/address)
 *   - getSeznamNespolehlivyPlatce              (full unreliable-payer list, no input)
 *
 * Status semantics (per WSDL annotations):
 *   reliability:
 *     ANO       = subject IS unreliable (red flag)
 *     NE        = subject is reliable
 *     NENALEZEN = DIČ not found in registry (not a VAT payer)
 *   service.status_code:
 *     0 = OK
 *     1 = data integrity error (some entries may be missing)
 *     2 = scheduled maintenance window 00:00–00:10
 *     3 = service unavailable
 *
 * No authentication. Public service. Batch limit: 100 DIČ per request.
 *
 * Set ADIS_SOAP_ENABLED=1 (or pass `stub: false` constructor opt) to actually
 * hit the network. Default in tests is offline stub returning empty results,
 * matching the @czagents/isir convention.
 */
import { XMLParser } from 'fast-xml-parser';
import type {
  AdisServiceStatus,
  BulkPayerCheckResult,
  DphPayerStatus,
  DphReliability,
  DphSubjectAddress,
  DphSubjectType,
  PublishedAccount,
  UnreliableListResult,
} from './types.js';

const DEFAULT_ENDPOINT =
  'https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP';

const SOAP_NAMESPACE = 'http://adis.mfcr.cz/rozhraniCRPDPH/';

/** ADIS hard limit per request. */
export const MAX_DIC_PER_REQUEST = 100;

export interface AdisClientOptions {
  endpoint?: string;
  /** When true, the client returns canned empty/safe results without network. */
  stub?: boolean;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 30s. The list endpoint can be slow. */
  timeoutMs?: number;
}

export class AdisClient {
  private readonly endpoint: string;
  private readonly stub: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly parser: XMLParser;

  constructor(opts: AdisClientOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.stub = opts.stub ?? !process.env.ADIS_SOAP_ENABLED;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      // PSČ "17000", cisloFu "009", account numbers, predcisli — all must stay
      // strings; fast-xml-parser otherwise coerces to number and "009"→9 loses
      // the leading zero that's required by Czech format.
      parseAttributeValue: false,
      parseTagValue: false,
      isArray: (name) => name === 'statusPlatceDPH' || name === 'statusSubjektu' || name === 'standardniUcet',
    });
  }

  /**
   * Single-DIČ extended check. Returns reliability + subject type + name + address + accounts.
   * Pass either `dic` (e.g. "CZ27074358") or `ico` (will be converted to DIČ "CZ${ico}").
   *
   * Returns null when the DIČ is not in the VAT registry (reliability would be 'NENALEZEN').
   * Throws on network or SOAP errors.
   */
  async checkPayer(input: { ico?: string; dic?: string }): Promise<DphPayerStatus | null> {
    const dic = resolveDic(input);
    if (this.stub) return null;
    const result = await this.callSubjectV2([dic]);
    const found = result.results.find((r) => r.dic === dic) ?? null;
    if (!found) return null;
    if (found.reliability === 'NENALEZEN') return null;
    return found;
  }

  /**
   * Bulk basic check: reliability status + accounts only (no name/address). Faster,
   * suitable for screening 100 invoices at a time. Returns one entry per DIČ in input;
   * NENALEZEN entries are kept (caller decides how to handle "not in registry").
   */
  async checkBulk(input: { icos?: string[]; dics?: string[] }): Promise<BulkPayerCheckResult> {
    const dics = (input.dics ?? []).slice();
    if (input.icos) for (const ico of input.icos) dics.push(icoToDic(ico));
    if (dics.length === 0) {
      return {
        service: { generated_on: new Date().toISOString().slice(0, 10), status_code: 0, status_text: 'OK (no input)' },
        results: [],
      };
    }
    if (dics.length > MAX_DIC_PER_REQUEST) {
      throw new Error(
        `ADIS request limit is ${MAX_DIC_PER_REQUEST} DIČ; received ${dics.length}. Split into batches.`,
      );
    }
    if (this.stub) {
      return {
        service: { generated_on: new Date().toISOString().slice(0, 10), status_code: 0, status_text: 'OK (stub)' },
        results: dics.map((dic) => stubResult(dic)),
      };
    }
    return this.callBasic(dics);
  }

  /**
   * Full list of unreliable VAT payers. Response can be 50–100 MB (tens of thousands
   * of entries). Use sparingly — typically once a day for a local mirror.
   */
  async listUnreliable(): Promise<UnreliableListResult> {
    if (this.stub) {
      return {
        service: { generated_on: new Date().toISOString().slice(0, 10), status_code: 0, status_text: 'OK (stub)' },
        unreliable: [],
      };
    }
    const xml = buildListEnvelope();
    const body = await this.post(xml, 'getSeznamNespolehlivyPlatce');
    return this.parseListResponse(body);
  }

  // ---- private SOAP plumbing ----

  private async callSubjectV2(dics: string[]): Promise<BulkPayerCheckResult> {
    const xml = buildSubjectV2Envelope(dics);
    const body = await this.post(xml, 'getStatusNespolehlivySubjektRozsirenyV2');
    return this.parseSubjectV2Response(body);
  }

  private async callBasic(dics: string[]): Promise<BulkPayerCheckResult> {
    const xml = buildBasicEnvelope(dics);
    const body = await this.post(xml, 'getStatusNespolehlivyPlatce');
    return this.parseBasicResponse(body);
  }

  private async post(xml: string, soapAction: string): Promise<string> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `${SOAP_NAMESPACE}${soapAction}`,
        },
        body: xml,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(t);
    }
    const body = await resp.text();
    if (!resp.ok) {
      const fault = extractFault(body);
      throw new Error(`ADIS HTTP ${resp.status}${fault ? `: ${fault}` : ''}`);
    }
    return body;
  }

  // ---- response parsing ----

  parseSubjectV2Response(xml: string): BulkPayerCheckResult {
    const tree = this.parser.parse(xml) as SubjectV2Tree;
    const body = tree.Envelope?.Body;
    if (!body) throw new Error('Malformed ADIS SOAP envelope (no Body)');
    if (body.Fault) throw new Error(`ADIS SOAP Fault: ${body.Fault.faultstring ?? 'unknown'}`);
    const r = body.StatusNespolehlivySubjektRozsirenyResponse;
    if (!r) throw new Error('No StatusNespolehlivySubjektRozsirenyResponse in body');
    const service = parseStatus(r.status);
    const results = (r.statusSubjektu ?? []).map(parseSubjectV2Entry);
    return { service, results };
  }

  parseBasicResponse(xml: string): BulkPayerCheckResult {
    const tree = this.parser.parse(xml) as BasicTree;
    const body = tree.Envelope?.Body;
    if (!body) throw new Error('Malformed ADIS SOAP envelope (no Body)');
    if (body.Fault) throw new Error(`ADIS SOAP Fault: ${body.Fault.faultstring ?? 'unknown'}`);
    const r = body.StatusNespolehlivyPlatceResponse;
    if (!r) throw new Error('No StatusNespolehlivyPlatceResponse in body');
    const service = parseStatus(r.status);
    const results = (r.statusPlatceDPH ?? []).map(parseBasicEntry);
    return { service, results };
  }

  parseListResponse(xml: string): UnreliableListResult {
    const tree = this.parser.parse(xml) as BasicTree;
    const body = tree.Envelope?.Body;
    if (!body) throw new Error('Malformed ADIS SOAP envelope (no Body)');
    if (body.Fault) throw new Error(`ADIS SOAP Fault: ${body.Fault.faultstring ?? 'unknown'}`);
    const r = body.SeznamNespolehlivyPlatceResponse ?? body.StatusNespolehlivyPlatceResponse;
    if (!r) throw new Error('No list response element in body');
    const service = parseStatus(r.status);
    const unreliable = (r.statusPlatceDPH ?? []).map(parseBasicEntry);
    return { service, unreliable };
  }
}

// ---- shared helpers ----

export function icoToDic(ico: string): string {
  const trimmed = ico.trim();
  if (/^CZ\d{1,10}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (!/^\d{1,10}$/.test(trimmed)) {
    throw new Error(`Invalid IČO/DIČ: "${ico}". Expected 1–10 digits or CZ-prefixed DIČ.`);
  }
  return `CZ${trimmed}`;
}

function dicToIco(dic: string): string | null {
  const m = /^CZ(\d{1,10})$/i.exec(dic);
  return m ? m[1]! : null;
}

function resolveDic(input: { ico?: string; dic?: string }): string {
  if (input.dic) return icoToDic(input.dic);
  if (input.ico) return icoToDic(input.ico);
  throw new Error('Either `ico` or `dic` is required');
}

function stubResult(dic: string): DphPayerStatus {
  return { dic, ico: dicToIco(dic), reliability: 'NENALEZEN', accounts: [] };
}

interface SubjectV2Tree {
  Envelope?: {
    Body?: {
      StatusNespolehlivySubjektRozsirenyResponse?: {
        status?: RawStatus;
        statusSubjektu?: RawSubjectV2[];
      };
      Fault?: { faultstring?: string };
    };
  };
}

interface BasicTree {
  Envelope?: {
    Body?: {
      StatusNespolehlivyPlatceResponse?: {
        status?: RawStatus;
        statusPlatceDPH?: RawBasic[];
      };
      SeznamNespolehlivyPlatceResponse?: {
        status?: RawStatus;
        statusPlatceDPH?: RawBasic[];
      };
      Fault?: { faultstring?: string };
    };
  };
}

interface RawStatus {
  '@_odpovedGenerovana'?: string;
  '@_statusCode'?: string | number;
  '@_statusText'?: string;
  '@_bezVypisuUctu'?: string;
}

interface RawBasic {
  '@_dic'?: string;
  '@_nespolehlivyPlatce'?: string;
  '@_datumZverejneniNespolehlivosti'?: string;
  '@_cisloFu'?: string;
  zverejneneUcty?: { standardniUcet?: RawAccount[] };
}

interface RawSubjectV2 extends RawBasic {
  '@_typSubjektu'?: string;
  nazevSubjektu?: string;
  adresa?: {
    uliceCislo?: string;
    castObce?: string;
    mesto?: string;
    psc?: string;
    stat?: string;
  };
}

interface RawAccount {
  '@_predcisli'?: string;
  '@_cislo'?: string;
  '@_kodBanky'?: string;
  '@_datumZverejneni'?: string;
  '@_datumUkonceniZverejneni'?: string;
}

function parseStatus(s: RawStatus | undefined): AdisServiceStatus {
  return {
    generated_on: String(s?.['@_odpovedGenerovana'] ?? ''),
    status_code: Number(s?.['@_statusCode'] ?? 0),
    status_text: String(s?.['@_statusText'] ?? ''),
  };
}

function parseBasicEntry(e: RawBasic): DphPayerStatus {
  const dic = String(e['@_dic'] ?? '');
  return {
    dic,
    ico: dicToIco(dic),
    reliability: (e['@_nespolehlivyPlatce'] ?? 'NENALEZEN') as DphReliability,
    unreliable_since: e['@_datumZverejneniNespolehlivosti'],
    tax_office: e['@_cisloFu'],
    accounts: parseAccounts(e.zverejneneUcty?.standardniUcet),
  };
}

function parseSubjectV2Entry(e: RawSubjectV2): DphPayerStatus {
  const base = parseBasicEntry(e);
  const subject_type = e['@_typSubjektu'] as DphSubjectType | undefined;
  const subject_name = e.nazevSubjektu;
  const address = parseAddress(e.adresa);
  return { ...base, subject_type, subject_name, address };
}

function parseAccounts(raw: RawAccount[] | undefined): PublishedAccount[] {
  if (!raw) return [];
  return raw.map((a) => {
    const predcisli = a['@_predcisli'];
    const cislo = String(a['@_cislo'] ?? '');
    const kod_banky = String(a['@_kodBanky'] ?? '');
    const formatted = `${predcisli ? predcisli + '-' : ''}${cislo}/${kod_banky}`;
    return {
      predcisli,
      cislo,
      kod_banky,
      publikovan_od: a['@_datumZverejneni'],
      publikovan_do: a['@_datumUkonceniZverejneni'],
      formatted,
    };
  });
}

function parseAddress(a: RawSubjectV2['adresa']): DphSubjectAddress | undefined {
  if (!a) return undefined;
  return {
    ulice_cislo: a.uliceCislo,
    cast_obce: a.castObce,
    mesto: a.mesto,
    psc: a.psc,
    stat: a.stat,
  };
}

// ---- envelope builders ----

export function buildBasicEnvelope(dics: string[]): string {
  const parts = dics.map((d) => `<adis:dic>${escapeXml(d)}</adis:dic>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:adis="${SOAP_NAMESPACE}">
  <soap:Body>
    <adis:StatusNespolehlivyPlatceRequest>${parts}</adis:StatusNespolehlivyPlatceRequest>
  </soap:Body>
</soap:Envelope>`;
}

export function buildSubjectV2Envelope(dics: string[]): string {
  const parts = dics.map((d) => `<adis:dic>${escapeXml(d)}</adis:dic>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:adis="${SOAP_NAMESPACE}">
  <soap:Body>
    <adis:StatusNespolehlivySubjektRozsirenyV2Request>${parts}</adis:StatusNespolehlivySubjektRozsirenyV2Request>
  </soap:Body>
</soap:Envelope>`;
}

export function buildListEnvelope(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:adis="${SOAP_NAMESPACE}">
  <soap:Body>
    <adis:SeznamNespolehlivyPlatceRequest/>
  </soap:Body>
</soap:Envelope>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function extractFault(body: string): string | null {
  const m = /<faultstring[^>]*>([^<]+)<\/faultstring>/i.exec(body);
  return m?.[1] ?? null;
}
