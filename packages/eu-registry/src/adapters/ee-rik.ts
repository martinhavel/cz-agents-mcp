import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from '../types.js';
import { EE_COMPANIES_TABLE, resolveEeRikDbPath } from '../ee-rik-store.js';

const SOURCE_BASE = 'https://ariregister.rik.ee/est/company';

interface EeCompanyDbRow {
  registry_code: string;
  name: string;
  status: string;
  address: string | null;
  registered_on: string | null;
}

export class EeRikAdapter implements RegistryAdapter {
  private db: DatabaseType | null = null;
  private warnedUnavailable = false;

  constructor(private readonly dbPath = resolveEeRikDbPath()) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    const db = this.openDb();
    if (!db) return { companies: [], total_results: 0 };

    try {
      const rows = db.prepare<[string, number], EeCompanyDbRow>(`
        SELECT registry_code, name, status, address, registered_on
        FROM ${EE_COMPANIES_TABLE}
        WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY name ASC
        LIMIT ?
      `).all(likePattern(name), limit);

      return {
        companies: rows.map(mapRow),
        total_results: rows.length,
      };
    } catch (error) {
      this.warnUnavailable(`EE RIK search failed for ${this.dbPath}`, error);
      return { companies: [], total_results: 0 };
    }
  }

  async getById(id: string): Promise<Company | null> {
    if (!/^\d+$/.test(id)) return null;

    const db = this.openDb();
    if (!db) return null;

    try {
      const row = db.prepare<[string], EeCompanyDbRow>(`
        SELECT registry_code, name, status, address, registered_on
        FROM ${EE_COMPANIES_TABLE}
        WHERE registry_code = ?
      `).get(id);
      return row ? mapRow(row) : null;
    } catch (error) {
      this.warnUnavailable(`EE RIK lookup failed for ${this.dbPath}`, error);
      return null;
    }
  }

  private openDb(): DatabaseType | null {
    if (this.db) return this.db;
    if (!existsSync(this.dbPath)) {
      this.warnUnavailable(`EE RIK store not found at ${this.dbPath}`);
      return null;
    }

    try {
      const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      const tableExists = db.prepare(`
        SELECT 1 AS found
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `).get(EE_COMPANIES_TABLE) as { found: number } | undefined;
      if (!tableExists) {
        db.close();
        this.warnUnavailable(`EE RIK table ${EE_COMPANIES_TABLE} missing in ${this.dbPath}`);
        return null;
      }

      const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${EE_COMPANIES_TABLE}`).get() as { count: number } | undefined)?.count ?? 0;
      if (count === 0) {
        db.close();
        this.warnUnavailable(`EE RIK store at ${this.dbPath} is empty`);
        return null;
      }

      this.db = db;
      return db;
    } catch (error) {
      this.warnUnavailable(`EE RIK store unavailable at ${this.dbPath}`, error);
      return null;
    }
  }

  private warnUnavailable(message: string, error?: unknown): void {
    if (this.warnedUnavailable) return;
    this.warnedUnavailable = true;
    if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`);
    else console.warn(`[cz-agents/eu-registry] ${message}:`, error);
  }
}

function mapRow(row: EeCompanyDbRow): Company {
  return {
    id: row.registry_code,
    country: 'ee',
    name: row.name,
    status: normalizeStoredStatus(row.status),
    address: row.address ?? undefined,
    registered_on: row.registered_on ?? undefined,
    source_url: `${SOURCE_BASE}/${row.registry_code}`,
  };
}

function normalizeStoredStatus(status: string): CompanyStatus {
  if (status === 'active' || status === 'dissolved') return status;
  return 'unknown';
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}
