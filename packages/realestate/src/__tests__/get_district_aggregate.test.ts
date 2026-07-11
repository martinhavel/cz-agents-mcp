/**
 * Unit tests for getDistrictAggregate — the only free-tier tool remaining in
 * @czagents/realestate@0.3.0. Paid tools (search_distress_properties,
 * get_property_detail) moved to private realestate-pro package.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const testDb = new Database(':memory:');

vi.mock('../db.js', () => ({
  getDb: () => testDb,
  closeDb: () => { /* no-op */ },
}));

const { getDistrictAggregate } = await import('../tools/get_district_aggregate.js');

const SCHEMA = `
CREATE TABLE RealEstateLead (
  id TEXT PRIMARY KEY,
  sourceType TEXT NOT NULL,
  spisovaZnacka TEXT NOT NULL,
  courtCode TEXT NOT NULL,
  ingestedAt TEXT NOT NULL,
  publishedAt TEXT,
  status TEXT DEFAULT 'pending_vision',
  opportunityScore REAL,
  dokumentUrl TEXT,
  kuMatchedName TEXT,
  parcelaPlocha REAL,
  parcelaDruh TEXT,
  parcelaVyuziti TEXT,
  auctionStatus TEXT,
  popisUdalosti TEXT DEFAULT '',
  typUdalosti TEXT DEFAULT '',
  matchedKeywords TEXT DEFAULT '',
  oddil TEXT,
  cisloVOddilu INTEGER,
  lat REAL,
  lng REAL,
  okresSlug TEXT
);

CREATE TABLE DistrictAggregate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  okresSlug TEXT NOT NULL,
  windowDays INTEGER NOT NULL,
  insolvencyCount INTEGER NOT NULL DEFAULT 0,
  auctionCount INTEGER NOT NULL DEFAULT 0,
  distressLeadCount INTEGER NOT NULL DEFAULT 0,
  krajSlug TEXT NOT NULL,
  krajCount INTEGER NOT NULL DEFAULT 0,
  lastUpdated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT
);

CREATE TABLE RealEstatePriceIndex (
  id TEXT PRIMARY KEY,
  kraj TEXT NOT NULL,
  propertyType TEXT NOT NULL,
  periodYear INTEGER NOT NULL,
  periodQuarter INTEGER NOT NULL,
  kcPerM2 INTEGER NOT NULL,
  source TEXT NOT NULL,
  fetchedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

function insertLead(opts: {
  id: string;
  sourceType: 'isir' | 'portaldrazeb' | 'cevd';
  kuMatchedName?: string;
  ingestedAt?: string;
  status?: string;
  okresSlug?: string | null;
  // Same (spisovaZnacka, oddil, cisloVOddilu) = same property → deduped.
  spisovaZnacka?: string;
  oddil?: string | null;
  cisloVOddilu?: number | null;
}): void {
  testDb.prepare(`
    INSERT INTO RealEstateLead (
      id, sourceType, spisovaZnacka, courtCode, ingestedAt, status, kuMatchedName, okresSlug, oddil, cisloVOddilu
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.sourceType,
    opts.spisovaZnacka ?? `INS-${opts.id}`,
    'KSPH',
    opts.ingestedAt ?? new Date().toISOString(),
    // Aggregates count status='scored' only — default test leads to that.
    opts.status ?? 'scored',
    opts.kuMatchedName ?? 'Praha',
    opts.okresSlug,
    opts.oddil ?? null,
    opts.cisloVOddilu ?? null,
  );
}

beforeAll(() => testDb.exec(SCHEMA));
afterAll(() => testDb.close());
beforeEach(() => {
  testDb.exec('DELETE FROM RealEstateLead; DELETE FROM DistrictAggregate; DELETE FROM RealEstatePriceIndex;');
  testDb.prepare(`
    INSERT INTO DistrictAggregate (okresSlug, windowDays, krajSlug)
    VALUES ('praha', 90, 'hl-m-praha')
  `).run();
});

