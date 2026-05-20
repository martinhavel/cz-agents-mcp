import type { Company, CompanySearchResult, RegistryAdapter } from '../types.js';

const API_BASE = 'https://rpo.statistics.sk/rpo/api/v1';

interface SkOrsrLegalForm {
  value?: string;
}

interface SkOrsrAddress {
  formattedAddress?: string;
}

interface SkOrsrSubject {
  cin?: string;
  name?: string;
  legalForm?: SkOrsrLegalForm;
  address?: SkOrsrAddress;
  registrationDate?: string;
  terminationDate?: string | null;
}

interface SkOrsrSearchResponse {
  content?: SkOrsrSubject[];
  totalElements?: number;
}

export class SkOrsrAdapter implements RegistryAdapter {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    const url = new URL('/rpo/api/v1/subject', API_BASE);
    url.searchParams.set('name', name);
    url.searchParams.set('page', '0');
    url.searchParams.set('size', String(limit));

    try {
      const response = await this.fetchImpl(url);
      if (!response.ok) {
        warn(`ORSR search failed: ${response.status} ${response.statusText}`);
        return { companies: [], total_results: 0 };
      }

      const payload = (await response.json()) as SkOrsrSearchResponse;
      const companies = (payload.content ?? [])
        .map(mapSubject)
        .filter((company): company is Company => company !== null);

      return {
        companies,
        total_results: payload.totalElements ?? companies.length,
      };
    } catch (error) {
      warn('ORSR search failed', error);
      return { companies: [], total_results: 0 };
    }
  }

  async getById(id: string): Promise<Company | null> {
    try {
      const response = await this.fetchImpl(`${API_BASE}/subject/${encodeURIComponent(id)}`);
      if (response.status === 404) return null;
      if (!response.ok) {
        warn(`ORSR company lookup failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const payload = (await response.json()) as SkOrsrSubject;
      return mapSubject(payload);
    } catch (error) {
      warn('ORSR company lookup failed', error);
      return null;
    }
  }
}

function mapSubject(subject: SkOrsrSubject): Company | null {
  if (!subject.cin || !subject.name) return null;
  return {
    id: subject.cin,
    country: 'sk',
    name: subject.name,
    status: subject.terminationDate === null ? 'active' : 'dissolved',
    address: subject.address?.formattedAddress,
    registered_on: subject.registrationDate,
    source_url: `https://www.orsr.sk/hladanie.asp?OBMENO=${encodeURIComponent(subject.name)}&BTN=Hľadaj`,
  };
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
  else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
}
