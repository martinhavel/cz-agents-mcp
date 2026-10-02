import type { Database as DatabaseType } from 'better-sqlite3';
import {
  LT_COMPANIES_STAGE_TABLE,
  LT_COMPANIES_TABLE,
  LT_METADATA_TABLE,
  type LtJarCompanyRow,
  ensureLtJarSchema,
  openLtJarDb,
  resolveLtJarDbPath,
} from './lt-jar-store.js';

export const LT_JAR_DATASET_URL = 'https://get.data.gov.lt/datasets/gov/rc/jar/iregistruoti/JuridinisAsmuo';
export const LT_JAR_PAGE_SIZE = 5_000;
export const LT_JAR_MIN_RECORDS = 500_000;
const DROP_GUARD_RATIO = 0.95;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
const RETRY_AFTER_MAX_MS = 60_000;
type JsonRecord = Record<string, unknown>;
interface Page { records: JsonRecord[]; next: string | undefined; snapshot: Snapshot; }
interface Snapshot { etag: string | undefined; publishedAt: string | undefined; sentinel: string | undefined; }

export interface LtJarIngestOptions {
  dbPath?: string;
  datasetUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  minRecords?: number;
}

export interface LtJarIngestResult {
  dbPath: string;
  imported: number;
  sourceSnapshotAt?: string;
  ingestedAt: string;
}

export async function runLtJarIngest(options: LtJarIngestOptions = {}): Promise<LtJarIngestResult> {
  const dbPath = resolveLtJarDbPath(options.dbPath);
  const db = openLtJarDb(dbPath);
  ensureLtJarSchema(db);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const datasetUrl = options.datasetUrl ?? LT_JAR_DATASET_URL;
  try {
    const expectedCount = await fetchCount(fetchImpl, datasetUrl);
    const first = await fetchPage(fetchImpl, datasetUrl);
    const minRecords = options.minRecords ?? LT_JAR_MIN_RECORDS;
    if (!Number.isInteger(expectedCount) || expectedCount < minRecords) throw new Error(`LT JAR ingest failed: upstream count() ${expectedCount} is below sanity minimum ${minRecords}`);
    const existingCount = countRows(db, LT_COMPANIES_TABLE);
    if (existingCount > 0 && expectedCount < Math.ceil(existingCount * DROP_GUARD_RATIO)) {
      throw new Error(`LT JAR ingest guard refused update: upstream count ${expectedCount} is over 5% below live count ${existingCount}`);
    }

    db.prepare(`DELETE FROM ${LT_COMPANIES_STAGE_TABLE}`).run();
    const writeBatch = stageWriter(db);
    let received = 0;
    let page: Page | undefined = first;
    const seenCursors = new Set<string>();
    while (page) {
      assertSameValidators(first.snapshot, page.snapshot);
      const rows = page.records.map(toCompanyRow).filter((row): row is LtJarCompanyRow => row !== null);
      writeBatch(rows);
      received += rows.length;
      if (received < expectedCount && !page.next) throw new Error('LT JAR ingest failed: upstream page ended before count()');
      if (received > expectedCount) throw new Error('LT JAR ingest failed: received more records than upstream count()');
      if (page.next && rows.length === 0) throw new Error('LT JAR ingest failed: upstream returned an empty page with continuation');
      if (page.next && seenCursors.has(page.next)) throw new Error('LT JAR ingest failed: upstream repeated a page cursor');
      if (page.next) seenCursors.add(page.next);
      page = page.next ? await fetchPage(fetchImpl, datasetUrl, page.next) : undefined;
    }
    const imported = countRows(db, LT_COMPANIES_STAGE_TABLE);
    if (imported !== expectedCount) throw new Error(`LT JAR ingest failed: staged ${imported} unique records but upstream count() is ${expectedCount}`);

    const finalCheck = await fetchPage(fetchImpl, datasetUrl);
    assertSameSnapshot(first.snapshot, finalCheck.snapshot);
    if (await fetchCount(fetchImpl, datasetUrl) !== expectedCount) throw new Error('LT JAR ingest failed: upstream count() changed during ingestion');

    const ingestedAt = (options.now ?? (() => new Date()))().toISOString();
    db.transaction(() => {
      db.prepare(`DELETE FROM ${LT_COMPANIES_TABLE}`).run();
      db.prepare(`INSERT INTO ${LT_COMPANIES_TABLE} (registry_code, name, search_name, status, status_label, registered_on)
        SELECT registry_code, name, search_name, status, status_label, registered_on FROM ${LT_COMPANIES_STAGE_TABLE}`).run();
      db.prepare(`DELETE FROM ${LT_METADATA_TABLE}`).run();
      const put = db.prepare(`INSERT INTO ${LT_METADATA_TABLE} (key, value) VALUES (?, ?)`);
      if (first.snapshot.publishedAt) put.run('source_snapshot_at', first.snapshot.publishedAt);
      if (first.snapshot.etag) put.run('source_revision', first.snapshot.etag);
      put.run('ingested_at', ingestedAt);
      put.run('source_attribution', 'Registrų centras open data, CC BY 4.0');
      put.run('source_note', 'address not published in open data');
      db.prepare(`DELETE FROM ${LT_COMPANIES_STAGE_TABLE}`).run();
    })();
    return { dbPath, imported, sourceSnapshotAt: first.snapshot.publishedAt, ingestedAt };
  } finally { db.close(); }
}

