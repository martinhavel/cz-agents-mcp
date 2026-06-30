import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';

const API_BASE = 'https://data.brreg.no/enhetsregisteret/api';
const SOURCE_BASE = 'https://data.brreg.no/enhetsregisteret/oppslag/enheter';
const REQUEST_TIMEOUT_MS = 10_000;

interface BrregAddress {
  adresse?: string[];
  postnummer?: string;
  poststed?: string;
  land?: string;
}

interface BrregEntity {
  organisasjonsnummer?: string;
  navn?: string;
  konkurs?: boolean;
  underAvvikling?: boolean;
  slettedato?: string;
  stiftelsesdato?: string;
  forretningsadresse?: BrregAddress;
  postadresse?: BrregAddress;
}

interface BrregSearchResponse {
  _embedded?: { enheter?: BrregEntity[] };
  page?: { totalElements?: number };
}

export class NoBrregAdapter implements RegistryAdapter {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    const url = new URL(`${API_BASE}/enheter`);
    url.searchParams.set('navn', name);
    url.searchParams.set('size', String(limit));

    try {
      const response = await this.fetchImpl(url, requestInit());
      if (!response.ok) {
        warn(`BRREG search failed: ${response.status} ${response.statusText}`);
        return { companies: [], total_results: 0 };
      }

      const payload = (await response.json()) as BrregSearchResponse;
      const companies = (payload._embedded?.enheter ?? [])
        .map(mapEntity)
        .filter((company): company is Company => company !== null);

      return {
        companies,
        total_results: payload.page?.totalElements ?? companies.length,
      };
    } catch (error) {
      warn('BRREG search failed', error);
      return { companies: [], total_results: 0 };
    }
  }

  async getById(id: string): Promise<Company | null> {
    try {
      const response = await this.fetchImpl(
        `${API_BASE}/enheter/${encodeURIComponent(id)}`,
        requestInit(),
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        warn(`BRREG lookup failed: ${response.status} ${response.statusText}`);
        return null;
      }

      return mapEntity((await response.json()) as BrregEntity);
    } catch (error) {
      warn('BRREG lookup failed', error);
      return null;
    }
  }
}

function mapEntity(entity: BrregEntity): Company | null {
  if (!entity.organisasjonsnummer || !entity.navn) return null;

  return {
    id: entity.organisasjonsnummer,
    country: 'no',
    name: entity.navn,
    status: mapStatus(entity),
    address: formatAddress(entity.forretningsadresse ?? entity.postadresse),
    registered_on: entity.stiftelsesdato,
    source_url: `${SOURCE_BASE}/${entity.organisasjonsnummer}`,
  };
}

function mapStatus(entity: BrregEntity): CompanyStatus {
  if (entity.konkurs || entity.underAvvikling || entity.slettedato) return 'dissolved';
  return 'active';
}

function formatAddress(address: BrregAddress | undefined): string | undefined {
  if (!address) return undefined;
  const parts = [
    ...(address.adresse ?? []),
    address.postnummer,
    address.poststed,
    address.land,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function requestInit(): RequestInit {
  return {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  };
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
  else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
}
