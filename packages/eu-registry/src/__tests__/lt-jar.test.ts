import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { LtJarAdapter } from '../adapters/lt-jar.js';
import { runLtJarIngest } from '../ingest-lt-jar.js';
import type { Company, CompanySearchResult, RegistryAdapter } from '../types.js';

const tmpDirs: string[] = [];

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

describe('Lithuania JAR ingest and adapter', () => {
  it('ingests sequential 5,000-row pages, atomically serves the local JAR record, and omits address', async () => {
    const dbPath = tempDbPath();
    const records = Array.from({ length: 5001 }, (_, index) => fixture(index));
    const cursors: Array<string | null> = [];
    const requests: string[] = [];
    await runLtJarIngest({ dbPath, minRecords: 1, now: () => new Date('2026-10-02T03:04:05Z'), fetchImpl: mockDataset(records, cursors, requests) });
    expect(cursors).toEqual([null, 'next-5000', null]);
    expect(requests[0]).toBe('?count()');
    expect(requests.filter((request) => request.includes('_select') || request.includes('select('))).toEqual([]);
    expect(requests[2]).toContain('page(%22next-5000%22)');
    const fallback = fallbackAdapter();
    const adapter = new LtJarAdapter(fallback, dbPath);
    await expect(adapter.getById('10000000')).resolves.toEqual({
      id: '10000000', country: 'lt', name: 'Veikianti bendrovė 0', status: 'unknown', normalized_status: null, registered_on: '2020-01-01', source_url: 'https://get.data.gov.lt/datasets/gov/rc/jar/iregistruoti/JuridinisAsmuo', ingested_at: '2026-10-02T03:04:05.000Z', source_attribution: 'Registrų centras open data, CC BY 4.0', source_note: 'address not published in open data',
    });
    expect(fallback.calls).toBe(0);
  });

  it('rejects a 5% API count drop and preserves live data', async () => {
    const dbPath = tempDbPath();
    await runLtJarIngest({ dbPath, minRecords: 1, fetchImpl: mockDataset(Array.from({ length: 100 }, (_, i) => fixture(i)), []) });
    await expect(runLtJarIngest({ dbPath, minRecords: 1, fetchImpl: mockDataset(Array.from({ length: 94 }, (_, i) => fixture(i)), []) })).rejects.toThrow(/over 5% below live count/);
    await expect(new LtJarAdapter(fallbackAdapter(), dbPath).getById('10000099')).resolves.toMatchObject({ name: 'Veikianti bendrovė 99' });
    await expect(runLtJarIngest({ dbPath, minRecords: 1, fetchImpl: mockDataset(Array.from({ length: 95 }, (_, i) => fixture(i)), []) })).resolves.toMatchObject({ imported: 95 });
  });

  it('rejects an appearing HTTP validator and preserves live data', async () => {
    const dbPath = tempDbPath();
    await runLtJarIngest({ dbPath, minRecords: 1, fetchImpl: mockDataset(Array.from({ length: 2 }, (_, i) => fixture(i)), []) });
    let call = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has('count()')) return response({ _data: [{ 'count()': 2 }] });
      call += 1;
      return response({ _data: [fixture(0), fixture(1)], _page: {} }, call === 2 ? { etag: 'jar-rev-43' } : undefined);
    };
    await expect(runLtJarIngest({ dbPath, minRecords: 1, fetchImpl })).rejects.toThrow(/HTTP validator changed/);
    await expect(new LtJarAdapter(fallbackAdapter(), dbPath).getById('10000001')).resolves.toMatchObject({ name: 'Veikianti bendrovė 1' });
  });

  it('does not infer status from the opaque official relation', async () => {
    const dbPath = tempDbPath();
    const record = { ...fixture(0), isreg_data: null, statusas: { kodas: 0, pavadinimas: 'Active' } };
    await runLtJarIngest({ dbPath, minRecords: 1, fetchImpl: mockDataset([record], []) });
    const db = new Database(dbPath);
    db.prepare("UPDATE lt_jar_companies SET status = 'active', status_label = 'Active'").run();
    db.close();
    await expect(new LtJarAdapter(fallbackAdapter(), dbPath).getById('10000000')).resolves.toEqual(expect.objectContaining({ status: 'unknown', normalized_status: null }));
  });

  it('rejects a changed non-first first-page record when validators are absent', async () => {
    let pageCall = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (new URL(String(input)).searchParams.has('count()')) return response({ _data: [{ 'count()': 2 }] });
      pageCall += 1;
      const records = [fixture(0), pageCall === 2 ? { ...fixture(1), _revision: 'changed' } : fixture(1)];
      return response({ _data: records, _page: {} });
    };
    await expect(runLtJarIngest({ dbPath: tempDbPath(), minRecords: 1, fetchImpl })).rejects.toThrow(/first-page sentinel changed/);
  });

  it('uses local LT data when available and retains VIES/GLEIF fallback on unavailable store or local miss', async () => {
    const fallback = fallbackAdapter();
    const missing = new LtJarAdapter(fallback, join(tempDir(), 'missing.db'));
    await expect(missing.getById('123456789')).resolves.toMatchObject({ name: 'Fallback company' });
    expect(fallback.calls).toBe(1);

    const dbPath = tempDbPath();
    await runLtJarIngest({ dbPath, minRecords: 1, fetchImpl: mockDataset([fixture(0)], []) });
    const available = new LtJarAdapter(fallback, dbPath);
    await expect(available.getById('999999999')).resolves.toMatchObject({ name: 'Fallback company' });
    await expect(available.getById('LT120212314')).resolves.toMatchObject({ name: 'Fallback company' });
    expect(fallback.calls).toBe(3);
  });

  it('finds Lithuanian names without diacritics through the local normalized search key', async () => {
    const dbPath = tempDbPath();
    const record = { ...fixture(0), ja_pavadinimas: 'Uždaroji akcinė bendrovė Žąsis' };
    await runLtJarIngest({ dbPath, minRecords: 1, fetchImpl: mockDataset([record], []) });
    await expect(new LtJarAdapter(fallbackAdapter(), dbPath).searchByName('uzdaroji akcinė bendrovė zasis')).resolves.toMatchObject({ total_results: 1, companies: [{ name: 'Uždaroji akcinė bendrovė Žąsis' }] });
  });

  it('quotes page cursors as JSON and does not let their contents become query clauses', async () => {
    const dbPath = tempDbPath();
    const cursor = 'next")&select(evil)';
    const requests: string[] = [];
    let pageCall = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url.search);
      if (url.searchParams.has('count()')) return response({ _data: [{ 'count()': 2 }] });
      pageCall += 1;
      if (pageCall === 1) return response({ _data: [fixture(0)], _page: { next: cursor } });
      if (pageCall === 2) return response({ _data: [fixture(1)], _page: {} });
      return response({ _data: [fixture(0)], _page: {} });
    };
    await runLtJarIngest({ dbPath, minRecords: 1, fetchImpl });
    expect(requests[2]).toContain('page(%22next%5C%22)%26select(evil)%22)');
    expect(new URLSearchParams(requests[2]).has('select(evil)')).toBe(false);
  });

  it('rejects a repeated cursor and an empty page with a continuation', async () => {
    const dbPath = tempDbPath();
    let pageCall = 0;
    const repeated: typeof fetch = async (input) => {
      if (new URL(String(input)).searchParams.has('count()')) return response({ _data: [{ 'count()': 2 }] });
      pageCall += 1;
      return response({ _data: [fixture(pageCall)], _page: { next: 'again' } });
    };
    await expect(runLtJarIngest({ dbPath, minRecords: 1, fetchImpl: repeated })).rejects.toThrow(/repeated a page cursor/);
    const empty: typeof fetch = async (input) => new URL(String(input)).searchParams.has('count()') ? response({ _data: [{ 'count()': 1 }] }) : response({ _data: [], _page: { next: 'again' } });
    await expect(runLtJarIngest({ dbPath: tempDbPath(), minRecords: 1, fetchImpl: empty })).rejects.toThrow(/empty page with continuation/);
  });

  it('normalizes valid Last-Modified and omits an invalid value', async () => {
    const valid = await runLtJarIngest({ dbPath: tempDbPath(), minRecords: 1, fetchImpl: headerDataset('Fri, 21 Aug 2026 06:07:56 GMT') });
    const invalid = await runLtJarIngest({ dbPath: tempDbPath(), minRecords: 1, fetchImpl: headerDataset('not a date') });
    expect(valid.sourceSnapshotAt).toBe('2026-08-21T06:07:56.000Z');
    expect(invalid.sourceSnapshotAt).toBeUndefined();
  });
});

