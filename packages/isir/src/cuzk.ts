/**
 * IsirWsCuzkService — the *second* ISIR SOAP endpoint that supports lookup
 * by IČO, RČ, name+DOB. Unlike the public events feed (PublicWS), this one
 * can answer "is X in insolvency right now?" directly.
 *
 * Endpoint: https://isir.justice.cz:8443/isir_cuzk_ws/IsirWsCuzkService
 * Operation: getIsirWsCuzkData
 *
 * Schema reference (live-verified 2026-04-26):
 *   Request:
 *     - ic           — Czech IČO (8 digits)
 *     - rc           — rodné číslo (Czech personal ID)
 *     - nazevOsoby   — entity name fragment
 *     - jmeno        — first name
 *     - datumNarozeni — YYYY-MM-DD
 *     - filtrAktualniRizeni — "T" (only active) or "F" (also closed)
 *     - maxPocetVysledku — max 100
 *     - vyhledatBezDiakritiky — "T" / "F"
 *     - vyhledatPresnouShoduJmen — "T" / "F"
 *
 *   Response on hit: <data> array of `isirWsCuzkData` (debtor name, IČO/RČ,
 *     spisová značka via cisloSenatu/druhVec/bcVec/rocnik, druhStavKonkursu,
 *     address, urlDetailRizeni)
 *
 *   Response on miss: <stav><kodChyby>WS2</kodChyby><textChyby>Prázdný
 *     výsledek</textChyby></stav>  — NOT an error, just zero matches.
 */
import { XMLParser } from 'fast-xml-parser';
import type { InsolvencyStatus } from './types.js';

const DEFAULT_ENDPOINT =
  'https://isir.justice.cz:8443/isir_cuzk_ws/IsirWsCuzkService';

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const TYPES_NS = 'http://isirws.cca.cz/types/';

export interface CuzkSearchInput {
  ic?: string;
  rc?: string;
  nazevOsoby?: string;
  jmeno?: string;
  datumNarozeni?: string; // YYYY-MM-DD
  /** Only include proceedings that are currently active. Default true. */
  onlyActive?: boolean;
  diacriticsInsensitive?: boolean;
  exactNameMatch?: boolean;
  maxResults?: number;
}

export interface CuzkProceeding {
  ic?: string;
  rc?: string;
  cislo_senatu: number;
  druh_vec: string;
  bc_vec: number;
  rocnik: number;
  /** Composed: "<cisloSenatu> <druhVec> <bcVec>/<rocnik>" e.g. "60 INS 999/2024". */
  spisova_znacka: string;
  nazev_organizace?: string;
  jmeno_osoby?: string;
  datum_narozeni?: string;
  druh_stav_konkursu?: string;
  url_detail?: string;
  city?: string;
  street?: string;
}

export interface CuzkResult {
  results: CuzkProceeding[];
  total: number;
  status: 'OK' | 'EMPTY' | 'ERROR';
  error_code?: string;
  error_message?: string;
  synchronized_at?: string;
}

export interface CuzkClientOptions {
  endpoint?: string;
  stub?: boolean;
  fetchImpl?: typeof fetch;
}

export class CuzkClient {
  private readonly endpoint: string;
  private readonly stub: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly parser: XMLParser;

  constructor(opts: CuzkClientOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.stub = opts.stub ?? !process.env.ISIR_SOAP_ENABLED;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      processEntities: false,
      isArray: (name) => name === 'data',
    });
  }

  async search(input: CuzkSearchInput): Promise<CuzkResult> {
    if (this.stub) {
      return { results: [], total: 0, status: 'OK' };
    }
    const xml = buildCuzkEnvelope(input);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30_000);
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '""',
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
      throw new Error(`CUZK HTTP ${resp.status}${fault ? `: ${fault}` : ''}`);
    }
    return this.parseResponse(body);
  }

  /** Look up a CZ company by IČO. Returns first active proceeding mapped to InsolvencyStatus shape, or null. */
  async checkActiveByIco(ico: string): Promise<InsolvencyStatus | null> {
    const r = await this.search({ ic: ico, onlyActive: true, maxResults: 1 });
    if (r.results.length === 0) return null;
    return mapToInsolvencyStatus(r.results[0]!, ico);
  }

  /** Search a person by name + optional DOB. Returns ALL matches (active filter optional). */
  async searchPerson(opts: {
    name: string;
    dob?: string;
    onlyActive?: boolean;
  }): Promise<CuzkProceeding[]> {
    const r = await this.search({
      jmeno: opts.name,
      datumNarozeni: opts.dob,
      onlyActive: opts.onlyActive ?? true,
      diacriticsInsensitive: true,
      maxResults: 20,
    });
    return r.results;
  }

  parseResponse(xml: string): CuzkResult {
    const tree = this.parser.parse(xml) as {
      Envelope?: {
        Body?: {
          getIsirWsCuzkDataResponse?: {
            data?: RawCuzkData[];
            stav?: {
              pocetVysledku?: number;
              casSynchronizace?: string;
              kodChyby?: string;
              textChyby?: string;
              popisChyby?: string;
            };
          };
          Fault?: { faultstring?: string };
        };
      };
    };
    const body = tree.Envelope?.Body;
    if (!body) throw new Error('Malformed CUZK SOAP envelope (no Body)');
    if (body.Fault) throw new Error(`SOAP Fault: ${body.Fault.faultstring ?? 'unknown'}`);
    const r = body.getIsirWsCuzkDataResponse;
    if (!r) throw new Error('No getIsirWsCuzkDataResponse in body');

    const stav = r.stav ?? {};
    const errCode = stav.kodChyby;
    const isEmpty = errCode === 'WS2'; // documented "no results" code
    const isError = errCode && !isEmpty;

    const results: CuzkProceeding[] = (r.data ?? []).map(mapData).filter((p): p is CuzkProceeding => p !== null);

    return {
      results,
      total: stav.pocetVysledku ?? results.length,
      status: isError ? 'ERROR' : isEmpty ? 'EMPTY' : 'OK',
      error_code: errCode,
      error_message: stav.popisChyby ?? stav.textChyby,
      synchronized_at: stav.casSynchronizace,
    };
  }
}

