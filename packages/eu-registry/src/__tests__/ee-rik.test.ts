import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EeRikAdapter } from '../adapters/ee-rik.js';
import { ensureEeRikSchema, openEeRikDb } from '../ee-rik-store.js';
import { runEeRikIngest } from '../ingest-ee-rik.js';

const REAL_SCHEMA_FIXTURES = [
  {
    ariregistri_kood: 16752073,
    nimi: '007 Agent & Partners OÜ',
    yldandmed: {
      staatus: 'R',
      esmaregistreerimise_kpv: '05.06.2023',
      aadressid: [
        {
          lopp_kpv: null,
          aadress_ads__ads_normaliseeritud_taisaadress:
            'Harju maakond, Tallinn, Pirita linnaosa, Regati pst 12',
        },
      ],
    },
  },
  {
    ariregistri_kood: 90000002,
    nimi: 'Likvideerimise Test OÜ',
    yldandmed: {
      staatus: 'L',
      esmaregistreerimise_kpv: '11.01.2010',
      aadressid: [
        {
          lopp_kpv: null,
          aadress_ads__ads_normaliseeritud_taisaadress:
            'Tartu maakond, Tartu linn, Tartu linn, Turu tn 34',
        },
      ],
    },
  },
  {
    ariregistri_kood: 90000003,
    nimi: 'Pankroti Test AS',
    yldandmed: {
      staatus: 'N',
      esmaregistreerimise_kpv: '09.09.2009',
      aadressid: [
        {
          lopp_kpv: null,
          aadress_ads__ads_normaliseeritud_taisaadress:
            'Harju maakond, Tallinn, Kesklinna linnaosa, Kentmanni tn 4',
        },
      ],
    },
  },
];

describe('EeRikAdapter + ingest', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('ingests real nested schema and supports search + getById', async () => {
    const dbPath = tempDbPath(tmpDirs);
    await ingestFixtures(dbPath, REAL_SCHEMA_FIXTURES);

    const adapter = new EeRikAdapter(dbPath);
    const search = await adapter.searchByName('agent', 10);

    expect(search).toEqual({
      total_results: 1,
      companies: [
        {
          id: '16752073',
          country: 'ee',
          name: '007 Agent & Partners OÜ',
          status: 'active',
          address: 'Harju maakond, Tallinn, Pirita linnaosa, Regati pst 12',
          registered_on: '2023-06-05',
          source_url: 'https://ariregister.rik.ee/est/company/16752073',
        },
      ],
    });

    await expect(adapter.getById('16752073')).resolves.toEqual(search.companies[0]);
    await expect(adapter.getById('00000000')).resolves.toBeNull();
  });

  it('maps verified Estonia statuses R/L/N to shared status values', async () => {
    const dbPath = tempDbPath(tmpDirs);
    await ingestFixtures(dbPath, REAL_SCHEMA_FIXTURES);
    const adapter = new EeRikAdapter(dbPath);

    await expect(adapter.getById('16752073')).resolves.toMatchObject({ status: 'active' });
    await expect(adapter.getById('90000002')).resolves.toMatchObject({ status: 'dissolved' });
    await expect(adapter.getById('90000003')).resolves.toMatchObject({ status: 'dissolved' });
  });

  it('returns empty results and warns when the store is missing or empty', async () => {
    const missingWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missingAdapter = new EeRikAdapter(join(tempDir(tmpDirs), 'missing.db'));

    await expect(missingAdapter.searchByName('agent')).resolves.toEqual({ companies: [], total_results: 0 });
    await expect(missingAdapter.getById('16752073')).resolves.toBeNull();
    expect(missingWarn).toHaveBeenCalledTimes(1);
    missingWarn.mockClear();

    const dbPath = tempDbPath(tmpDirs);
    const db = openEeRikDb(dbPath);
    ensureEeRikSchema(db);
    db.close();

    const emptyAdapter = new EeRikAdapter(dbPath);
    await expect(emptyAdapter.searchByName('agent')).resolves.toEqual({ companies: [], total_results: 0 });
    expect(missingWarn).toHaveBeenCalledTimes(1);
  });

  it('guard rejects too-small ingest and keeps the previous store untouched', async () => {
    const dbPath = tempDbPath(tmpDirs);
    seedCompany(dbPath, {
      registry_code: 'existing',
      name: 'Existing Corp',
      status: 'active',
      address: 'Old address',
      registered_on: '2020-01-01',
      raw_json: '{"existing":true}',
    });

    await expect(
      runEeRikIngest({
        dbPath,
        minRecords: 100_000,
        fetchImpl: async () => new Response('zip-bytes'),
        openZipEntryStream: async () => Readable.from([JSON.stringify(REAL_SCHEMA_FIXTURES)]),
      }),
    ).rejects.toThrow(/parsed 3 records, expected at least 100000/);

    const adapter = new EeRikAdapter(dbPath);
    await expect(adapter.searchByName('Existing')).resolves.toEqual({
      total_results: 1,
      companies: [
        {
          id: 'existing',
          country: 'ee',
          name: 'Existing Corp',
          status: 'active',
          address: 'Old address',
          registered_on: '2020-01-01',
          source_url: 'https://ariregister.rik.ee/est/company/existing',
        },
      ],
    });
  });

  it('guard preserves the previous store when unzip fails', async () => {
    const dbPath = tempDbPath(tmpDirs);
    seedCompany(dbPath, {
      registry_code: '12345678',
      name: 'Stable Corp',
      status: 'unknown',
      address: null,
      registered_on: null,
      raw_json: '{"stable":true}',
    });

    await expect(
      runEeRikIngest({
        dbPath,
        fetchImpl: async () => new Response('zip-bytes'),
        openZipEntryStream: async () => {
          throw new Error('bad zip');
        },
      }),
    ).rejects.toThrow('bad zip');

    const adapter = new EeRikAdapter(dbPath);
    await expect(adapter.getById('12345678')).resolves.toEqual({
      id: '12345678',
      country: 'ee',
      name: 'Stable Corp',
      status: 'unknown',
      source_url: 'https://ariregister.rik.ee/est/company/12345678',
    });
  });
});

async function ingestFixtures(dbPath: string, records: unknown[]): Promise<void> {
  await runEeRikIngest({
    dbPath,
    minRecords: 1,
    fetchImpl: async () => new Response('zip-bytes'),
    openZipEntryStream: async () => Readable.from([JSON.stringify(records)]),
  });
}

function seedCompany(
  dbPath: string,
  company: {
    registry_code: string;
    name: string;
    status: string;
    address: string | null;
    registered_on: string | null;
    raw_json: string;
  },
): void {
  const db = openEeRikDb(dbPath);
  ensureEeRikSchema(db);
  db.prepare(`
    INSERT INTO ee_companies (registry_code, name, status, address, registered_on, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    company.registry_code,
    company.name,
    company.status,
    company.address,
    company.registered_on,
    company.raw_json,
  );
  db.close();
}

function tempDbPath(tmpDirs: string[]): string {
  return join(tempDir(tmpDirs), 'ee-rik.db');
}

function tempDir(tmpDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'czagents-ee-rik-'));
  tmpDirs.push(dir);
  return dir;
}
