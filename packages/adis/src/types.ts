/**
 * Public shape returned by ADIS queries. Stable contract — `@czagents/dd`
 * consumes this via a structural `AdisLike` interface.
 *
 * `null` from `checkPayer` means "DIČ not found in VAT registry".
 * Errors propagate as thrown exceptions.
 */

/** ADIS reliability marker. ANO = unreliable, NE = reliable, NENALEZEN = not in registry. */
export type DphReliability = 'ANO' | 'NE' | 'NENALEZEN';

/** Subject classification (V2 endpoint). */
export type DphSubjectType =
  | 'PLATCE_DPH'
  | 'IDENTIFIKOVANA_OSOBA'
  | 'SKUPINA_DPH'
  | 'NESPOLEHLIVA_OSOBA'
  | 'NENALEZEN';

export interface PublishedAccount {
  /** Czech account: predcisli-cislo/kodBanky. predcisli optional. */
  predcisli?: string;
  cislo: string;
  /** Bank code (4 digits). */
  kod_banky: string;
  /** Date the account became published (ISO). */
  publikovan_od?: string;
  /** Date the account ceased publication (ISO). Present means: account no longer published. */
  publikovan_do?: string;
  /** Czech standard account number assembled as "predcisli-cislo/kodBanky". */
  formatted: string;
}

export interface DphSubjectAddress {
  ulice_cislo?: string;
  cast_obce?: string;
  mesto?: string;
  psc?: string;
  stat?: string;
}

export interface DphPayerStatus {
  /** Tax ID (CZ12345678). */
  dic: string;
  /** Czech business ID derived by stripping CZ prefix; null if DIC has no CZ prefix. */
  ico: string | null;
  /** Reliability classification per ADIS. */
  reliability: DphReliability;
  /** Subject type (V2 endpoint only). Undefined when only basic check was performed. */
  subject_type?: DphSubjectType;
  /** Czech name of the subject (from extended check). */
  subject_name?: string;
  /** Address (from extended check). */
  address?: DphSubjectAddress;
  /** Date when unreliability was published. Only present when reliability === 'ANO'. */
  unreliable_since?: string;
  /** Tax office number (cisloFu) — 2 or 3 digits. */
  tax_office?: string;
  /** Bank accounts published per § 96a ZDPH (transparent VAT account). */
  accounts: PublishedAccount[];
}

export interface AdisServiceStatus {
  /** Date the response was generated (ISO). */
  generated_on: string;
  /** Numeric status: 0=OK, 1=integrity error, 2=maintenance window 0:00-0:10, 3=service unavailable. */
  status_code: number;
  /** Human-readable status text from ADIS. */
  status_text: string;
}

export interface BulkPayerCheckResult {
  service: AdisServiceStatus;
  results: DphPayerStatus[];
}

export interface UnreliableListResult {
  service: AdisServiceStatus;
  /** All currently unreliable payers. Note: response is large (tens of thousands of entries). */
  unreliable: DphPayerStatus[];
}