interface RawCuzkData {
  ic?: string;
  rc?: string;
  cisloSenatu: number | string;
  druhVec: string;
  bcVec: number | string;
  rocnik: number | string;
  nazevOrganizace?: string;
  datumNarozeni?: string;
  titulPred?: string;
  titulZa?: string;
  jmeno?: string;
  nazevOsoby?: string;
  mesto?: string;
  ulice?: string;
  cisloPopisne?: string;
  druhStavKonkursu?: string;
  urlDetailRizeni?: string;
}

function mapData(r: RawCuzkData): CuzkProceeding | null {
  const cisloSenatu = Number(r.cisloSenatu);
  const bcVec = Number(r.bcVec);
  const rocnik = Number(r.rocnik);
  if (!Number.isFinite(cisloSenatu) || !Number.isFinite(bcVec) || !Number.isFinite(rocnik)) return null;

  const druhVec = String(r.druhVec ?? 'INS');
  const spisova_znacka = `${cisloSenatu} ${druhVec} ${bcVec}/${rocnik}`;
  const jmeno_full = [r.titulPred, r.jmeno, r.nazevOsoby, r.titulZa]
    .filter((s) => s && String(s).trim().length > 0)
    .join(' ')
    .trim();

  return {
    ic: r.ic ? String(r.ic) : undefined,
    rc: r.rc ? String(r.rc) : undefined,
    cislo_senatu: cisloSenatu,
    druh_vec: druhVec,
    bc_vec: bcVec,
    rocnik,
    spisova_znacka,
    nazev_organizace: r.nazevOrganizace,
    jmeno_osoby: jmeno_full || undefined,
    datum_narozeni: r.datumNarozeni,
    druh_stav_konkursu: r.druhStavKonkursu,
    url_detail: r.urlDetailRizeni,
    city: r.mesto,
    street: r.ulice && r.cisloPopisne ? `${r.ulice} ${r.cisloPopisne}` : r.ulice,
  };
}

function mapToInsolvencyStatus(p: CuzkProceeding, ico: string): InsolvencyStatus {
  return {
    ico,
    has_active: true,
    spisova_znacka: p.spisova_znacka,
    phase: p.druh_stav_konkursu,
  };
}

export function buildCuzkEnvelope(input: CuzkSearchInput): string {
  const fields: string[] = [];
  const add = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === '') return;
    fields.push(`<${k}>${escapeXml(String(v))}</${k}>`);
  };
  add('ic', input.ic);
  add('rc', input.rc);
  add('nazevOsoby', input.nazevOsoby);
  add('jmeno', input.jmeno);
  add('datumNarozeni', input.datumNarozeni);
  add('maxPocetVysledku', input.maxResults ?? 10);
  add('filtrAktualniRizeni', input.onlyActive === false ? 'F' : 'T');
  if (input.diacriticsInsensitive) add('vyhledatBezDiakritiky', 'T');
  if (input.exactNameMatch) add('vyhledatPresnouShoduJmen', 'T');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${SOAP_NS}">
  <soap:Body>
    <tns:getIsirWsCuzkDataRequest xmlns:tns="${TYPES_NS}">
      ${fields.join('\n      ')}
    </tns:getIsirWsCuzkDataRequest>
  </soap:Body>
</soap:Envelope>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}

function extractFault(body: string): string | null {
  const m = /<faultstring[^>]*>([^<]+)<\/faultstring>/i.exec(body);
  return m?.[1] ?? null;
}
