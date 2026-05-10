/**
 * Unit tests for getDistrictAggregate — the only free-tier tool remaining in
 * @czagents/realestate@0.2.0. Paid tools (search_distress_properties,
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
  lat REAL,
  lng REAL
);
`;

function insertLead(opts: {
  id: string;
  sourceType: 'isir' | 'portaldrazeb' | 'cevd';
  kuMatchedName?: string;
  ingestedAt?: string;
  status?: string;
}): void {
  testDb.prepare(`
    INSERT INTO RealEstateLead (
      id, sourceType, spisovaZnacka, courtCode, ingestedAt, status, kuMatchedName
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.sourceType,
    `INS-${opts.id}`,
    'KSPH',
    opts.ingestedAt ?? new Date().toISOString(),
    opts.status ?? 'pending_vision',
    opts.kuMatchedName ?? 'Praha',
  );
}

beforeAll(() => testDb.exec(SCHEMA));
afterAll(() => testDb.close());
beforeEach(() => testDb.exec('DELETE FROM RealEstateLead;'));

describe('getDistrictAggregate', () => {
  it('returns zeros and low_activity for empty district', () => {
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.okres).toBe('Praha');
    expect(result.window_days).toBe(90);
    expect(result.distress_lead_count).toBeNull(); // below k=5
    expect(result.low_activity).toBe(true);
  });

  it('returns counts when >= k=5 leads in district', () => {
    for (let i = 0; i < 6; i++) {
      insertLead({ id: `isir-${i}`, sourceType: 'isir', kuMatchedName: 'Praha' });
    }
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.distress_lead_count).toBe(6);
    expect(result.low_activity).toBeUndefined();
    expect(result.insolvency_count).toBe(6);
  });

  it('does not count leads from different district', () => {
    for (let i = 0; i < 6; i++) {
      insertLead({ id: `brno-${i}`, sourceType: 'isir', kuMatchedName: 'Brno' });
    }
    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    expect(result.distress_lead_count).toBeNull(); // Praha has 0 leads
    expect(result.low_activity).toBe(true);
  });

  it('excludes archived leads from distress count', () => {
    for (let i = 0; i < 6; i++) {
      insertLead({ id: `active-${i}`, sourceType: 'isir', kuMatchedName: 'Praha' });
    }
    insertLead({ id: 'arch-1', sourceType: 'isir', kuMatchedName: 'Praha', status: 'archived' });

    const result = getDistrictAggregate({ okres: 'Praha', window_days: 90 });
    // active 6 >= k=5 → not suppressed
    expect(result.distress_lead_count).toBe(6);
  });
});
