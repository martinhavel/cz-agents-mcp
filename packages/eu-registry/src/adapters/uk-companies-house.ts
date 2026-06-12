import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';

const API_BASE = 'https://api.company-information.service.gov.uk';
const SOURCE_BASE = 'https://find-and-update.company-information.service.gov.uk/company';
const REQUEST_TIMEOUT_MS = 10_000;

interface CompaniesHouseAddress {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

interface CompaniesHouseSearchItem {
  company_number?: string;
  title?: string;
  company_status?: string;
  address_snippet?: string;
  address?: CompaniesHouseAddress;
  date_of_creation?: string;
}

interface CompaniesHouseSearchResponse {
  items?: CompaniesHouseSearchItem[];
  total_results?: number;
}

interface CompaniesHouseCompanyResponse {
  company_number?: string;
  company_name?: string;
  company_status?: string;
  registered_office_address?: CompaniesHouseAddress;
  date_of_creation?: string;
}

export class UkCompaniesHouseAdapter implements RegistryAdapter {
  constructor(
    private readonly apiKey = process.env.CH_API_KEY,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    if (!this.apiKey) {
      warnMissingApiKey();
      return { companies: [], total_results: 0 };
    }

    const url = new URL('/search/companies', API_BASE);
    url.searchParams.set('q', name);
    url.searchParams.set('items_per_page', String(limit));

    const response = await this.fetchImpl(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Companies House search failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CompaniesHouseSearchResponse;
    const companies = (payload.items ?? [])
      .map(mapSearchItem)
      .filter((company): company is Company => company !== null);

    return {
      companies,
      total_results: payload.total_results ?? companies.length,
    };
  }

  async getById(id: string): Promise<Company | null> {
    if (!this.apiKey) {
      warnMissingApiKey();
      return null;
    }

    const response = await this.fetchImpl(`${API_BASE}/company/${encodeURIComponent(id)}`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Companies House company lookup failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as CompaniesHouseCompanyResponse;
    return mapCompany(payload);
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`,
      Accept: 'application/json',
    };
  }
}

function mapSearchItem(item: CompaniesHouseSearchItem): Company | null {
  if (!item.company_number || !item.title) return null;
  return {
    id: item.company_number,
    country: 'gb',
    name: item.title,
    status: mapStatus(item.company_status),
    address: item.address_snippet ?? formatAddress(item.address),
    registered_on: item.date_of_creation,
    source_url: `${SOURCE_BASE}/${item.company_number}`,
  };
}

function mapCompany(company: CompaniesHouseCompanyResponse): Company | null {
  if (!company.company_number || !company.company_name) return null;
  return {
    id: company.company_number,
    country: 'gb',
    name: company.company_name,
    status: mapStatus(company.company_status),
    address: formatAddress(company.registered_office_address),
    registered_on: company.date_of_creation,
    source_url: `${SOURCE_BASE}/${company.company_number}`,
  };
}

function mapStatus(status: string | undefined): CompanyStatus {
  if (status === 'active') return 'active';
  if (status === 'dissolved') return 'dissolved';
  return 'unknown';
}

function formatAddress(address: CompaniesHouseAddress | undefined): string | undefined {
  if (!address) return undefined;
  const parts = [
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.region,
    address.postal_code,
    address.country,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function warnMissingApiKey(): void {
  console.warn('[cz-agents/eu-registry] CH_API_KEY is not set; Companies House adapter disabled.');
}
