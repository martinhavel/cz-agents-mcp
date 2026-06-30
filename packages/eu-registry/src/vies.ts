import type { Company, CompanyStatus } from './types.js';

const API_BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api';
const REQUEST_TIMEOUT_MS = 10_000;

interface ViesResponse {
  isValid?: boolean;
  name?: string;
  address?: string;
}

export interface ParsedVat {
  country: string;
  number: string;
  vat: string;
}

export async function lookupCompanyByVat(
  vat: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Company | null> {
  const parsed = parseVat(vat);
  if (!parsed) return null;

  const url = viesUrl(parsed);

  try {
    const response = await fetchImpl(url, requestInit());
    if (!response.ok) {
      warn(`VIES lookup failed: ${response.status} ${response.statusText}`);
      return null;
    }

    return mapViesResponse((await response.json()) as ViesResponse, parsed);
  } catch (error) {
    warn('VIES lookup failed', error);
    return null;
  }
}

export function parseVat(vat: string): ParsedVat | null {
  const normalized = vat.replace(/[\s.-]/g, '').toUpperCase();
  const match = /^([A-Z]{2})([A-Z0-9]+)$/.exec(normalized);
  if (!match) return null;

  return {
    country: match[1]!.toLowerCase(),
    number: match[2]!,
    vat: normalized,
  };
}

function mapViesResponse(payload: ViesResponse, parsed: ParsedVat): Company {
  const valid = payload.isValid === true;
  const disclosedName = normalizeText(payload.name);

  return {
    id: parsed.vat,
    country: parsed.country,
    name: disclosedName ?? undisclosedName(parsed.vat, valid),
    status: mapStatus(payload.isValid),
    address: normalizeText(payload.address),
    source_url: viesUrl(parsed).toString(),
  };
}

function mapStatus(isValid: boolean | undefined): CompanyStatus {
  if (isValid === true) return 'active';
  return 'unknown';
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '---') return undefined;
  return trimmed;
}

function undisclosedName(vat: string, valid: boolean): string {
  return valid
    ? `VIES valid VAT ${vat} (name/address not disclosed)`
    : `VIES invalid VAT ${vat} (name/address not disclosed)`;
}

function viesUrl(parsed: ParsedVat): URL {
  return new URL(
    `${API_BASE}/ms/${encodeURIComponent(parsed.country.toUpperCase())}/vat/${encodeURIComponent(parsed.number)}`,
  );
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