async function fetchCount(fetchImpl: typeof fetch, datasetUrl: string): Promise<number> {
  return requestWithRetry(fetchImpl, `${datasetUrl}${datasetUrl.includes('?') ? '&' : '?'}count()`, async (response) => {
    const body = await response.json() as JsonRecord;
    const count = (dataRecords(body)[0] ?? {})['count()'];
    const numericCount = typeof count === 'number' ? count : Number(count);
    if (!Number.isFinite(numericCount)) throw new Error('LT JAR ingest failed: upstream response has no count()');
    return numericCount;
  });
}

async function fetchPage(fetchImpl: typeof fetch, datasetUrl: string, cursor?: string): Promise<Page> {
  const url = new URL(datasetUrl);
  url.searchParams.set('_limit', String(LT_JAR_PAGE_SIZE));
  // Spinta omits the cursor from projected responses. Keep the complete page so
  // the documented `page(<token>)` continuation remains available.
  if (cursor) url.search += `${url.search ? '&' : '?'}page(${encodeURIComponent(JSON.stringify(cursor))})`;
  return requestWithRetry(fetchImpl, url, async (response) => {
    const body = await response.json() as JsonRecord;
    const records = dataRecords(body);
    if (records.length > LT_JAR_PAGE_SIZE) throw new Error('LT JAR ingest failed: invalid page size');
    return { records, next: pageCursor(body), snapshot: snapshotOf(records, response) };
  });
}