describe('getDistrictAggregate', () => {
  it('counts distinct properties, not ISIR events (one case, many events → 1)', () => {
    // Same case + same LV entry (oddil B / cislo 172) across 5 ISIR events.
    for (let i = 0; i < 5; i++) {
      insertLead({ id: `ev-${i}`, sourceType: 'isir', kuMatchedName: 'Praha', spisovaZnacka: 'KSPH 1 INS 1/26', oddil: 'B', cisloVOddilu: 172 });
    }
    // Same case, DIFFERENT parcel (cislo 170) = a second distinct property.
    insertLead({ id: 'other-parcel', sourceType: 'isir', kuMatchedName: 'Praha', spisovaZnacka: 'KSPH 1 INS 1/26', oddil: 'B', cisloVOddilu: 170 });
    // Portal auction without an LV entry — id fallback, never merges.
    insertLead({ id: 'auction-1', sourceType: 'portaldrazeb', kuMatchedName: 'Praha', spisovaZnacka: 'KSPH 1 INS 1/26', oddil: null, cisloVOddilu: null });
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    // 7 rows → 3 distinct properties (parcel 172, parcel 170, auction). ≥5? no → banded.
    // But distress total = 3, so it's in the 1–4 band → suppressed.
    expect(result.distress_lead_count).toBeNull();
    expect(result.counts_band).toBe('<5');
    // Below k=5 means banding — but the point is 7 events collapsed to 3 properties,
    // not 7. Verify by adding two more distinct properties to cross k=5:
    insertLead({ id: 'p3', sourceType: 'isir', kuMatchedName: 'Praha', spisovaZnacka: 'KSPH 2 INS 2/26', oddil: 'B', cisloVOddilu: 5 });
    insertLead({ id: 'p4', sourceType: 'isir', kuMatchedName: 'Praha', spisovaZnacka: 'KSPH 3 INS 3/26', oddil: 'B', cisloVOddilu: 6 });
    const r2 = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    // Now 5 distinct properties (172, 170, auction, p3, p4) despite 9 rows.
    expect(r2.distress_lead_count).toBe(5);
  });

  it('shows 0 (not banded) and low_activity for empty district', () => {
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.okres).toBe('Praha');
    expect(result.window_days).toBe(90);
    // 0 has nobody to protect → shown exactly, NOT suppressed to "<5".
    expect(result.distress_lead_count).toBe(0);
    expect(result.counts_band).toBeUndefined();
    expect(result.low_activity).toBe(true);
  });

  it('suppresses counts to "<5" band when 1–4 distress leads', () => {
    insertLead({ id: 'isir-1', sourceType: 'isir', kuMatchedName: 'Praha' });
    insertLead({ id: 'drazba-1', sourceType: 'portaldrazeb', kuMatchedName: 'Praha' });
    insertLead({ id: 'drazba-2', sourceType: 'portaldrazeb', kuMatchedName: 'Praha' });
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    // 3 leads (1 isir + 2 auction) — exact counts withheld so no single person is identifiable.
    expect(result.distress_lead_count).toBeNull();
    expect(result.insolvency_count).toBeNull();
    expect(result.auction_count).toBeNull();
    expect(result.counts_band).toBe('<5');
    expect(result.low_activity).toBe(true);
  });

  it('shows exact counts at exactly k=5 (no banding)', () => {
    for (let i = 0; i < 5; i++) {
      insertLead({ id: `isir-${i}`, sourceType: 'isir', kuMatchedName: 'Praha' });
    }
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.distress_lead_count).toBe(5);
    expect(result.insolvency_count).toBe(5);
    expect(result.counts_band).toBeUndefined();
    expect(result.low_activity).toBeUndefined();
  });

  it('returns exact counts when >= k=5 leads in district', () => {
    for (let i = 0; i < 6; i++) {
      insertLead({ id: `isir-${i}`, sourceType: 'isir', kuMatchedName: 'Praha' });
    }
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.distress_lead_count).toBe(6);
    expect(result.low_activity).toBeUndefined();
    expect(result.insolvency_count).toBe(6);
  });

  it('always discloses the public-registry source in data_source', () => {
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.data_source).toContain('ISIR');
    expect(result.data_source).toContain('<5');
  });

  it('does not count leads from different district', () => {
    for (let i = 0; i < 6; i++) {
      insertLead({ id: `brno-${i}`, sourceType: 'isir', kuMatchedName: 'Brno' });
    }
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.distress_lead_count).toBe(0); // Praha has 0 leads
    expect(result.low_activity).toBe(true);
  });

  it('counts only scored leads — archived/pending/discarded excluded', () => {
    for (let i = 0; i < 6; i++) {
      insertLead({ id: `active-${i}`, sourceType: 'isir', kuMatchedName: 'Praha' });
    }
    insertLead({ id: 'arch-1', sourceType: 'isir', kuMatchedName: 'Praha', status: 'archived' });
    insertLead({ id: 'pend-1', sourceType: 'isir', kuMatchedName: 'Praha', status: 'pending_vision' });
    insertLead({ id: 'disc-1', sourceType: 'isir', kuMatchedName: 'Praha', status: 'discarded' });

    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    // scored 6 >= k=3 → not suppressed; non-scored rows don't inflate it
    expect(result.distress_lead_count).toBe(6);
  });

  it('falls back to kuMatchedName when okresSlug is missing', () => {
    // 5 leads (3 isir + 2 auction) so counts cross the k=5 band and stay visible —
    // this asserts the null-okresSlug fallback path, not the suppression logic.
    for (let i = 0; i < 3; i++) {
      insertLead({ id: `isir-${i}`, sourceType: 'isir', kuMatchedName: 'Praha', okresSlug: null });
    }
    insertLead({ id: 'auction-1', sourceType: 'portaldrazeb', kuMatchedName: 'Praha', okresSlug: null });
    insertLead({ id: 'auction-2', sourceType: 'portaldrazeb', kuMatchedName: 'Praha', okresSlug: null });

    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.insolvency_count).toBe(3);
    expect(result.auction_count).toBe(2);
    expect(result.distress_lead_count).toBe(5);
    expect(result.low_activity).toBeUndefined();
  });

  it('reads latest byt price from RealEstatePriceIndex using the district kraj', () => {
    testDb.prepare(`
      INSERT INTO RealEstatePriceIndex (
        id, kraj, propertyType, periodYear, periodQuarter, kcPerM2, source
      ) VALUES
        ('older', 'Praha', 'byt', 2023, 4, 303680, 'csu_vdb'),
        ('latest-low-priority', 'Praha', 'byt', 2025, 4, 379932, 'csu_vdb_extrap'),
        ('latest-high-priority', 'Praha', 'byt', 2025, 4, 382993, 'eurostat_hpi')
    `).run();

    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.avg_estimated_price_kc_per_m2).toBe(382993);
  });
});
