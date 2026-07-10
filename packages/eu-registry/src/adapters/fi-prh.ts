import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';

const API_BASE = 'https://avoindata.prh.fi/opendata-ytj-api/v3';
const SOURCE_BASE = 'https://tietopalvelu.ytj.fi/yritys';
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'cz-agents eu-registry (+https://github.com/martinhavel/cz-agents-mcp)';

// Live PRH YTJ v3 schema verified 2026-07-10 with name=Nokia and businessId=0112038-9.
interface PrhBusinessId {
  value?: string;
  registrationDate?: string;
}

interface PrhName {
  name?: string;
  type?: string;
  endDate?: string;
}

interface PrhPostOffice {
  city?: string;
  languageCode?: string;
}

interface PrhAddress {
  type?: number;
  street?: string;
  postCode?: string;
  postOffices?: PrhPostOffice[];
  postOfficeBox?: string;
  buildingNumber?: string;
  entrance?: string;
  apartmentNumber?: string;
  apartmentIdSuffix?: string;
  co?: string;
}

interface PrhCompany {
  businessId?: PrhBusinessId;
  names?: PrhName[];
  addresses?: PrhAddress[];
  // Observed values: "1" = Registered and "4" = Ceased.
  tradeRegisterStatus?: string;
  registrationDate?: string;
}

interface PrhCompaniesResponse {
  totalResults?: number;
  companies?: PrhCompany[];
}

export class FiPrhAdapter implements RegistryAdapter {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    const url = new URL(`${API_BASE}/companies`);
    url.searchParams.set('name', name);

    try {
      const response = await this.fetchImpl(url, requestInit());
      if (!response.ok) {
        warn(`PRH YTJ search failed: ${response.status} ${response.statusText}`);
        return { companies: [], total_results: 0 };
      }

      const payload = (await response.json()) as PrhCompaniesResponse;
      const companies = (payload.companies ?? [])
        .map(mapCompany)
        .filter((company): company is Company => company !== null)
        .slice(0, limit);

      return {
        companies,
        total_results: payload.totalResults ?? companies.length,
      };
    } catch (error) {
      warn('PRH YTJ search failed', error);
      return { companies: [], total_results: 0 };
    }
  }

  async getById(id: string): Promise<Company | null> {
    const url = new URL(`${API_BASE}/companies`);
    url.searchParams.set('businessId', id);

    try {
      const response = await this.fetchImpl(url, requestInit());
      if (!response.ok) {
        warn(`PRH YTJ lookup failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const payload = (await response.json()) as PrhCompaniesResponse;
      const company = mapCompany(payload.companies?.[0]);
      return company?.id === id ? company : null;
    } catch (error) {
      warn('PRH YTJ lookup failed', error);
      return null;
    }
  }
}

function mapCompany(company: PrhCompany | undefined): Company | null {
  const id = company?.businessId?.value;
  const name = currentLegalName(company?.names);
  if (!id || !name) return null;

  return {
    id,
    country: 'fi',
    name,
    status: mapStatus(company.tradeRegisterStatus),
    address: formatAddress(company.addresses),
    registered_on: company.registrationDate,
    source_url: `${SOURCE_BASE}/${id}`,
  };
}

function currentLegalName(names: PrhName[] | undefined): string | undefined {
  return names?.find((name) => name.type === '1' && !name.endDate)?.name
    ?? names?.find((name) => name.type === '1')?.name;
}

function mapStatus(tradeRegisterStatus: string | undefined): CompanyStatus {
  if (tradeRegisterStatus === '1') return 'active';
  if (tradeRegisterStatus === '4') return 'dissolved';
  return 'unknown';
}

function formatAddress(addresses: PrhAddress[] | undefined): string | undefined {
  const address = addresses?.find((item) => item.type === 1) ?? addresses?.[0];
  if (!address) return undefined;
  const postOffice = address.postOffices?.find((item) => item.languageCode === '1') ?? address.postOffices?.[0];
  const street = [address.street, address.buildingNumber].filter(Boolean).join(' ');
  const apartment = [address.entrance, address.apartmentNumber, address.apartmentIdSuffix]
    .filter(Boolean)
    .join(' ');
  const parts = [
    address.co ? `c/o ${address.co.startsWith('c/o ') ? address.co.slice(4) : address.co}` : undefined,
    street || undefined,
    apartment || undefined,
    address.postOfficeBox ? `PO Box ${address.postOfficeBox}` : undefined,
    address.postCode,
    postOffice?.city,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function requestInit(): RequestInit {
  return {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  };
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
  else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
}
