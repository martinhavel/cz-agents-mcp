import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';
import { GleifAdapter } from './de-gleif.js';

const TOKEN_URL = 'https://portal.api.bolagsverket.se/oauth2/token';
const API_BASE = 'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1';
const SOURCE_URL = 'https://foretagsinfo.bolagsverket.se/sok-foretagsinformation-web/';
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_SCOPE = 'vardefulla-datamangder:read';
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const NOT_CONFIGURED =
  'Sweden Bolagsverket not configured: set SE_BOLAGSVERKET_CLIENT_ID and SE_BOLAGSVERKET_CLIENT_SECRET';

interface SeCodeText {
  kod?: string | null;
  klartext?: string | null;
}

interface SeName {
  namn?: string | null;
  organisationsnamntyp?: SeCodeText | null;
  registreringsdatum?: string | null;
}

interface SePostalAddress {
  postnummer?: string | null;
  utdelningsadress?: string | null;
  land?: string | null;
  coAdress?: string | null;
  postort?: string | null;
}

interface SeOrganisation {
  organisationsidentitet?: { identitetsbeteckning?: string | null } | null;
  organisationsnamn?: { organisationsnamnLista?: SeName[] | null } | null;
  verksamOrganisation?: { kod?: string | null } | null;
  avregistreradOrganisation?: { avregistreringsdatum?: string | null } | null;
  organisationsdatum?: { registreringsdatum?: string | null } | null;
  postadressOrganisation?: { postadress?: SePostalAddress | null } | null;
  reklamsparr?: { kod?: string | null } | null;
}

interface SeOrganisationResponse {
  organisationer?: SeOrganisation[];
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

export interface SeBolagsverketAdapterOptions {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  searchAdapter?: RegistryAdapter;
  now?: () => number;
}

/**
 * Sweden's official Bolagsverket HVD API supports exact organisation-number
 * lookups but not name search. Name search therefore delegates to GLEIF/LEI,
 * while getById returns the richer official national-registry record.
 */
export class SeBolagsverketAdapter implements RegistryAdapter {
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly searchAdapter: RegistryAdapter;
  private readonly now: () => number;
  private token?: { value: string; expiresAt: number };

  constructor(options: SeBolagsverketAdapterOptions = {}) {
    this.clientId = options.clientId ?? process.env.SE_BOLAGSVERKET_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? process.env.SE_BOLAGSVERKET_CLIENT_SECRET;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.searchAdapter = options.searchAdapter ?? new GleifAdapter('SE', this.fetchImpl);
    this.now = options.now ?? Date.now;
  }

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    return this.searchAdapter.searchByName(name, limit);
  }

  async getById(id: string): Promise<Company | null> {
    if (!this.isConfigured()) {
      warn(NOT_CONFIGURED);
      return null;
    }

    const normalizedId = normalizeOrganisationNumber(id);
    if (!normalizedId) return null;

    try {
      const token = await this.getAccessToken();
      const response = await this.fetchImpl(`${API_BASE}/organisationer`, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Request-Id': crypto.randomUUID(),
        },
        body: JSON.stringify({ identitetsbeteckning: normalizedId }),
      });

      if (response.status === 404) return null;
      if (!response.ok) {
        warn(`Bolagsverket lookup failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const payload = (await response.json()) as SeOrganisationResponse;
      const record = payload.organisationer?.find(
        (item) => item.organisationsidentitet?.identitetsbeteckning === normalizedId,
      );
      return mapOrganisation(record);
    } catch (error) {
      warn('Bolagsverket lookup failed', error);
      return null;
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: TOKEN_SCOPE,
    });
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Bolagsverket OAuth failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as TokenResponse;
    if (!payload.access_token) throw new Error('Bolagsverket OAuth response did not contain access_token');

    const ttlMs = Math.max(0, (payload.expires_in ?? 3600) * 1000 - TOKEN_EXPIRY_SKEW_MS);
    this.token = { value: payload.access_token, expiresAt: this.now() + ttlMs };
    return payload.access_token;
  }
}

function normalizeOrganisationNumber(value: string): string | null {
  const normalized = value.replace(/[\s-]/g, '');
  return /^\d{10}$/.test(normalized) ? normalized : null;
}

function mapOrganisation(record: SeOrganisation | undefined): Company | null {
  if (!record) return null;
  const id = record.organisationsidentitet?.identitetsbeteckning ?? undefined;
  const names = record.organisationsnamn?.organisationsnamnLista ?? [];
  const legalName = names.find((item) => item.organisationsnamntyp?.kod === 'FORETAGSNAMN')?.namn
    ?? names[0]?.namn
    ?? undefined;
  if (!id || !legalName) return null;

  return {
    id,
    country: 'se',
    name: legalName,
    status: mapStatus(record),
    address: formatAddress(record.postadressOrganisation?.postadress ?? undefined),
    registered_on: record.organisationsdatum?.registreringsdatum ?? undefined,
    source_url: SOURCE_URL,
    ...(record.reklamsparr?.kod === 'JA' ? { marketing_protected: true } : {}),
  };
}

function mapStatus(record: SeOrganisation): CompanyStatus {
  if (record.verksamOrganisation?.kod === 'JA') return 'active';
  if (record.verksamOrganisation?.kod === 'NEJ' || record.avregistreradOrganisation?.avregistreringsdatum) {
    return 'dissolved';
  }
  return 'unknown';
}

function formatAddress(address: SePostalAddress | undefined): string | undefined {
  if (!address) return undefined;
  const parts = [
    address.coAdress,
    address.utdelningsadress,
    address.postnummer,
    address.postort,
    address.land,
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
  else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
}
