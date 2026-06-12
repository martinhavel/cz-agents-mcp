import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';

const API_BASE = 'https://recherche-entreprises.api.gouv.fr';
const REQUEST_TIMEOUT_MS = 10_000;

interface FrSiege {
  adresse?: string;
  code_postal?: string;
  libelle_commune?: string;
}

interface FrResult {
  siren?: string;
  nom_complet?: string;
  nom_raison_sociale?: string;
  etat_administratif?: string;
  date_creation?: string;
  siege?: FrSiege;
}

interface FrSearchResponse {
  results?: FrResult[];
  total_results?: number;
}

export class FrSireneAdapter implements RegistryAdapter {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    const url = new URL('/search', API_BASE);
    url.searchParams.set('q', name);
    url.searchParams.set('per_page', String(limit));

    try {
      const response = await this.fetchImpl(url, requestInit());
      if (!response.ok) {
        warn(`SIRENE search failed: ${response.status} ${response.statusText}`);
        return { companies: [], total_results: 0 };
      }

      const payload = (await response.json()) as FrSearchResponse;
      const companies = (payload.results ?? [])
        .map(mapResult)
        .filter((c): c is Company => c !== null);

      return {
        companies,
        total_results: payload.total_results ?? companies.length,
      };
    } catch (error) {
      warn('SIRENE search failed', error);
      return { companies: [], total_results: 0 };
    }
  }

  async getById(id: string): Promise<Company | null> {
    const url = new URL('/search', API_BASE);
    url.searchParams.set('q', id);
    url.searchParams.set('per_page', '1');

    try {
      const response = await this.fetchImpl(url, requestInit());
      if (!response.ok) {
        warn(`SIRENE lookup failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const payload = (await response.json()) as FrSearchResponse;
      const result = payload.results?.[0];
      const company = result ? mapResult(result) : null;
      // getById is a fuzzy /search under the hood; the top hit is not guaranteed to be
      // the requested SIREN. Confirm an exact (digits-only) match before returning, else
      // null — never return a different company than the one asked for.
      if (!company) return null;
      const normalize = (s: string): string => s.replace(/\D/g, '');
      return normalize(company.id) === normalize(id) ? company : null;
    } catch (error) {
      warn('SIRENE lookup failed', error);
      return null;
    }
  }
}

function mapResult(r: FrResult): Company | null {
  if (!r.siren) return null;
  const name = r.nom_complet ?? r.nom_raison_sociale;
  if (!name) return null;

  return {
    id: r.siren,
    country: 'fr',
    name,
    status: mapStatus(r.etat_administratif),
    address: r.siege?.adresse ?? formatSiegeAddress(r.siege),
    registered_on: r.date_creation,
    source_url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${r.siren}`,
  };
}

function mapStatus(etat: string | undefined): CompanyStatus {
  if (etat === 'A') return 'active';
  if (etat === 'C') return 'dissolved';
  return 'unknown';
}

function formatSiegeAddress(siege: FrSiege | undefined): string | undefined {
  if (!siege) return undefined;
  const parts = [siege.code_postal, siege.libelle_commune].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function requestInit(): RequestInit {
  return { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
  else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
}
