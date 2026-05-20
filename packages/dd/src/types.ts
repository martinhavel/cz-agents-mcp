/**
 * Public report shape returned by `get_dd_report`. Stable contract — clients
 * (Stripe-billed customers) build dashboards on this. Add fields, never rename.
 *
 * v0.2.0 — extracted nested types into named interfaces so cz-agents-webapp
 * (and any other typed consumer) can import them without redefining.
 * Naming convention:
 *   - SanctionsMatch         — full match object (defined in clients.ts)
 *   - SanctionMatchSummary   — trimmed shape exposed in get_dd_report response
 */

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RiskLevel = 'low' | 'medium' | 'high';

export type VatReliability = 'ANO' | 'NE' | 'NENALEZEN';
export type VatSubjectType =
  | 'PLATCE_DPH'
  | 'IDENTIFIKOVANA_OSOBA'
  | 'SKUPINA_DPH'
  | 'NESPOLEHLIVA_OSOBA'
  | 'NENALEZEN';

export interface RedFlag {
  /** Stable machine code, e.g. 'INSOLVENCY_ACTIVE'. */
  code: string;
  severity: RiskSeverity;
  /** Contribution to risk score, 0–100. Score caps at 100 total. */
  weight: number;
  /** Human-readable description (Czech). */
  description: string;
  /** Where the data came from, e.g. 'ares', 'sanctions:ofac', 'isir'. */
  source: string;
  /** The raw datapoint that triggered the flag, for audit. */
  evidence?: unknown;
}

/**
 * Trimmed sanctions match shape exposed in get_dd_report response.
 * Distinct from `SanctionsMatch` in clients.ts (full match with entity object).
 */
export interface SanctionMatchSummary {
  source: string;        // 'ofac', 'eu', ...
  list_id: string;
  confidence: number;    // 0–100
  matched_on: string;    // 'primary_name' | 'alias' | 'ico' | 'id'
}

export interface PersonalInsolvency {
  spisova_znacka: string;
  phase?: string;
  url?: string;
}

export interface RegisteredAtGovtOffice {
  signal: 'marker' | 'known_address';
  matched_token?: string;
}

export interface PriorBankruptCompany {
  ico: string;
  name?: string;
  spisova_znacka?: string;
}

export interface StatutoryMember {
  name: string;
  role: string;
  since?: string;
  is_person: boolean;
  /** Set if the person/entity matches a sanctions list (≥ 85 confidence). */
  sanctions_match?: SanctionMatchSummary;
  /** Sub-IČO if statutory is itself a legal entity. */
  legal_entity_ico?: string;
  /** Set if this person has an active personal insolvency proceeding in ISIR. */
  personal_insolvency?: PersonalInsolvency;
  /** Set if this person's permanent residence is at a municipal office (úřad bydliště). */
  registered_at_govt_office?: RegisteredAtGovtOffice;
  /** Other Czech companies sharing surname that have or had insolvency. */
  prior_bankrupt_companies?: PriorBankruptCompany[];
}

export interface DdCompany {
  name?: string;
  legal_form?: string;
  address?: string;
  registered_on?: string;
  dissolved_on?: string;
  nace_codes?: string[];
  found: boolean;
}

export interface DdVat {
  is_payer: boolean;
  dic?: string;
  /** Set when the subject is a member of a Czech VAT group (§ 5a ZDPH).
   *  ADIS reliability is reported under this group DIČ, not under `dic`. */
  dic_sk_dph?: string;
  bank_accounts: string[];
  financial_office?: string;
  /** ADIS reliability classification. Set when ADIS lookup succeeds.
   *  ANO = unreliable payer (red flag), NE = reliable, NENALEZEN = not in VAT registry. */
  reliability?: VatReliability;
  /** Date the subject became unreliable. Set only when reliability === 'ANO'. */
  unreliable_since?: string;
  /** ADIS subject classification (V2). */
  subject_type?: VatSubjectType;
}

export interface DdInsolvency {
  has_active_proceeding: boolean;
  spisova_znacka?: string;
  started_on?: string;
  note?: string;
}

export interface DdSanctions {
  company_match?: SanctionMatchSummary;
  /** True if any statutory member matched a list (details on each member). */
  any_statutory_match: boolean;
}

export interface DdRiskScore {
  value: number;
  level: RiskLevel;
}

export interface DdReport {
  ico: string;
  retrieved_at: string;
  basic_only: boolean;            // true if depth='basic' (skipped ISIR / chain)

  company: DdCompany;
  vat: DdVat;
  statutory_body: StatutoryMember[];
  insolvency?: DdInsolvency;
  sanctions: DdSanctions;
  red_flags: RedFlag[];
  risk_score: DdRiskScore;
}

export interface ChainNode {
  ico: string;
  name?: string;
  /** Path of statutory roles that led here from root, oldest → newest. */
  via?: string[];
  children?: ChainNode[];
  /** Cycle / repeated ICO already visited at lower depth. */
  cycle?: boolean;
  /** Statutory persons whose surname matched too many companies in ARES
   *  (auto-skipped to avoid false-positive explosion on common Czech
   *  surnames like Novák / Zima / Kolář on boards of large public firms). */
  skipped_common_surnames?: Array<{ name: string; total_match_count: number }>;
}

export interface ChainResult {
  root_ico: string;
  tree: ChainNode;
  total_companies: number;
  max_depth: number;
}
