import { Readable } from 'node:stream';
// stream-json is CommonJS — named ESM imports crash at runtime (vitest hides it by mocking
// the stream, real Node does not). Import the default and destructure. Verified 2026-07-10.
import streamJson from 'stream-json';
import streamArrayPkg from 'stream-json/streamers/StreamArray.js';
const { parser } = streamJson;
const { streamArray } = streamArrayPkg;
import unzipper from 'unzipper';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  EE_COMPANIES_STAGE_TABLE,
  EE_COMPANIES_TABLE,
  type EeCompanyRow,
  ensureEeRikSchema,
  openEeRikDb,
  resolveEeRikDbPath,
} from './ee-rik-store.js';

export const EE_RIK_DATASET_URL =
  'https://avaandmed.ariregister.rik.ee/sites/default/files/avaandmed/ettevotja_rekvisiidid__yldandmed.json.zip';
export const EE_RIK_MIN_RECORDS = 100_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const UPSERT_BATCH_SIZE = 1_000;

interface EeRikAddress {
  lopp_kpv?: string | null;
  aadress_ads__ads_normaliseeritud_taisaadress?: string | null;
}

interface EeRikGeneralData {
  staatus?: string | null;
  esmaregistreerimise_kpv?: string | null;
  aadressid?: EeRikAddress[];
}

interface EeRikRecord {
  ariregistri_kood?: number | string | null;
  nimi?: string | null;
  yldandmed?: EeRikGeneralData | null;
}

export interface EeRikIngestOptions {
  dbPath?: string;
  datasetUrl?: string;
  minRecords?: number;
  fetchImpl?: typeof fetch;
  openZipEntryStream?: (response: Response) => Promise<Readable>;
}

export interface EeRikIngestResult {
  dbPath: string;
  imported: number;
}

export async function runEeRikIngest(options: EeRikIngestOptions = {}): Promise<EeRikIngestResult> {
  const dbPath = resolveEeRikDbPath(options.dbPath);
  const db = openEeRikDb(dbPath);
  ensureEeRikSchema(db);

  try {
    const response = await fetchDataset(options.fetchImpl ?? globalThis.fetch, options.datasetUrl ?? EE_RIK_DATASET_URL);
    const jsonStream = await (options.openZipEntryStream ?? openZipEntryStream)(response);
    const imported = await ingestJsonStream(db, jsonStream, options.minRecords ?? EE_RIK_MIN_RECORDS);
    return { dbPath, imported };
  } finally {
    db.close();
  }
}

async function fetchDataset(fetchImpl: typeof fetch, datasetUrl: string): Promise<Response> {
  const response = await fetchImpl(datasetUrl, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/zip',
      'User-Agent': 'cz-agents eu-registry ee-rik ingest (+https://github.com/martinhavel/cz-agents-mcp)',
    },
  });
  if (!response.ok) {
    throw new Error(`EE RIK download failed: HTTP ${response.status} ${response.statusText}`);
  }
  return response;
}

export async function openZipEntryStream(response: Response): Promise<Readable> {
  if (!response.body) throw new Error('EE RIK download failed: empty response body');

  try {
    return Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>)
      .pipe(unzipper.ParseOne()) as unknown as Readable;
  } catch (error) {
    throw new Error(`EE RIK unzip failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function ingestJsonStream(db: DatabaseType, jsonStream: Readable, minRecords: number): Promise<number> {
  db.prepare(`DELETE FROM ${EE_COMPANIES_STAGE_TABLE}`).run();

  const insertStage = db.prepare(`
    INSERT INTO ${EE_COMPANIES_STAGE_TABLE} (
      registry_code,
      name,
      status,
      address,
      registered_on
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(registry_code) DO UPDATE SET
      name = excluded.name,
      status = excluded.status,
      address = excluded.address,
      registered_on = excluded.registered_on
  `);
  const flushBatch = db.transaction((rows: EeCompanyRow[]) => {
    for (const row of rows) {
      insertStage.run(row.registry_code, row.name, row.status, row.address, row.registered_on);
    }
  });

  const source = jsonStream.pipe(parser()).pipe(streamArray());
  const batch: EeCompanyRow[] = [];
  let imported = 0;

  try {
    for await (const chunk of source as AsyncIterable<{ value: EeRikRecord }>) {
      const row = toCompanyRow(chunk.value);
      if (!row) continue;
      batch.push(row);
      imported += 1;

      if (batch.length >= UPSERT_BATCH_SIZE) {
        flushBatch(batch.splice(0, batch.length));
      }
    }
    if (batch.length > 0) flushBatch(batch);
  } catch (error) {
    throw new Error(`EE RIK ingest failed while parsing JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (imported < minRecords) {
    throw new Error(
      `EE RIK ingest guard refused update: parsed ${imported} records, expected at least ${minRecords} (likely truncated download).`,
    );
  }

  db.transaction(() => {
    db.prepare(`DELETE FROM ${EE_COMPANIES_TABLE}`).run();
    db.prepare(`
      INSERT INTO ${EE_COMPANIES_TABLE} (
        registry_code,
        name,
        status,
        address,
        registered_on
      )
      SELECT registry_code, name, status, address, registered_on
      FROM ${EE_COMPANIES_STAGE_TABLE}
    `).run();
    db.prepare(`DELETE FROM ${EE_COMPANIES_STAGE_TABLE}`).run();
  })();

  return imported;
}

function toCompanyRow(record: EeRikRecord): EeCompanyRow | null {
  const registryCode = record.ariregistri_kood === undefined || record.ariregistri_kood === null
    ? null
    : String(record.ariregistri_kood).trim();
  const name = record.nimi?.trim();
  if (!registryCode || !name) return null;

  return {
    registry_code: registryCode,
    name,
    status: mapStatus(record.yldandmed?.staatus),
    address: pickAddress(record.yldandmed?.aadressid) ?? null,
    registered_on: normalizeDate(record.yldandmed?.esmaregistreerimise_kpv) ?? null,
  };
}

function mapStatus(status: string | null | undefined): EeCompanyRow['status'] {
  if (status === 'R') return 'active';
  if (status === 'L' || status === 'N') return 'dissolved';
  return 'unknown';
}

function pickAddress(addresses: EeRikAddress[] | undefined): string | undefined {
  const address = addresses?.find((item) => !item.lopp_kpv) ?? addresses?.[0];
  return address?.aadress_ads__ads_normaliseeritud_taisaadress?.trim() || undefined;
}

function normalizeDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!match) return undefined;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}
