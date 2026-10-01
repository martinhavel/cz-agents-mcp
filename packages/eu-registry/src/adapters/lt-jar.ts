import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Company, CompanySearchResult, RegistryAdapter } from '../types.js';
import { LT_COMPANIES_TABLE, LT_METADATA_TABLE, resolveLtJarDbPath } from '../lt-jar-store.js';
import { normalizeSearchName } from '../ingest-lt-jar.js';

const SOURCE_URL = 'https://get.data.gov.lt/datasets/gov/rc/jar/iregistruoti/JuridinisAsmuo';
const ADDRESS_NOTE = 'address not published in open data';
interface Row { registry_code: string; name: string; status: string; status_label: string | null; registered_on: string | null; }

export class LtJarAdapter implements RegistryAdapter {
  private db: DatabaseType | null = null;
  private warnedUnavailable = false;
  constructor(private readonly fallback: RegistryAdapter, private readonly dbPath = resolveLtJarDbPath()) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    const db = this.openDb();
    if (!db) return this.fallback.searchByName(name, limit);
    try {
      const rows = db.prepare<[string, number], Row>(`SELECT registry_code, name, status, status_label, registered_on FROM ${LT_COMPANIES_TABLE} WHERE search_name LIKE ? ESCAPE '\\' ORDER BY name ASC LIMIT ?`).all(likePattern(normalizeSearchName(name)), limit);
      return rows.length > 0 ? { companies: rows.map((row) => this.mapRow(row, db)), total_results: rows.length } : this.fallback.searchByName(name, limit);
    } catch (error) { this.warnUnavailable(`LT JAR search failed for ${this.dbPath}`, error); return this.fallback.searchByName(name, limit); }
  }

  async getById(id: string): Promise<Company | null> {
    if (/^LT/i.test(id)) return this.fallback.getById(id);
    const registryCode = id;
    if (!/^\d+$/.test(registryCode)) return null;
    const db = this.openDb();
    if (!db) return this.fallback.getById(id);
    try {
      const row = db.prepare<[string], Row>(`SELECT registry_code, name, status, status_label, registered_on FROM ${LT_COMPANIES_TABLE} WHERE registry_code = ?`).get(registryCode);
      return row ? this.mapRow(row, db) : this.fallback.getById(id);
    } catch (error) { this.warnUnavailable(`LT JAR lookup failed for ${this.dbPath}`, error); return this.fallback.getById(id); }
  }

  private openDb(): DatabaseType | null {
    if (this.db) return this.db;
    if (!existsSync(this.dbPath)) { this.warnUnavailable(`LT JAR store not found at ${this.dbPath}`); return null; }
    try {
      const db = new Database(this.dbPath, { readonly: true, fileMustExist: true }); db.pragma('busy_timeout = 5000');
      const table = db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(LT_COMPANIES_TABLE) as { found: number } | undefined;
      const count = table ? (db.prepare(`SELECT COUNT(*) AS count FROM ${LT_COMPANIES_TABLE}`).get() as { count: number }).count : 0;
      if (!table || count === 0) { db.close(); this.warnUnavailable(`LT JAR store unavailable at ${this.dbPath}`); return null; }
      this.db = db; return db;
    } catch (error) { this.warnUnavailable(`LT JAR store unavailable at ${this.dbPath}`, error); return null; }
  }

  private mapRow(row: Row, db: DatabaseType): Company {
    const metadata = Object.fromEntries(
      (db.prepare(`SELECT key, value FROM ${LT_METADATA_TABLE}`).all() as Array<{ key: string; value: string }>)
        .map(({ key, value }) => [key, value]),
    );
    const sourceSnapshotAt = metadata['source_snapshot_at'];
    return { id: row.registry_code, country: 'lt', name: row.name, status: 'unknown', normalized_status: null, registered_on: row.registered_on ?? undefined, source_url: SOURCE_URL, source_snapshot_at: sourceSnapshotAt, ingested_at: metadata['ingested_at'], source_attribution: metadata['source_attribution'] ?? 'Registrų centras open data, CC BY 4.0', source_note: metadata['source_note'] ?? ADDRESS_NOTE, source_publication: sourceSnapshotAt ? `data as published by Registrų centras on ${sourceSnapshotAt}` : undefined };
  }
  private warnUnavailable(message: string, error?: unknown): void { if (this.warnedUnavailable) return; this.warnedUnavailable = true; if (error === undefined) console.warn(`[cz-agents/eu-registry] ${message}`); else console.warn(`[cz-agents/eu-registry] ${message}:`, error); }
}
function likePattern(value: string): string { return `%${value.replace(/[\\%_]/g, '\\$&')}%`; }
