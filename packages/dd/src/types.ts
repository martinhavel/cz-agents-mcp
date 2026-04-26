/**
 * Public report shape returned by `get_dd_report`. Stable contract — clients
 * (Stripe-billed customers) build dashboards on this. Add fields, never rename.
 */

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RiskLevel = 'low' | 'medium' | 'high';

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

export interface SanctionMatchSummary {
  source: string;        // 'ofac', 'eu', ...
  list_id: string;
  confidence: number;    // 0–100
  matched_on: string;    // 'primary_name' | 'alias' | 'ico' | 'id'
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
  personal_insolvency?: {
    spisova_znacka: string;
    phase?: string;
    url?: string;
  };
}

export interface DdReport {
  ico: string;
  retrieved_at: string;
  basic_only: boolean;            // true if depth='basic' (skipped ISIR / chain)

  company: {
    name?: string;
    legal_form?: string;
    address?: string;
    registered_on?: string;
    dissolved_on?: string;
    nace_codes?: string[];
    found: boolean;
  };

  vat: {
    is_payer: boolean;
    dic?: string;
    bank_accounts: string[];
    financial_office?: string;
  };

  statutory_body: StatutoryMember[];

  insolvency?: {
    has_active_proceeding: boolean;
    spisova_znacka?: string;
    started_on?: string;
    note?: string;
  };

  sanctions: {
    company_match?: SanctionMatchSummary;
    /** True if any statutory member matched a list (details on each member). */
    any_statutory_match: boolean;
  };

  red_flags: RedFlag[];
  risk_score: { value: number; level: RiskLevel };
}

export interface ChainNode {
  ico: string;
  name?: string;
  /** Path of statutory roles that led here from root, oldest → newest. */
  via?: string[];
  children?: ChainNode[];
  /** Cycle / repeated ICO already visited at lower depth. */
  cycle?: boolean;
}

export interface ChainResult {
  root_ico: string;
  tree: ChainNode;
  total_companies: number;
  max_depth: number;
}
