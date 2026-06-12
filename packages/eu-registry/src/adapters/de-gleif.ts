import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';
import { SEARCH_TTL_MS } from '../gleif-cache.js';
import type { GleifCache } from '../gleif-cache.js';

// GLEIF (Global Legal Entity Identifier Foundation) — free, no auth, ISO 17442.
// Covers companies with LEIs (mid-large entities). Small firms without LEIs won't appear.
// Rate limit: 60 req/min. Supports any jurisdiction via filter[entity.jurisdiction].
const API_BASE = 'https://api.gleif.org/api/v1';
const REQUEST_TIMEOUT_MS = 10_000;

interface GleifAddress {
  addressLines?: string[];
  city?: string;
  postalCode?: string;
  country?: string;
}

interface GleifEntity {
  legalName?: { name?: string };
  status?: string;
  jurisdiction?: string;
  registeredAs?: string;
  creationDate?: string;
  legalAddress?: GleifAddress;
}

interface GleifRecord {
  id?: string;
  attributes?: { entity?: GleifEntity };
}

interface GleifResponse {
  data?: GleifRecord[];
  meta?: { pagination?: { total?: number } };
}

/** Generic GLEIF adapter — pass an ISO 3166-1 alpha-2 jurisdiction (e.g. 'DE', 'NL'). */
export class GleifAdapter implements RegistryAdapter {
  private readonly countryCode: string;

  constructor(
    private readonly jurisdiction: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly cache?: GleifCache,
  ) {
    this.countryCode = jurisdiction.toLowerCase();
  }

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    const cacheKey = `search:${this.jurisdiction}:${name}:${limit}`;
    if (this.cache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== null) return cached as CompanySearchResult;
    }

    const url = new URL(`${API_BASE}/lei-records`);
    url.searchParams.set('filter[fulltext]', name);
    url.searchParams.set('filter[entity.jurisdiction]', this.jurisdiction.toUpperCase());
    url.searchParams.set('page[size]', String(limit));

    try {
      const response = await this.fetchImpl(url, requestInit());
      if (!response.ok) {
        warn(`GLEIF search failed: ${response.status} ${response.statusText}`);
        return { companies: [], total_results: 0 };
      }

      const payload = (await response.json()) as GleifResponse;
      const cc = this.countryCode;
      const companies = (payload.data ?? [])
        .map((r) => mapRecord(r, cc))
        .filter((c): c is Company => c !== null);

      const result: CompanySearchResult = {
        companies,
        total_results: payload.meta?.pagination?.total ?? companies.length,
      };
      this.cache?.set(cacheKey, result, SEARCH_TTL_MS);
      return result;
    } catch (error) {
      warn('GLEIF search failed', error);
      return { companies: [], total_results: 0 };
    }
  }

  async getById(id: string): Promise<Company | null> {
    // Include countryCode: a shared cache is used across GLEIF jurisdictions (NL/DE),
    // and mapRecord stamps `country` from this.countryCode — a bare `lei:${id}` key
    // would let one jurisdiction's cached Company leak into another.
    const cacheKey = `lei:${this.countryCode}:${id}`;
    if (this.cache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== null) return cached as Company;
    }

    const url = new URL(`${API_BASE}/lei-records/${encodeURIComponent(id)}`);

    try {
      const response = await this.fetchImpl(url, requestInit());
      if (response.status === 404) return null;
      if (!response.ok) {
        warn(`GLEIF lookup failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const payload = (await response.json()) as { data?: GleifRecord };
      const company = payload.data ? mapRecord(payload.data, this.countryCode) : null;
      // Don't cache null — company not found yet may be added later.
      if (company !== null) this.cache?.set(cacheKey, company);
      return company;
    } catch (error) {
      warn('GLEIF lookup failed', error);
      return null;
    }
  }
}

/** Backward-compat alias for DE. */
export class DeGleifAdapter extends GleifAdapter {
  constructor(fetchImpl: typeof fetch = globalThis.fetch, cache?: GleifCache) {
    super('DE', fetchImpl, cache);
  }
}

function mapRecord(record: GleifRecord, countryCode: string): Company | null {
  const lei = record.id;
  const entity = record.attributes?.entity;
  const name = entity?.legalName?.name;
  if (!lei || !name) return null;

  return {
    id: lei,
    country: countryCode,
    name,
    status: mapStatus(entity?.status),
    address: formatAddress(entity?.legalAddress),
    registered_on: entity?.creationDate?.slice(0, 10),
    lei,
    source_url: `https://search.gleif.org/#/record/${lei}`,
  };
}

function mapStatus(status: string | undefined): CompanyStatus {
  const s = status?.toUpperCase();
  if (s === 'ACTIVE') return 'active';
  if (s === 'INACTIVE') return 'dissolved';
  return 'unknown';
}

function formatAddress(addr: GleifAddress | undefined): string | undefined {
  if (!addr) return undefined;
  const parts = [
    ...(addr.addressLines ?? []),
    addr.postalCode,
    addr.city,
  ].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function requestInit(): RequestInit {
  return {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/vnd.api+json' },
  };
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
  else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
}
