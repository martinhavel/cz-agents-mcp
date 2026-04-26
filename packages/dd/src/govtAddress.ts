/**
 * Detection of "trvalý pobyt na úřadu" — when a Czech citizen has their
 * permanent residence registered at a municipal office address (úřad městské
 * části, magistrát, obecní úřad).
 *
 * Background: the Zákon o evidenci obyvatel (133/2000 Sb. § 10 odst. 5)
 * allows the municipality to register a person at the úřad address when:
 *   - their previous residence was cancelled (housing eviction / debt
 *     enforcement) and they didn't register a new one
 *   - they explicitly request "evidence at úřad"
 *   - other extraordinary circumstances
 *
 * Statistically, ~200 000 Czech adults have úřad-registered residence
 * (2024 data, Ministerstvo vnitra). Heavily skewed toward people in
 * personal insolvency, debt, homelessness, or used as nominees ("bílý kůň")
 * for shell companies.
 *
 * Detection approach (3 signals, OR'd):
 *   1. Address text contains markers: "úřad", "magistrát", "radnice",
 *      "městská část" (case-insensitive, diacritics-fold)
 *   2. Known static list of úřad addresses for major cities (~30 entries
 *      covering Prague, Brno, Ostrava, Plzeň, Liberec, Olomouc, Č. Bud.)
 *   3. (Future, not in MVP) Cross-check obyvatel-count at address from
 *      RUIAN — úřad addresses have 100s/1000s registered residents
 *
 * Limitations:
 *   - False positives possible (a real residence happens to be near úřad)
 *   - False negatives for smaller obce not in static list
 *   - Confidence "medium" — caller should treat as one signal among many,
 *     not a smoking gun
 */
import type { AresAddressLike } from './clients.js';

/**
 * Static list of úřední addresses for the largest Czech cities.
 * Format: normalized "ulice cisloDomovni, obec" (no diacritics, lowercase).
 *
 * Source: cross-referenced from RUIAN entries for ÚMČ/MMR-listed
 * municipal offices, manually curated. Expand as encountered.
 */
// Static list pre-normalized (lowercase, no diacritics, no punctuation, single spaces).
// Keep entries in raw form here but normalize at construction time so
// authoring is readable and matching is deterministic.
const KNOWN_GOVT_ADDRESSES_RAW: readonly string[] = [
  'Mariánské náměstí 2, Praha',
  'Havlíčkovo náměstí 9, Praha',
  'Orelská 38, Praha',
  'Mileticova 1, Praha',
  'Dominikánské náměstí 1, Brno',
  'Mendlovo náměstí 1, Brno',
  'Prokešovo náměstí 1228, Ostrava',
  'Náměstí republiky 1, Plzeň',
  'Náměstí Dr. E. Beneše 1, Liberec',
  'Horní náměstí 583, Olomouc',
  'Náměstí Přemysla Otakara II 1, České Budějovice',
  'Československé armády 408, Hradec Králové',
  'Pernštýnské náměstí 1, Pardubice',
  'Velká Hradební 8, Ústí nad Labem',
  'Náměstí Míru 12, Zlín',
];

// Markers — works without word-boundaries because Czech accented chars
// trip JS \b. Substring match is good enough; false-positive risk is
// tiny (these tokens almost never appear in residential street names).
const MARKER_PATTERN = /(úřad|urad|magistrát|magistrat|radnice|městská\s*část|mestska\s*cast|obecn[íi]\s+úřad|obecn[íi]\s+urad)/i;

export interface GovtAddressMatch {
  is_govt_address: boolean;
  signal: 'marker' | 'known_address' | 'none';
  matched_token?: string;
}

export function detectGovtAddress(adresa: AresAddressLike | undefined): GovtAddressMatch {
  if (!adresa) return { is_govt_address: false, signal: 'none' };

  // Signal 1: text markers
  const text = adresa.textovaAdresa ?? '';
  const markerHit = MARKER_PATTERN.exec(text);
  if (markerHit) {
    return { is_govt_address: true, signal: 'marker', matched_token: markerHit[0] };
  }

  // Signal 2: known static list lookup
  const norm = normalize(text);
  if (norm && KNOWN_GOVT_ADDRESSES.has(norm)) {
    return { is_govt_address: true, signal: 'known_address', matched_token: norm };
  }

  // Also try built address from structured fields
  if (adresa.nazevUlice && adresa.cisloDomovni && adresa.nazevObce) {
    const built = normalize(`${adresa.nazevUlice} ${adresa.cisloDomovni} ${adresa.nazevObce}`);
    if (KNOWN_GOVT_ADDRESSES.has(built)) {
      return { is_govt_address: true, signal: 'known_address', matched_token: built };
    }
  }

  return { is_govt_address: false, signal: 'none' };
}

const KNOWN_GOVT_ADDRESSES: ReadonlySet<string> = new Set(
  KNOWN_GOVT_ADDRESSES_RAW.map(normalize),
);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '') // strip Unicode combining marks (Czech diacritics)
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
