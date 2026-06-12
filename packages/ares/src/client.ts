import { HttpClient, TtlCache } from '@czagents/shared';

/**
 * Typed client for ARES REST v3 API.
 * Docs: https://ares.gov.cz/stranky/vyvojar-info
 * OpenAPI: https://ares.gov.cz/swagger-ui/
 */

const ARES_BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty';
const ARES_VR_BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty-vr';
const ARES_RES_BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty-res';

// ---- Response types (subset of ARES v3) ----

export interface AresSubject {
  ico: string;
  obchodniJmeno?: string;
  dic?: string;
  /** VAT-group DIČ (skupinové DIČ pro DPH). Present when the subject is a member
   *  of a Czech VAT group (§ 5a ZDPH). ADIS must be called with this DIČ, not `dic`. */
  dicSkDph?: string;
  sidlo?: {
    kodStatu?: string;
    nazevStatu?: string;
    kodObce?: number;
    nazevObce?: string;
    kodUlice?: number;
    nazevUlice?: string;
    cisloDomovni?: number;
    cisloOrientacni?: string;
    psc?: number;
    textovaAdresa?: string;
  };
  pravniForma?: string;
  datumVzniku?: string;
  datumZaniku?: string;
  financniUrad?: string;
  zivnosti?: Array<{ predmetPodnikani?: string }>;
  czNace?: string[];
  primarniZdroj?: string;
  /** CZ-NACE code of prevailing activity from ARES RES endpoint (ČSÚ statistical register).
   *  Populated by getResNacePrevazujici(); undefined when RES is unavailable or returned nothing. */
  czNacePrevazujici?: string;
}

export interface AresSearchResult {
  pocetCelkem: number;
  ekonomickeSubjekty: AresSubject[];
}

export interface AresBankAccount {
  cisloUctu: string;
  kodBanky: string;
  menaUctu?: string;
  datumZverejneni?: string;
}

export interface AresVrRecord {
  ico: string;
  obchodniJmeno?: string;
  spisovaZnacka?: string;
  rejstrik?: string;
  stavSubjektu?: string;
  datumZapisu?: string;
  zakladniKapital?: unknown;
  spolecnici?: Array<{
    spolecnik?: Array<{
      osoba?: {
        fyzickaOsoba?: {
          jmeno?: string;
          prijmeni?: string;
          titulPredJmenem?: string;
          titulZaJmenem?: string;
          datumNarozeni?: string;
          adresa?: {
            kodStatu?: string;
            nazevStatu?: string;
            textovaAdresa?: string;
          };
        };
        pravnickaOsoba?: {
          ico?: string;
          nazev?: string;
          obchodniJmeno?: string;
          adresa?: {
            kodStatu?: string;
            nazevStatu?: string;
            textovaAdresa?: string;
          };
        };
      };
      podil?: Array<{
        velikostPodilu?: { hodnota?: string };
        vklad?: { hodnota?: string };
      }>;
      datumZapisu?: string;
      datumVymazu?: string | null;
    }>;
  }>;
  akcionari?: Array<{
    clenoveOrganu?: Array<{
      fyzickaOsoba?: {
        jmeno?: string;
        prijmeni?: string;
        titulPredJmenem?: string;
        titulZaJmenem?: string;
        datumNarozeni?: string;
        adresa?: {
          kodStatu?: string;
          nazevStatu?: string;
          textovaAdresa?: string;
        };
      };
      pravnickaOsoba?: {
        ico?: string;
        nazev?: string;
        obchodniJmeno?: string;
        adresa?: {
          kodStatu?: string;
          nazevStatu?: string;
          textovaAdresa?: string;
        };
      };
      datumZapisu?: string;
      datumVymazu?: string | null;
    }>;
  }>;
  statutarniOrgany?: Array<{
    nazevOrganu?: string;
    datumZapisu?: string;
    datumVymazu?: string;
    clenoveOrganu?: Array<{
      fyzickaOsoba?: {
        jmeno?: string;
        prijmeni?: string;
        titulPredJmenem?: string;
        titulZaJmenem?: string;
        datumNarozeni?: string;
      };
      pravnickaOsoba?: {
        obchodniJmeno?: string;
        ico?: string;
      };
      funkce?: { nazev?: string };
      datumZapisu?: string;
      datumVymazu?: string;
    }>;
  }>;
}

export class AresClient {
  private readonly http: HttpClient;
  // ARES company data changes rarely — cache lookups 1 hour to ease upstream load
  private readonly subjectCache = new TtlCache<string, AresSubject | null>({
    ttlMs: 60 * 60 * 1000, // 1 hour
    maxSize: 5000,
  });
  private readonly bankCache = new TtlCache<string, AresBankAccount[]>({
    ttlMs: 60 * 60 * 1000,
    maxSize: 2000,
  });
  private readonly vrCache = new TtlCache<string, AresVrRecord | null>({
    ttlMs: 60 * 60 * 1000, // 1 hour
    maxSize: 5000,
  });
  private readonly historyCache = new TtlCache<string, unknown>({
    ttlMs: 24 * 60 * 60 * 1000, // 24 hours — history is immutable
    maxSize: 2000,
  });
  // RES (ČSÚ statistical register) — prevailing activity code; cached 1h
  private readonly resNaceCache = new TtlCache<string, string | null>({
    ttlMs: 60 * 60 * 1000,
    maxSize: 5000,
  });

