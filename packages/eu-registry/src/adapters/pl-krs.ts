import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';

const API_BASE = 'https://api-krs.ms.gov.pl';
const REQUEST_TIMEOUT_MS = 10_000;


export class PlKrsAdapter implements RegistryAdapter {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  // KRS name-search endpoint (WyszukiwanieKRS) was retired post-2024 eKRS migration.
  // Only lookup-by-KRS-number is available via the free official API.
  async searchByName(_name: string, _limit = 10): Promise<CompanySearchResult> {
    return { companies: [], total_results: 0 };
  }

  async getById(id: string): Promise<Company | null> {
    const primary = await fetchKrsRecord(this.fetchImpl, id, 'P');
    const payload = primary ?? (await fetchKrsRecord(this.fetchImpl, id, 'S'));
    if (!payload) return null;
    return mapRecord(payload, id);
  }
}

async function fetchKrsRecord(
  fetchImpl: typeof fetch,
  id: string,
  rejestr: 'P' | 'S',
): Promise<Record<string, unknown> | null> {
  const url = new URL(`/api/krs/OdpisAktualny/${encodeURIComponent(id)}`, API_BASE);
  url.searchParams.set('rejestr', rejestr);
  url.searchParams.set('format', 'json');

  try {
    const response = await fetchImpl(url, requestInit());
    if (!response.ok) {
      if (response.status !== 404) {
        warn(`KRS company lookup failed: ${response.status} ${response.statusText}`);
      }
      return null;
    }

    const payload = await response.json();
    return isRecord(payload) ? payload : null;
  } catch (error) {
    warn('KRS company lookup failed', error);
    return null;
  }
}


function mapRecord(record: Record<string, unknown>, fallbackId: string): Company | null {
  const id = firstString(record, ['numerKRS', 'nrKRS']) ?? fallbackId;
  const name = firstString(record, ['nazwa', 'firma', 'nazwaPodmiotu']);
  if (!id || !name) return null;

  return {
    id,
    country: 'pl',
    name,
    status: mapStatus(firstString(record, ['statusPodmiotu', 'status'])),
    address: formatAddress(firstValue(record, ['adres', 'siedzibaIAdres'])),
    registered_on: firstString(record, ['dataRejestracjiWKRS']),
    source_url: sourceUrl(id),
  };
}

function requestInit(): RequestInit {
  return {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  };
}

function mapStatus(status: string | undefined): CompanyStatus {
  const normalized = status?.toLowerCase();
  if (normalized === 'czynny') return 'active';
  if (normalized === 'wykreślony') return 'dissolved';
  return 'unknown';
}

function sourceUrl(id: string): string {
  return `https://ekrs.ms.gov.pl/web/wyszukiwarka-krs/strona-glowna/wyszukaj?numer=${encodeURIComponent(id)}`;
}

function formatAddress(address: unknown): string | undefined {
  if (typeof address === 'string') return address || undefined;
  if (!isRecord(address)) return undefined;

  const formatted = stringValue(address, 'adres') ?? stringValue(address, 'formattedAddress');
  if (formatted) return formatted;

  const parts = [
    firstString(address, ['ulica']),
    firstString(address, ['nrDomu', 'numerDomu']),
    firstString(address, ['nrLokalu', 'numerLokalu']),
    firstString(address, ['kodPocztowy']),
    firstString(address, ['miejscowosc', 'miejscowość']),
    firstString(address, ['kraj']),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(', ') : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = stringValue(record, key);
    if (direct) return direct;
  }

  for (const value of Object.values(record)) {
    if (isRecord(value)) {
      const nested = firstString(value, keys);
      if (nested) return nested;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (!isRecord(item)) continue;
        const nested = firstString(item, keys);
        if (nested) return nested;
      }
    }
  }

  return undefined;
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }

  for (const value of Object.values(record)) {
    if (isRecord(value)) {
      const nested = firstValue(value, keys);
      if (nested !== undefined) return nested;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (!isRecord(item)) continue;
        const nested = firstValue(item, keys);
        if (nested !== undefined) return nested;
      }
    }
  }

  return undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
  else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
}
