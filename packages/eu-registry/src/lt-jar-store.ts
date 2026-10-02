import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

export const LT_JAR_DB_PATH_ENV = 'LT_JAR_DB_PATH';
export const DEFAULT_LT_JAR_DB_PATH = './lt-jar.db';
export const LT_COMPANIES_TABLE = 'lt_jar_companies';
export const LT_COMPANIES_STAGE_TABLE = 'lt_jar_companies_stage';
export const LT_METADATA_TABLE = 'lt_jar_metadata';

export interface LtJarCompanyRow {
  registry_code: string;
  name: string;
  search_name: string;
  status: 'active' | 'unknown';
  status_label: string | null;
  registered_on: string | null;
}

export function resolveLtJarDbPath(dbPath: string | undefined = process.env[LT_JAR_DB_PATH_ENV]): string {
  return dbPath?.trim() || DEFAULT_LT_JAR_DB_PATH;
}

export function openLtJarDb(dbPath: string | undefined): DatabaseType {
  const db = new Database(resolveLtJarDbPath(dbPath));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function ensureLtJarSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LT_COMPANIES_TABLE} (
      registry_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      search_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'unknown')),
      status_label TEXT,
      registered_on TEXT
    );
    CREATE INDEX IF NOT EXISTS lt_jar_companies_search_name_idx
      ON ${LT_COMPANIES_TABLE} (search_name);
    CREATE TABLE IF NOT EXISTS ${LT_COMPANIES_STAGE_TABLE} (
      registry_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      search_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'unknown')),
      status_label TEXT,
      registered_on TEXT
    );
    CREATE TABLE IF NOT EXISTS ${LT_METADATA_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
