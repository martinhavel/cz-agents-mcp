/**
 * get_district_aggregate — okres-level statistics over public-registry data.
 *
 * Free tier — UNLIMITED. The figures aggregate already-public legal records
 * (ISIR insolvencies, portál dražeb / CEVD forced sales), so no new PII is
 * introduced. The one residual risk is singling-out: an exact low count in a
 * small district could point at one specific distressed person. To avoid that
 * without lying about empty districts, counts are k-anonymity banded:
 *   • 0 distress leads      → shown as 0 (nobody to protect; honest empty).
 *   • 1–4 distress leads    → all three counts suppressed to null + `counts_band:'<5'`
 *                             (records DO exist, exact figure withheld — not zero).
 *   • ≥5 distress leads     → exact counts.
 * Banding is applied to the whole row by total, never per-field: distress =
 * insolvency + auction, so hiding one field while showing the other two would
 * let the suppressed value be re-derived by subtraction.
 *
 * `data_source` is always present and states both the provenance and this rule,
 * so a reader is never misled about what a null count means.
 */

import { getDb } from '../db.js';
import type { DistrictAggregate } from '../types.js';

// Below this many distress leads a district is "low activity". Exact counts in
// the 1–4 range are withheld (banded to '<5') to avoid identifying an individual.
const K_ANONYMITY_THRESHOLD = 5;

// Count DISTINCT properties, not rows. One insolvency case emits several ISIR
// events (dražební vyhláška → změna termínu → výsledek) for the same property,
// so COUNT(*) double-counts. Key = spisovaZnacka|oddil|cisloVOddilu (the concrete
// land-registry entry); spisovaZnacka alone is unsafe because one case can auction
// several distinct parcels. Leads without an LV entry (portal auctions) fall back
// to the row id so they never merge. Mirrors lib/realestate-dedup.ts in the webapp.
const DISTINCT_PROPERTY_SQL = `COUNT(DISTINCT CASE
        WHEN l.oddil IS NOT NULL AND l.cisloVOddilu IS NOT NULL
        THEN l.spisovaZnacka || '|' || l.oddil || '|' || l.cisloVOddilu
        ELSE 'ID:' || l.id END)`;

const DATA_SOURCE_NOTE =
  'Agregace veřejných rejstříků: ISIR (insolvence) + portál dražeb / CEVD (dražby a exekuce). ' +
  'Počty 1–4 jsou skryté (zobrazeny jako „<5"), aby nešlo ztotožnit konkrétní osobu; 0 a 5+ se zobrazují přesně.';
const SOURCE_PRIORITY = ['eurostat_hpi', 'csu_vdb_extrap', 'cnb_arad', 'csu_vdb', 'cuzk_kupni', 'static_fallback'];

const KRAJ_SLUG_TO_PRICE_INDEX_KEY: Record<string, string> = {
  'hl-m-praha': 'Praha',
  stredocesky: 'Středočeský',
  jihocesky: 'Jihočeský',
  plzensky: 'Plzeňský',
  karlovarsky: 'Karlovarský',
  ustecky: 'Ústecký',
  liberecky: 'Liberecký',
  kralovehradecky: 'Královéhradecký',
  pardubicky: 'Pardubický',
  vysocina: 'Vysočina',
  jihomoravsky: 'Jihomoravský',
  olomoucky: 'Olomoucký',
  zlinsky: 'Zlínský',
  moravskoslezsky: 'Moravskoslezský',
};

