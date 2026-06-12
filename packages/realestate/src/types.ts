/**
 * Public types returned by realestate MCP tools. Stable contract — clients
 * (Stripe-billed customers) build dashboards on this.
 *
 * Naming convention: PropertyTeaser = free tier (no PII), PropertyFull = paid.
 *
 * Sensitive fields blacklist (NEVER returned at any tier):
 *   - rodné číslo (national ID number)
 *   - personal phone, email, bank account
 *   - any field not present in the upstream public registry
 */

export type PropertyCategory = 'insolvence' | 'drazba' | 'exekuce';
export type PropertyType = 'byt' | 'dum' | 'pozemek' | 'komercial';
export type AuctionStatus = 'upcoming' | 'active' | 'finished_unsold' | 'finished_sold';

export interface PropertyTeaser {
  property_id: string;
  category: PropertyCategory;
  okres: string;
  property_type: PropertyType;
  size_m2: number | null;
  layout: string | null;
  estimated_price_kc: number | null;
  vyvolavaci_cena_kc: number | null;
  auction_date: string | null;
  court_ref: string | null;
  source_url: string;
  upgrade_url: string;
  auction_status?: AuctionStatus | null;
}

export interface PropertyFull extends PropertyTeaser {
  address: string | null;
  ruian_id: string | null;
  owner_name: string | null;
  owner_ico: string | null;
  auction_house: string | null;
  expert_appraisal_url: string | null;
  isir_link: string | null;
  portal_drazeb_link: string | null;
  expected_yield_pct: number | null;
  ai_risk_score: number | null;
  opt_out_status: 'verified_clear' | 'opted_out';
}

export interface DistrictAggregate {
  okres: string;
  window_days: number;
  insolvency_count: number | null;
  auction_count: number | null;
  distress_lead_count: number | null;
  avg_estimated_price_kc_per_m2: number | null;
  trend_yoy_pct: number | null;
  /** Set when the district has fewer than 3 distress leads (k<3) — a caution flag for
   *  low-volume figures. Counts are still returned, not suppressed. */
  low_activity?: true;
}

export interface MarketTrend {
  kraj: string | null;
  okres: string | null;
  property_type: PropertyType | null;
  median_price_kc_per_m2: number | null;
  yoy_change_pct: number | null;
  qoq_change_pct: number | null;
  data_source: 'sreality_aggregate';
  /** Period the snapshot represents. */
  period: string;
}

export interface AuctionCalendarItem {
  property_id: string;
  category: PropertyCategory;
  okres: string;
  auction_date: string;
  property_type: PropertyType;
  vyvolavaci_cena_kc: number | null;
  size_m2: number | null;
  source_url: string;
}
