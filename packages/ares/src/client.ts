import { HttpClient, TtlCache } from '@cz-agents/shared';

/**
 * Typed client for ARES REST v3 API.
 * Docs: https://ares.gov.cz/stranky/vyvojar-info
 * OpenAPI: https://ares.gov.cz/swagger-ui/
 */

const ARES_BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty';

// ---- Response types (subset of ARES v3) ----

export interface AresSubject {
  ico: string;
  obchodniJmeno?: string;
  dic?: string;
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
    sidlo?: { nazevObce?: string; psc?: number };
    start?: number;
    pocet?: number; // max 100
  }): Promise<AresSearchResult> {
    const body: Record<string, any> = {};
    if (params.ico?.length) body.ico = params.ico;
    if (params.obchodniJmeno) body.obchodniJmeno = params.obchodniJmeno;
    if (params.pravniForma?.length) body.pravniForma = params.pravniForma;
    if (params.sidlo) body.sidlo = params.sidlo;
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

  /** Historical records for subject (previous names, sídlo changes). */
  async getHistory(ico: string): Promise<unknown> {
    try {
      return await this.http.getJson(`/${ico}/historie`);
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw e;
    }
  }
}
