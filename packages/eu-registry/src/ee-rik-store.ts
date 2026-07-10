import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

export const EE_RIK_DB_PATH_ENV = 'EE_RIK_DB_PATH';
export const DEFAULT_EE_RIK_DB_PATH = './ee-rik.db';
export const EE_COMPANIES_TABLE = 'ee_companies';
export const EE_COMPANIES_STAGE_TABLE = 'ee_companies_stage';

export interface EeCompanyRow {
  registry_code: string;
  name: string;
  status: 'active' | 'dissolved' | 'unknown';
  address: string | null;
  registered_on: string | null;
}

export function resolveEeRikDbPath(dbPath: string | undefined = process.env[EE_RIK_DB_PATH_ENV]): string {
  return dbPath?.trim() || DEFAULT_EE_RIK_DB_PATH;
}

export function openEeRikDb(dbPath: string | undefined): DatabaseType {
  const db = new Database(resolveEeRikDbPath(dbPath));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function ensureEeRikSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EE_COMPANIES_TABLE} (
      registry_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'dissolved', 'unknown')),
      address TEXT,
      registered_on TEXT
    );

    CREATE INDEX IF NOT EXISTS ee_companies_name_idx
      ON ${EE_COMPANIES_TABLE} (name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS ${EE_COMPANIES_STAGE_TABLE} (
      registry_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'dissolved', 'unknown')),
      address TEXT,
      registered_on TEXT
    );
  `);
}
