/**
 * IsirClient — talks to the ISIR public web service.
 *
 * Endpoint: https://isir.justice.cz:8443/isir_public_ws/IsirWsPublicService
 * Operation: getIsirWsPublicPodnetId — event-streaming feed.
 *
 * Architecture note: ISIR public WS is *not* an IČO-lookup API. It's an
 * append-only event log: pass `idPodnetu` (last received event ID), get back
 * up to ~1000 newer events. Each event has spisovaZnacka, typUdalosti,
 * popisUdalosti, etc. — but **no IČO field**.
 *
 * For "is this IČO insolvent?" you must:
 *   1. Periodically `pollEvents(lastSeenId)` to ingest the firehose
 *   2. Maintain a local SQLite index mapping spisovaZnacka -> debtor IČO
 *   3. Index is built from the ISIR_CUZK_WS2 service (separate WS) which
 *      *does* expose IČO for each debtor — TODO v0.2.0
 *
 * v0.1.1 ships:
 *   - Working SOAP envelope + parser for getIsirWsPublicPodnetId
 *   - `pollEvents(idPodnetu)` returns parsed events (real data)
 *   - `checkActiveInsolvency(ico)` still returns null (needs WS2 + index)
 *
 * Set ISIR_SOAP_ENABLED=1 to actually hit the network. Default is offline
 * stub that returns null/[] to avoid fragile-network tests in CI.
 */
import { XMLParser } from 'fast-xml-parser';
import type { InsolvencyStatus, ProceedingDetail } from './types.js';
import { CuzkClient, type CuzkProceeding } from './cuzk.js';

const DEFAULT_ENDPOINT =
  'https://isir.justice.cz:8443/isir_public_ws/IsirWsPublicService';

export interface IsirEvent {
  id: number;
  datum_zalozeni: string;
  datum_zverejneni: string;
  spisova_znacka: string;
  typ_udalosti: string;
  popis_udalosti: string;
  oddil?: string;
  cislo_v_oddilu?: number;
  dokument_url?: string;
  poznamka?: string;
}

export interface PollResult {
  events: IsirEvent[];
  /** Highest event id seen — pass this as `idPodnetu` next time. */
  last_id: number;
  status: 'OK' | 'CHYBA';
  error_code?: string;
  error_message?: string;
}

export interface IsirClientOptions {
  endpoint?: string;
  /** When true, the client always returns null/[]. CI default. */
  stub?: boolean;
  fetchImpl?: typeof fetch;
}

export class IsirClient {
  private readonly endpoint: string;
  private readonly stub: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly parser: XMLParser;
  private readonly cuzk: CuzkClient;

  constructor(opts: IsirClientOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.stub = opts.stub ?? !process.env.ISIR_SOAP_ENABLED;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cuzk = new CuzkClient({ stub: this.stub, fetchImpl: this.fetchImpl });
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      // poznamka contains escaped XML blob with hundreds of &lt; / &amp; entities;
      // default fast-xml-parser limit is 1000 and live ISIR responses blow past it.
      // We keep poznamka as raw escaped string for downstream parsing.
      processEntities: false,
      isArray: (name) => name === 'data',
    });
  }

  /**
   * Pull all events with id > idPodnetu (up to ~1000 per call). Iterate by
   * passing back result.last_id until events.length === 0.
   * v0.1.1: real SOAP call against ISIR public WS.
   */
  async pollEvents(idPodnetu: number = 0): Promise<PollResult> {
    if (this.stub) {
      return { events: [], last_id: idPodnetu, status: 'OK' };
    }
    const xml = buildEnvelope(idPodnetu);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 60_000);
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
      // Try to extract SOAP fault for human-readable error
      const fault = extractFault(body);
      throw new Error(`ISIR HTTP ${resp.status}${fault ? `: ${fault}` : ''}`);
    }
    return this.parseResponse(body);
  }

  /**
   * Returns active insolvency status for an IČO, or null if no proceeding.
   * v0.2.0: backed by IsirWsCuzkService (IČO-indexed lookup).
   */
  async checkActiveInsolvency(ico: string): Promise<InsolvencyStatus | null> {
    return this.cuzk.checkActiveByIco(ico);
  }

  /**
   * Search ISIR for an individual by name + optional date of birth.
   * Returns active insolvency proceedings (oddlužení / osobní bankrot).
   * Use for screening statutory persons in due-diligence reports.
   */
  async searchPersonInsolvency(input: {
    name: string;
    dob?: string;
    onlyActive?: boolean;
  }): Promise<CuzkProceeding[]> {
    return this.cuzk.searchPerson(input);
  }

  /** Detail for a known proceeding ID. Future iteration. */
  async getProceedingDetail(_id: string | number): Promise<ProceedingDetail | null> {
    return null;
  }

  /** Recent proceedings since a date. Future iteration. */
  async listRecentProceedings(_sinceIso: string): Promise<InsolvencyStatus[]> {
    return [];
  }

  parseResponse(xml: string): PollResult {
    const tree = this.parser.parse(xml) as {
      Envelope?: {
        Body?: {
          getIsirWsPublicDataResponse?: {
            data?: RawEvent[];
            status?: { stav?: string; kodChyby?: string; popisChyby?: string };
          };
          Fault?: { faultstring?: string };
        };
      };
    };
    const body = tree.Envelope?.Body;
    if (!body) throw new Error('Malformed SOAP envelope (no Body)');
    if (body.Fault) throw new Error(`SOAP Fault: ${body.Fault.faultstring ?? 'unknown'}`);
    const r = body.getIsirWsPublicDataResponse;
    if (!r) throw new Error('No getIsirWsPublicDataResponse in body');

    const events: IsirEvent[] = (r.data ?? []).map(mapEvent).filter((e): e is IsirEvent => e !== null);
    const last_id = events.reduce((max, e) => (e.id > max ? e.id : max), 0);
    return {
      events,
      last_id,
      status: (r.status?.stav as 'OK' | 'CHYBA') ?? 'OK',
      error_code: r.status?.kodChyby,
      error_message: r.status?.popisChyby,
    };
  }
}

interface RawEvent {
  id: number | string;
  datumZalozeniUdalosti: string;
  datumZverejneniUdalosti: string;
  spisovaZnacka: string;
  typUdalosti: string | number;
  popisUdalosti: string;
  oddil?: string;
  cisloVOddilu?: number | string;
  dokumentUrl?: string;
  poznamka?: string;
}

function mapEvent(r: RawEvent): IsirEvent | null {
  const id = Number(r.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    datum_zalozeni: String(r.datumZalozeniUdalosti),
    datum_zverejneni: String(r.datumZverejneniUdalosti),
    spisova_znacka: String(r.spisovaZnacka),
    typ_udalosti: String(r.typUdalosti),
    popis_udalosti: String(r.popisUdalosti),
    oddil: r.oddil ? String(r.oddil) : undefined,
    cislo_v_oddilu: r.cisloVOddilu !== undefined ? Number(r.cisloVOddilu) : undefined,
    dokument_url: r.dokumentUrl,
    poznamka: r.poznamka,
  };
}

export function buildEnvelope(idPodnetu: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <tns:getIsirWsPublicIdDataRequest xmlns:tns="http://isirpublicws.cca.cz/types/">
      <idPodnetu>${Math.floor(idPodnetu)}</idPodnetu>
    </tns:getIsirWsPublicIdDataRequest>
  </soap:Body>
</soap:Envelope>`;
}

function extractFault(body: string): string | null {
  const m = /<faultstring[^>]*>([^<]+)<\/faultstring>/i.exec(body);
  return m?.[1] ?? null;
}