function slugifyCs(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sourceRank(source: string): number {
  const index = SOURCE_PRIORITY.indexOf(source);
  return index === -1 ? 99 : index;
}

export function getDistrictAggregate(params: {
  okres: string;
  window_days?: 30 | 90 | 365;
}): DistrictAggregate {
  const window_days = params.window_days ?? 90;
  const db = getDb();

  const since = new Date(Date.now() - window_days * 24 * 60 * 60 * 1000).toISOString();
  const okresSlug = slugifyCs(params.okres);
  const districtParams = { okres: params.okres, okresSlug, since };
  const districtWhere = `
    (
      l.okresSlug = @okresSlug
      OR (l.okresSlug IS NULL AND l.kuMatchedName = @okres)
    )
    AND l.ingestedAt >= @since
    AND l.status = 'scored'
  `;

  // Prefer RealEstateLead.okresSlug (canonical district key). Existing
  // production rows may predate that backfill, so null-slug rows fall back to
  // kuMatchedName when it exactly matches the requested okres name.
  // status='scored' only — pending leads aren't confirmed distress yet and
  // discarded ones have no property; counting them inflated the public
  // aggregates (previously only 'archived' was excluded).
  const distressCount = (db
    .prepare(`
      SELECT ${DISTINCT_PROPERTY_SQL} AS c
      FROM RealEstateLead l
      WHERE ${districtWhere}
    `)
    .get(districtParams) as { c: number }).c;

  const insolvencyCount = (db
    .prepare(`
      SELECT ${DISTINCT_PROPERTY_SQL} AS c
      FROM RealEstateLead l
      WHERE ${districtWhere}
        AND l.sourceType = 'isir'
    `)
    .get(districtParams) as { c: number }).c;

  const auctionCount = (db
    .prepare(`
      SELECT ${DISTINCT_PROPERTY_SQL} AS c
      FROM RealEstateLead l
      WHERE ${districtWhere}
        AND l.sourceType IN ('portaldrazeb', 'cevd', 'cuzk_delta')
    `)
    .get(districtParams) as { c: number }).c;

  const aggregateRow = db
    .prepare(`
      SELECT krajSlug
      FROM DistrictAggregate
      WHERE okresSlug = @okresSlug
      ORDER BY CASE WHEN windowDays = @windowDays THEN 0 ELSE 1 END, windowDays DESC
      LIMIT 1
    `)
    .get({ okresSlug, windowDays: window_days }) as { krajSlug: string } | undefined;

  const priceIndexKraj =
    (aggregateRow?.krajSlug ? KRAJ_SLUG_TO_PRICE_INDEX_KEY[aggregateRow.krajSlug] : null) ??
    (okresSlug === 'praha' ? 'Praha' : null);

  const priceRows = priceIndexKraj
    ? (db
      .prepare(`
        SELECT kcPerM2, source, periodYear, periodQuarter
        FROM RealEstatePriceIndex
        WHERE kraj = @kraj
          AND propertyType = 'byt'
        ORDER BY periodYear DESC, periodQuarter DESC
        LIMIT 20
      `)
      .all({ kraj: priceIndexKraj }) as Array<{
        kcPerM2: number;
        source: string;
        periodYear: number;
        periodQuarter: number;
      }>)
    : [];

  const latestPeriod = priceRows[0]
    ? { year: priceRows[0].periodYear, quarter: priceRows[0].periodQuarter }
    : null;
  const latestPriceRows = latestPeriod
    ? priceRows.filter((row) => row.periodYear === latestPeriod.year && row.periodQuarter === latestPeriod.quarter)
    : [];
  const latestPrice = latestPriceRows.sort((a, b) => sourceRank(a.source) - sourceRank(b.source))[0];

  const yoyPrice = latestPeriod
    ? priceRows
      .filter((row) => row.periodYear === latestPeriod.year - 1 && row.periodQuarter === latestPeriod.quarter)
      .sort((a, b) => sourceRank(a.source) - sourceRank(b.source))[0]
    : undefined;

  const lowActivity = distressCount < K_ANONYMITY_THRESHOLD; // 0–4
  // Suppress only when there IS something to hide (1–4). 0 stays 0 — an empty
  // district has nobody to protect and reporting "<5" there would be misleading.
  const suppressed = distressCount > 0 && distressCount < K_ANONYMITY_THRESHOLD;

  return {
    okres: params.okres,
    window_days,
    insolvency_count: suppressed ? null : insolvencyCount,
    auction_count: suppressed ? null : auctionCount,
    distress_lead_count: suppressed ? null : distressCount,
    avg_estimated_price_kc_per_m2: latestPrice?.kcPerM2 ?? null,
    trend_yoy_pct: latestPrice && yoyPrice
      ? Math.round(((latestPrice.kcPerM2 - yoyPrice.kcPerM2) / yoyPrice.kcPerM2) * 1000) / 10
      : null,
    data_source: DATA_SOURCE_NOTE,
    ...(suppressed ? { counts_band: '<5' as const } : {}),
    ...(lowActivity ? { low_activity: true as const } : {}),
  };
}
