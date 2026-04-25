/**
 * SQLite-backed storage for normalized sanctions records.
 *
 * Schema:
 *   entities  — one row per SanctionedEntity (raw JSON kept for audit)
 *   aliases   — flat table of (entity_id, alias_normalized) for fast LIKE / FTS
 *   ids       — flat table of (entity_id, type, value) for exact-ID lookup
 *   refresh_log — audit of last fetch per source
 *   change_log — track add/modify/remove for `list_recent_updates`
 *
 * Full-text search via FTS5 (built into better-sqlite3's bundled SQLite).
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SanctionedEntity, SanctionSource } from './types.js';
import { normalizeName } from './normalize.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  source_list_id  TEXT NOT NULL,
  type            TEXT NOT NULL,
  primary_name    TEXT NOT NULL,
  primary_name_norm TEXT NOT NULL,
  data            TEXT NOT NULL,           -- full JSON blob of SanctionedEntity
  listed_on       TEXT,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  removed_at      INTEGER                  -- soft delete; NULL = active
);

CREATE INDEX IF NOT EXISTS idx_entities_source       ON entities(source);
CREATE INDEX IF NOT EXISTS idx_entities_type         ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_pname_norm   ON entities(primary_name_norm);
CREATE INDEX IF NOT EXISTS idx_entities_removed      ON entities(removed_at);

CREATE TABLE IF NOT EXISTS aliases (
  entity_id    TEXT NOT NULL,
  alias        TEXT NOT NULL,              -- normalized
  raw_alias    TEXT NOT NULL,              -- original spelling
  PRIMARY KEY (entity_id, alias),
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);

CREATE TABLE IF NOT EXISTS ids (
  entity_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  value      TEXT NOT NULL,
  country    TEXT,
  PRIMARY KEY (entity_id, type, value),
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ids_lookup ON ids(type, value);

CREATE TABLE IF NOT EXISTS refresh_log (
  source       TEXT PRIMARY KEY,
  refreshed_at INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  ok           INTEGER NOT NULL,           -- 0 / 1
  error        TEXT
);

CREATE TABLE IF NOT EXISTS change_log (
  ts          INTEGER NOT NULL,
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL,               -- 'add' | 'modify' | 'remove'
  before_data TEXT,
  after_data  TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_log_ts ON change_log(ts);
`;

export interface DbStats {
  total_active: number;
  total_removed: number;
  by_source: Record<string, number>;
  refresh_log: Array<{
    source: string;
    refreshed_at: string;
    source_count: number;
    ok: boolean;
    error: string | null;
  }>;
}

export class SanctionsDb {
  private readonly db: DatabaseType;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Upsert a batch of entities for a given source. Diffs against existing
   * rows and writes change_log entries for `list_recent_updates`.
   */
  upsertSource(source: SanctionSource, entities: SanctionedEntity[]): {
    added: number;
    modified: number;
    removed: number;
  } {
    const now = Date.now();
    const incomingIds = new Set(entities.map((e) => e.id));
    let added = 0;
    let modified = 0;
    let removed = 0;

    const existing = this.db
      .prepare<[string], { id: string; data: string }>('SELECT id, data FROM entities WHERE source = ? AND removed_at IS NULL')
      .all(source);
    const existingMap = new Map<string, SanctionedEntity>(
      existing.map((row) => [row.id, JSON.parse(row.data) as SanctionedEntity]),
    );

    const insertEntity = this.db.prepare(`
      INSERT INTO entities (id, source, source_list_id, type, primary_name, primary_name_norm, data, listed_on, first_seen_at, last_seen_at, removed_at)
      VALUES (@id, @source, @source_list_id, @type, @primary_name, @primary_name_norm, @data, @listed_on, @now, @now, NULL)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        primary_name = excluded.primary_name,
        primary_name_norm = excluded.primary_name_norm,
        data = excluded.data,
        listed_on = excluded.listed_on,
        last_seen_at = excluded.last_seen_at,
        removed_at = NULL
    `);

    const deleteAliases = this.db.prepare('DELETE FROM aliases WHERE entity_id = ?');
    const insertAlias = this.db.prepare(
      'INSERT OR IGNORE INTO aliases (entity_id, alias, raw_alias) VALUES (?, ?, ?)',
    );

    const deleteIds = this.db.prepare('DELETE FROM ids WHERE entity_id = ?');
    const insertId = this.db.prepare(
      'INSERT OR IGNORE INTO ids (entity_id, type, value, country) VALUES (?, ?, ?, ?)',
    );

    const softDelete = this.db.prepare(
      'UPDATE entities SET removed_at = ? WHERE id = ? AND removed_at IS NULL',
    );

    const insertChange = this.db.prepare(
      'INSERT INTO change_log (ts, entity_id, op, before_data, after_data) VALUES (?, ?, ?, ?, ?)',
    );

    const tx = this.db.transaction(() => {
      for (const e of entities) {
        const data = JSON.stringify(e);
        const previous = existingMap.get(e.id);
        const op = previous ? (JSON.stringify(previous) === data ? null : 'modify') : 'add';

        insertEntity.run({
          id: e.id,
          source: e.source,
          source_list_id: e.source_list_id,
          type: e.type,
          primary_name: e.primary_name,
          primary_name_norm: normalizeName(e.primary_name),
          data,
          listed_on: e.listed_on ?? null,
          now,
        });

        deleteAliases.run(e.id);
        const aliasSet = new Set<string>([e.primary_name, ...(e.aliases ?? [])]);
        for (const raw of aliasSet) {
          const norm = normalizeName(raw);
          if (norm) insertAlias.run(e.id, norm, raw);
        }

        deleteIds.run(e.id);
        for (const id of e.ids ?? []) {
          insertId.run(e.id, id.type, id.value, id.country ?? null);
        }

        if (op === 'add') {
          added++;
          insertChange.run(now, e.id, 'add', null, data);
        } else if (op === 'modify') {
          modified++;
          insertChange.run(now, e.id, 'modify', JSON.stringify(previous), data);
        }
      }

      // Soft-delete entities that disappeared from the source
      for (const [id, prev] of existingMap.entries()) {
        if (!incomingIds.has(id)) {
          softDelete.run(now, id);
          insertChange.run(now, id, 'remove', JSON.stringify(prev), null);
          removed++;
        }
      }

      this.db.prepare(`
        INSERT INTO refresh_log (source, refreshed_at, source_count, ok, error)
        VALUES (?, ?, ?, 1, NULL)
        ON CONFLICT(source) DO UPDATE SET
          refreshed_at = excluded.refreshed_at,
          source_count = excluded.source_count,
          ok = 1,
          error = NULL
      `).run(source, now, entities.length);
    });

    tx();
    return { added, modified, removed };
  }

  recordRefreshFailure(source: SanctionSource, error: string): void {
    this.db.prepare(`
      INSERT INTO refresh_log (source, refreshed_at, source_count, ok, error)
      VALUES (?, ?, 0, 0, ?)
      ON CONFLICT(source) DO UPDATE SET
        refreshed_at = excluded.refreshed_at,
        ok = 0,
        error = excluded.error
    `).run(source, Date.now(), error);
  }

  getById(id: string): SanctionedEntity | null {
    const row = this.db
      .prepare<[string], { data: string }>('SELECT data FROM entities WHERE id = ? AND removed_at IS NULL')
      .get(id);
    return row ? (JSON.parse(row.data) as SanctionedEntity) : null;
  }

  /** Look up by external ID (passport, IČO, tax_id…). Exact match. */
  findByExternalId(type: string, value: string): SanctionedEntity[] {
    const rows = this.db
      .prepare<[string, string], { data: string }>(
        `SELECT e.data FROM ids i
         JOIN entities e ON e.id = i.entity_id
         WHERE i.type = ? AND i.value = ? AND e.removed_at IS NULL`,
      )
      .all(type, value);
    return rows.map((r) => JSON.parse(r.data) as SanctionedEntity);
  }

  /**
   * Candidates for fuzzy match: returns all entities whose any alias shares
   * at least one token prefix with the query. Cheap pre-filter; expensive
   * scoring happens in search.ts.
   */
  candidatesByTokens(tokens: string[], typeFilter?: 'person' | 'entity'): SanctionedEntity[] {
    if (tokens.length === 0) return [];
    const conditions = tokens.map(() => 'alias LIKE ?').join(' OR ');
    const params = tokens.map((t) => `%${t}%`);

    let sql = `
      SELECT DISTINCT e.data
      FROM aliases a
      JOIN entities e ON e.id = a.entity_id
      WHERE (${conditions}) AND e.removed_at IS NULL
    `;
    if (typeFilter) {
      sql += ` AND e.type = ?`;
      params.push(typeFilter);
    }
    sql += ` LIMIT 500`;

    const rows = this.db.prepare(sql).all(...params) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as SanctionedEntity);
  }

  /**
   * Recent change log for `list_recent_updates`. Reconstructs add/modify/remove buckets.
   */
  changesSince(sinceMs: number, source?: SanctionSource): {
    added: SanctionedEntity[];
    removed: SanctionedEntity[];
    modified: Array<{ before: SanctionedEntity; after: SanctionedEntity }>;
  } {
    type Row = { entity_id: string; op: string; before_data: string | null; after_data: string | null; source: string };
    const rows = this.db.prepare(`
      SELECT cl.entity_id, cl.op, cl.before_data, cl.after_data, e.source
      FROM change_log cl
      LEFT JOIN entities e ON e.id = cl.entity_id
      WHERE cl.ts >= ?
      ORDER BY cl.ts ASC
    `).all(sinceMs) as Row[];

    const filtered = source ? rows.filter((r) => r.source === source) : rows;

    const added: SanctionedEntity[] = [];
    const removed: SanctionedEntity[] = [];
    const modified: Array<{ before: SanctionedEntity; after: SanctionedEntity }> = [];

    // Collapse multiple events per entity to final state in window
    const lastOpById = new Map<string, Row>();
    for (const row of filtered) lastOpById.set(row.entity_id, row);

    for (const row of lastOpById.values()) {
      if (row.op === 'add' && row.after_data) {
        added.push(JSON.parse(row.after_data) as SanctionedEntity);
      } else if (row.op === 'remove' && row.before_data) {
        removed.push(JSON.parse(row.before_data) as SanctionedEntity);
      } else if (row.op === 'modify' && row.before_data && row.after_data) {
        modified.push({
          before: JSON.parse(row.before_data) as SanctionedEntity,
          after: JSON.parse(row.after_data) as SanctionedEntity,
        });
      }
    }
    return { added, removed, modified };
  }

  stats(): DbStats {
    const totalActive = (this.db.prepare('SELECT COUNT(*) AS c FROM entities WHERE removed_at IS NULL').get() as { c: number }).c;
    const totalRemoved = (this.db.prepare('SELECT COUNT(*) AS c FROM entities WHERE removed_at IS NOT NULL').get() as { c: number }).c;
    const bySource = this.db.prepare<[], { source: string; c: number }>(
      'SELECT source, COUNT(*) AS c FROM entities WHERE removed_at IS NULL GROUP BY source',
    ).all();
    const refresh = this.db.prepare<[], { source: string; refreshed_at: number; source_count: number; ok: number; error: string | null }>(
      'SELECT source, refreshed_at, source_count, ok, error FROM refresh_log',
    ).all();
    return {
      total_active: totalActive,
      total_removed: totalRemoved,
      by_source: Object.fromEntries(bySource.map((r) => [r.source, r.c])),
      refresh_log: refresh.map((r) => ({
        source: r.source,
        refreshed_at: new Date(r.refreshed_at).toISOString(),
        source_count: r.source_count,
        ok: r.ok === 1,
        error: r.error,
      })),
    };
  }
}