function fixture(index: number) { return { _type: 'datasets/gov/rc/jar/iregistruoti/JuridinisAsmuo', _id: `row-${index}`, _revision: `row-rev-${index}`, ja_kodas: 10000000 + index, ja_pavadinimas: `Veikianti bendrovė ${index}`, reg_data: '2020-01-01', isreg_data: null, statusas: { _id: 'opaque-status-id' } }; }
function mockDataset(records: unknown[], cursors: Array<string | null>, requests: string[] = []): typeof fetch {
  return (async (input) => {
    const url = new URL(String(input));
    requests.push(url.search);
    if (url.searchParams.has('count()')) return response({ _data: [{ 'count()': records.length }] });
    const pageArgument = /[?&]page\(([^)]+)\)/.exec(url.search)?.[1];
    const cursor = pageArgument ? decodeURIComponent(pageArgument).replace(/^"|"$/g, '') : null;
    cursors.push(cursor);
    const offset = cursor === 'next-5000' ? 5000 : 0;
    return response({ _data: records.slice(offset, offset + 5000), _page: offset + 5000 < records.length ? { next: 'next-5000' } : {} });
  }) as typeof fetch;
}
function headerDataset(lastModified: string): typeof fetch {
  let pageCall = 0;
  return async (input) => {
    if (new URL(String(input)).searchParams.has('count()')) return response({ _data: [{ 'count()': 1 }] }, { 'last-modified': lastModified });
    pageCall += 1;
    return response({ _data: [fixture(0)], _page: {} }, { 'last-modified': lastModified, etag: pageCall === 2 ? 'same' : 'same' });
  };
}
function response(body: unknown, headers?: HeadersInit): Response {
  const responseHeaders = new Headers({ 'content-type': 'application/json' });
  new Headers(headers).forEach((value, key) => responseHeaders.set(key, value));
  return new Response(JSON.stringify(body), { status: 200, headers: responseHeaders });
}
function fallbackAdapter(): RegistryAdapter & { calls: number } {
  const adapter = { calls: 0, async getById(id: string): Promise<Company | null> { adapter.calls += 1; return { id, country: 'lt', name: 'Fallback company', status: 'unknown' }; }, async searchByName(): Promise<CompanySearchResult> { adapter.calls += 1; return { companies: [], total_results: 0 }; } };
  return adapter;
}
function tempDbPath(): string { return join(tempDir(), 'lt-jar.db'); }
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), 'czagents-lt-jar-')); tmpDirs.push(dir); return dir; }