async function requestWithRetry<T>(fetchImpl: typeof fetch, url: string | URL, parse: (response: Response) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetchImpl(url, requestOptions());
      if (!response.ok) {
        const retryAfter = retryAfterMs(response);
        if (!retryableStatus(response.status)) {
          await discard(response);
          throw new Error(`LT JAR ingest failed: HTTP ${response.status} ${response.statusText}`);
        }
        if (retryAfter !== undefined && retryAfter > RETRY_AFTER_MAX_MS) throw new Error(`LT JAR ingest failed: Retry-After ${retryAfter}ms exceeds 60000ms`);
        await discard(response);
        if (attempt === RETRY_DELAYS_MS.length) throw new Error(`LT JAR ingest failed: HTTP ${response.status} ${response.statusText}`);
        await delay(Math.max(RETRY_DELAYS_MS[attempt]!, retryAfter ?? 0));
        continue;
      }
      return await parse(response);
    } catch (error) {
      if (!retryableError(error) || attempt === RETRY_DELAYS_MS.length) throw error;
      await discard(response);
      await delay(RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw new Error('LT JAR ingest failed: retry loop exhausted');
}

function retryableStatus(status: number): boolean { return status === 429 || (status >= 500 && status <= 599); }
function retryableError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
}
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
async function discard(response: Response | undefined): Promise<void> { try { await response?.body?.cancel(); } catch { /* discard only */ } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function dataRecords(body: JsonRecord): JsonRecord[] {
  const value = body['_data'] ?? body['data'];
  if (!Array.isArray(value)) throw new Error('LT JAR ingest failed: upstream response has no data array');
  return value.filter((item): item is JsonRecord => item !== null && typeof item === 'object' && !Array.isArray(item));
}

function pageCursor(body: JsonRecord): string | undefined {
  const page = objectValue(body['_page']);
  return typeof page?.['next'] === 'string' && page['next'].trim() ? page['next'] : undefined;
}

function requestOptions(): RequestInit { return { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }; }
function snapshotOf(records: JsonRecord[], response: Response): Snapshot {
  return { etag: response.headers.get('etag') ?? undefined, publishedAt: normalizeHttpDate(response.headers.get('last-modified')), sentinel: fingerprintFirstPage(records) };
}
function fingerprintFirstPage(records: JsonRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  const pairs = records.map((record) => {
    const id = stringField(record, ['_id']);
    const revision = stringField(record, ['_revision']);
    return id && revision ? `${id}\u0000${revision}` : undefined;
  });
  return pairs.every((pair): pair is string => pair !== undefined) ? pairs.join('\u0001') : undefined;
}
function objectValue(value: unknown): JsonRecord | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined; }
function normalizeHttpDate(value: string | null): string | undefined { if (!value) return undefined; const time = Date.parse(value); return Number.isNaN(time) ? undefined : new Date(time).toISOString(); }
function assertSameValidators(expected: Snapshot, actual: Snapshot): void {
  if (((expected.etag !== undefined || actual.etag !== undefined) && expected.etag !== actual.etag) || ((expected.publishedAt !== undefined || actual.publishedAt !== undefined) && expected.publishedAt !== actual.publishedAt)) {
    throw new Error('LT JAR ingest failed: upstream HTTP validator changed during ingestion');
  }
}
function assertSameSnapshot(expected: Snapshot, actual: Snapshot): void {
  assertSameValidators(expected, actual);
  if (expected.etag === undefined && expected.publishedAt === undefined && actual.etag === undefined && actual.publishedAt === undefined) {
    if (!expected.sentinel || !actual.sentinel || expected.sentinel !== actual.sentinel) throw new Error('LT JAR ingest failed: upstream first-page sentinel changed during ingestion');
  }
}
function countRows(db: DatabaseType, table: string): number { return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count; }
function stageWriter(db: DatabaseType): (rows: LtJarCompanyRow[]) => void {
  const insert = db.prepare(`INSERT INTO ${LT_COMPANIES_STAGE_TABLE} (registry_code, name, search_name, status, status_label, registered_on) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(registry_code) DO UPDATE SET name=excluded.name, search_name=excluded.search_name, status=excluded.status, status_label=excluded.status_label, registered_on=excluded.registered_on`);
  return db.transaction((rows: LtJarCompanyRow[]) => { for (const row of rows) insert.run(row.registry_code, row.name, row.search_name, row.status, row.status_label, row.registered_on); });
}

function toCompanyRow(record: JsonRecord): LtJarCompanyRow | null {
  const registryCode = stringField(record, ['ja_kodas', 'kodas', 'juridinio_asmens_kodas', 'id']);
  const name = stringField(record, ['ja_pavadinimas', 'pavadinimas', 'pilnas_pavadinimas', 'name']);
  if (!registryCode || !name) return null;
  return { registry_code: registryCode, name, search_name: normalizeSearchName(name), status: 'unknown', status_label: null, registered_on: normalizeDate(record['reg_data'] ?? record['iregistravimo_data'] ?? record['registracijos_data'] ?? record['registration_date']) };
}
function stringField(record: JsonRecord, keys: string[]): string | undefined { for (const key of keys) { const value = record[key]; if (typeof value === 'string' && value.trim()) return value.trim(); if (typeof value === 'number') return String(value); } return undefined; }
function normalizeDate(value: unknown): string | null { if (typeof value !== 'string') return null; const date = value.trim(); return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null; }
export function normalizeSearchName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').toLocaleLowerCase('lt-LT');
}
