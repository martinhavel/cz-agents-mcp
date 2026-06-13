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
  /** null when suppressed (district has 1–4 distress leads — see `counts_band`). */
  insolvency_count: number | null;
  /** null when suppressed (district has 1–4 distress leads — see `counts_band`). */
  auction_count: number | null;
  /** null when suppressed (district has 1–4 distress leads — see `counts_band`). */
  distress_lead_count: number | null;
  avg_estimated_price_kc_per_m2: number | null;
  trend_yoy_pct: number | null;
  /** Provenance + suppression disclosure, always present. States the public registries
   *  the figures come from and the <5 banding rule, so a reader is never misled about
   *  what a null count means. */
  data_source: string;
  /** Present (`'<5'`) when the three counts are null because the district has 1–4
   *  distress leads. The exact count is withheld to avoid singling out an individual,
   *  but the band makes clear records DO exist — it is not zero. */
  counts_band?: '<5';
  /** Set when the district has fewer than 5 distress leads (k<5) — low-volume caution
   *  flag. For 1–4 the counts are suppressed (`counts_band`); 0 is shown as 0. */
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
