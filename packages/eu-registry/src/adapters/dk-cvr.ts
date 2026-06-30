import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';

// Prefer the official Erhvervsstyrelsen/Virk distribution API over cvrapi.dk:
// it requires credentials, but avoids the unauthenticated fallback's rate-limit/null-result behavior.
//
// SECURITY (ověřeno 2026-06-30): distribution.virk.dk je HTTP-only — :443/https timeoutuje
// (žádný TLS), jen plaintext http odpovídá (401 s creds). Basic auth (DK_CVR_USER/PASS) proto
// jde nešifrovaně. NEMĚNIT na https — integrace se rozbije (upstream nemá TLS na tomto endpointu).
// Riziko akceptováno: (a) v prod NOT-configured (bez creds se Authorization header neposílá =
// latentní); (b) creds = jen přístup k VEŘEJNÝM CVR datům (ne PII/platby/secret), nízká hodnota.
// Pokud by se DK CVR konfigurovalo citlivějšími creds → najít https Virk alternativu.
const API_BASE = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';
const SOURCE_BASE = 'https://datacvr.virk.dk/enhed/virksomhed';
const REQUEST_TIMEOUT_MS = 10_000;
const NOT_CONFIGURED = 'DK CVR not configured: set DK_CVR_USER and DK_CVR_PASS';

interface DkPeriod {
  gyldigFra?: string;
  gyldigTil?: string | null;
}

interface DkName {
  navn?: string;
  periode?: DkPeriod;
}

interface DkAddress {
  vejnavn?: string;
  husnummerFra?: string;
  bogstavFra?: string;
  postnummer?: number | string;
  postdistrikt?: string;
  landekode?: string;
  periode?: DkPeriod;
}

interface DkMetadata {
  nyesteNavn?: DkName;
  nyesteBeliggenhedsadresse?: DkAddress;
}

interface DkCompanyRecord {
  cvrNummer?: number | string;
  virksomhedsstatus?: string;
  navne?: DkName[];
  beliggenhedsadresse?: DkAddress[];
  virksomhedMetadata?: DkMetadata;
  livsforloeb?: { periode?: DkPeriod }[];
}

interface DkHit {
  _source?: { Vrvirksomhed?: DkCompanyRecord };
}

interface DkSearchResponse {
  hits?: {
    total?: number | { value?: number };
    hits?: DkHit[];
  };
}

type DkTotalHits = number | { value?: number };

// Lucene/ES query-injection guard: scope user input jako quoted phrase + escapovat jediné
// znaky speciální UVNITŘ fráze (\ a "). Bez toho by name/id injectly query operátory
// (wildcard DoS, bypass field-scopingu) do Virk Elasticsearch _search query stringu (ř. q=).
function lucenePhrase(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

export class DkCvrAdapter implements RegistryAdapter {
  constructor(
    private readonly user = process.env.DK_CVR_USER,
    private readonly pass = process.env.DK_CVR_PASS,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    if (!this.isConfigured()) return notConfiguredSearch();

    const url = new URL(API_BASE);
    url.searchParams.set('q', `Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn:${lucenePhrase(name)}`);
    url.searchParams.set('size', String(limit));

    try {
      const response = await this.fetchImpl(url, requestInit(this.user, this.pass));
      if (!response.ok) {
        warn(`DK CVR search failed: ${response.status} ${response.statusText}`);
        return { companies: [], total_results: 0 };
      }

      const payload = (await response.json()) as DkSearchResponse;
      const companies = (payload.hits?.hits ?? [])
        .map((hit) => hit._source?.Vrvirksomhed)
        .map(mapRecord)
        .filter((company): company is Company => company !== null);

      return {
        companies,
        total_results: totalHits(payload.hits?.total) ?? companies.length,
      };
    } catch (error) {
      warn('DK CVR search failed', error);
      return { companies: [], total_results: 0 };
    }
  }

  async getById(id: string): Promise<Company | null> {
    if (!this.isConfigured()) return notConfiguredLookup();
    if (!/^\d+$/.test(id)) return null; // cvrNummer je číselné → digit-only guard proti Lucene injection

    const url = new URL(API_BASE);
    url.searchParams.set('q', `Vrvirksomhed.cvrNummer:${id}`);
    url.searchParams.set('size', '1');

    try {
      const response = await this.fetchImpl(url, requestInit(this.user, this.pass));
      if (!response.ok) {
        warn(`DK CVR lookup failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const payload = (await response.json()) as DkSearchResponse;
      const record = payload.hits?.hits?.[0]?._source?.Vrvirksomhed;
      const company = mapRecord(record);
      return company?.id === id ? company : null;
    } catch (error) {
      warn('DK CVR lookup failed', error);
      return null;
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.user && this.pass);
  }
}

function mapRecord(record: DkCompanyRecord | undefined): Company | null {
  if (record?.cvrNummer === undefined) return null;
  const id = String(record.cvrNummer);
  const name = record.virksomhedMetadata?.nyesteNavn?.navn ?? activeName(record.navne);
  if (!name) return null;

  return {
    id,
    country: 'dk',
    name,
    status: mapStatus(record.virksomhedsstatus),
    address: formatAddress(
      record.virksomhedMetadata?.nyesteBeliggenhedsadresse ?? activeAddress(record.beliggenhedsadresse),
    ),
    registered_on: record.livsforloeb?.[0]?.periode?.gyldigFra,
    source_url: `${SOURCE_BASE}/${id}`,
  };
}

function mapStatus(status: string | undefined): CompanyStatus {
  const normalized = status?.toUpperCase();
  if (!normalized) return 'unknown';
  if (normalized === 'NORMAL' || normalized === 'AKTIV') return 'active';
  if (normalized.includes('OPH') || normalized.includes('SLET') || normalized.includes('OPL')) {
    return 'dissolved';
  }
  return 'unknown';
}

function activeName(names: DkName[] | undefined): string | undefined {
  return names?.find((name) => !name.periode?.gyldigTil)?.navn ?? names?.[names.length - 1]?.navn;
}

function activeAddress(addresses: DkAddress[] | undefined): DkAddress | undefined {
  return addresses?.find((address) => !address.periode?.gyldigTil) ?? addresses?.[addresses.length - 1];
}

function formatAddress(address: DkAddress | undefined): string | undefined {
  if (!address) return undefined;
  const house = [address.husnummerFra, address.bogstavFra].filter(Boolean).join('');
  const parts = [
    address.vejnavn,
    house || undefined,
    address.postnummer === undefined ? undefined : String(address.postnummer),
    address.postdistrikt,
    address.landekode,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function requestInit(user: string | undefined, pass: string | undefined): RequestInit {
  return {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
    },
  };
}

function totalHits(total: DkTotalHits | undefined): number | undefined {
  if (typeof total === 'number') return total;
  return total?.value;
}

function notConfiguredSearch(): CompanySearchResult {
  warn(NOT_CONFIGURED);
  return { companies: [], total_results: 0 };
}

function notConfiguredLookup(): null {
  warn(NOT_CONFIGURED);
  return null;
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
  else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
}