  constructor() {
    this.http = new HttpClient({
      baseUrl: ARES_BASE,
      timeoutMs: 12_000,
      retries: 2,
    });
  }

  /** Get single economic subject by IČO. 404 → null (not an error). Cached 1h. */
  async getByIco(ico: string): Promise<AresSubject | null> {
    return this.subjectCache.memoize(ico, async () => {
      try {
        return await this.http.getJson<AresSubject>(`/${ico}`);
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    });
  }

  /** Full-text search. ARES v3 accepts POST with `obchodniJmeno`, `sidlo.*`, etc. */
  async search(params: {
    query?: string;
    ico?: string[];
    obchodniJmeno?: string;
    pravniForma?: string[];
    sidlo?: { nazevUlice?: string; nazevObce?: string; psc?: number; kodObce?: number };
    czNace?: string[];
    start?: number;
    pocet?: number; // max 100
  }): Promise<AresSearchResult> {
    const body: Record<string, any> = {};
    if (params.ico?.length) body.ico = params.ico;
    if (params.obchodniJmeno) body.obchodniJmeno = params.obchodniJmeno;
    if (params.pravniForma?.length) body.pravniForma = params.pravniForma;
    if (params.sidlo) body.sidlo = params.sidlo;
    if (params.czNace?.length) body.czNace = params.czNace;
    if (params.query && !body.obchodniJmeno) body.obchodniJmeno = params.query;

    body.start = params.start ?? 0;
    body.pocet = Math.min(params.pocet ?? 10, 100);

    return await this.http.getJson<AresSearchResult>(
      '/vyhledat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }

  /**
   * Get transparent bank accounts published for this IČO (DPH registered subjects).
   * ARES wraps the ADIS registry here.
   */
  async getBankAccounts(ico: string): Promise<AresBankAccount[]> {
    return this.bankCache.memoize(ico, async () => {
      try {
        const data = await this.http.getJson<{ uctyCslib?: AresBankAccount[] }>(
          `/ekonomicky-subjekt-cuds/${ico}`,
        );
        return data.uctyCslib ?? [];
      } catch (e: any) {
        if (e?.status === 404) return [];
        throw e;
      }
    });
  }

  /**
   * Returns the CZ-NACE code of the prevailing activity from the ARES RES endpoint
   * (ČSÚ statistical register, `/ekonomicke-subjekty-res/{ico}`).
   *
   * GRACEFUL: uses a short 5s timeout; if the endpoint is unreachable, returns 404,
   * or does not carry `czNacePrevazujici`, returns undefined — never throws.
   * The caller must not let a RES failure block the main lookup.
   */
  async getResNacePrevazujici(ico: string): Promise<string | undefined> {
    const cached = await this.resNaceCache.memoize(ico, async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5_000);
        try {
          const url = `${ARES_RES_BASE}/${ico}`;
          const res = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'cz-agents-mcp/0.1 (+https://cz-agents.dev)' },
          });
          if (!res.ok) return null;
          const data = await res.json() as { czNacePrevazujici?: string };
          return data.czNacePrevazujici ?? null;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return null;
      }
    });
    return cached ?? undefined;
  }

  /** Historical records for subject (previous names, sídlo changes). */
  async getHistory(ico: string): Promise<unknown> {
    return this.historyCache.memoize(ico, async () => {
      try {
        return await this.http.getJson(`/${ico}/historie`);
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    });
  }

  /**
   * Get Veřejný rejstřík record (active only, currently-valid statutory bodies).
   * Filters out historical entries (datumVymazu != null) by default.
   */
  async getVrRecord(ico: string): Promise<AresVrRecord | null> {
    return this.vrCache.memoize(ico, async () => {
      try {
        // VR is sibling endpoint, use absolute URL to escape base path
        const data = await this.http.getJson<{ zaznamy: AresVrRecord[] }>(
          `${ARES_VR_BASE}/${ico}`,
        );
        // Prefer AKTIVNI record — companies with historical entries (e.g. former
        // branch offices, Generali Česká pojišťovna IČO 45272956) have a HISTORICKY
        // record at index 0 with empty statutarniOrgany; real data is in AKTIVNI.
        const zaznamy = data.zaznamy ?? [];
        return zaznamy.find((r) => r.stavSubjektu === 'AKTIVNI') ?? zaznamy[0] ?? null;
      } catch (e: any) {
        if (e?.status === 404) return null;
        throw e;
      }
    });
  }
}
