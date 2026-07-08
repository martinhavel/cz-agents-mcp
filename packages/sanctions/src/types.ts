/**
 * Normalized schema. Every fetcher maps its source-specific format to this.
 * IDs are namespaced as `${source}:${source_list_id}` to avoid collisions.
 */

export type SanctionSource = 'eu' | 'ofac' | 'un' | 'ofsi' | 'fau';

export type SanctionedType = 'person' | 'entity' | 'vessel' | 'aircraft';

export interface SanctionAddress {
  street?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string; // ISO 3166-1 alpha-2 if known, else country name
}

export interface SanctionId {
  type: string; // 'passport', 'national_id', 'tax_id', 'ico', 'imo', ...
  value: string;
  country?: string;
}

export interface SanctionedEntity {
  /** `${source}:${source_list_id}` */
  id: string;
  source: SanctionSource;
  source_list_id: string;
  type: SanctionedType;
  primary_name: string;
  /** All known name variants including transliterations. Always includes primary_name normalized. */
  aliases: string[];
  /** ISO 8601 date or year-only. Persons may have multiple. */
  dobs?: string[];
  nationalities?: string[];
  addresses?: SanctionAddress[];
  ids?: SanctionId[];
  /** Sanction programs / regimes, e.g. ['EU.RUSSIA', 'OFAC.SDGT']. */
  programs: string[];
  listed_on?: string;
  remarks?: string;
  /** Raw source record retained for audit trail. */
  raw?: unknown;
}

export interface MatchResult {
  entity: SanctionedEntity;
  /** 0-100. Exact-id match = 100, fuzzy name match = Levenshtein-derived. */
  confidence: number;
  matched_on: 'primary_name' | 'alias' | 'id' | 'ico';
  /** Which alias matched, if matched_on === 'alias'. */
  matched_alias?: string;
}

export type SanctionDobStatus = 'match' | 'mismatch' | 'list_missing' | 'subject_missing';
export type SanctionMatchStrength = 'strong' | 'possible' | 'weak-name-only';

export interface SanctionMatchSummary {
  source: string;
  list_id: string;
  confidence: number;
  matched_on: string;
  primary_name: string;
  matched_alias?: string;
  list_dobs?: string[];
  subject_dob?: string;
  dob_status: SanctionDobStatus;
  match_strength: SanctionMatchStrength;
  nationalities?: string[];
  programs?: string[];
  listed_on?: string;
}

export interface SearchPersonInput {
  name: string;
  dob?: string;
  nationality?: string;
  threshold?: number;
}

export interface SearchEntityInput {
  name: string;
  country?: string;
  threshold?: number;
}

export interface RecentUpdates {
  added: SanctionedEntity[];
  removed: SanctionedEntity[];
  modified: Array<{ before: SanctionedEntity; after: SanctionedEntity }>;
  since: string;
  until: string;
}
