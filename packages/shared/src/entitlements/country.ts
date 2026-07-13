import type { CountryPolicySnapshot } from './types.js';

const ISO_ALPHA_2 = /^[A-Z]{2}$/;

export type CountryNormalizationResult =
  | { ok: true; country: string }
  | { ok: false; normalizedInput: string; reason: 'unknown' | 'invalid' };

export function normalizeCountryAlias(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-US');
}

export function normalizeCountry(
  value: string,
  snapshot: CountryPolicySnapshot,
): CountryNormalizationResult {
  const normalizedInput = normalizeCountryAlias(value);
  if (!normalizedInput) return { ok: false, normalizedInput, reason: 'invalid' };

  const canonical = snapshot.aliases.get(normalizedInput)
    ?? (ISO_ALPHA_2.test(normalizedInput) && snapshot.countries.has(normalizedInput)
      ? normalizedInput
      : undefined);

  if (!canonical) return { ok: false, normalizedInput, reason: 'unknown' };
  return { ok: true, country: canonical };
}

export function buildAliasIndex(
  countries: ReadonlyMap<string, { aliases: string[] }>,
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const [countryCode, policy] of countries) {
    const canonical = normalizeCountryAlias(countryCode);
    if (!ISO_ALPHA_2.test(canonical)) throw new Error(`INVALID_COUNTRY_CODE:${countryCode}`);
    addAlias(aliases, canonical, canonical);
    for (const alias of policy.aliases) addAlias(aliases, normalizeCountryAlias(alias), canonical);
  }
  if (aliases.get('UK') !== 'GB') throw new Error('MANDATORY_ALIAS_MISSING:UK->GB');
  return aliases;
}

function addAlias(aliases: Map<string, string>, alias: string, country: string): void {
  if (!alias) throw new Error(`EMPTY_COUNTRY_ALIAS:${country}`);
  const existing = aliases.get(alias);
  if (existing && existing !== country) throw new Error(`COUNTRY_ALIAS_COLLISION:${alias}`);
  aliases.set(alias, country);
}
