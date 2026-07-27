/**
 * Portfolio rescreen: continuous-monitoring gap between `list_recent_updates`
 * (global feed of sanctions changes) and `search_person` / `check_ico`
 * (screening a single subject).
 *
 * A compliance officer with a portfolio of clients needs: "which of MY
 * clients were touched by list changes since date X?" Scanning the whole
 * portfolio against the whole list on every check does not scale (a 5,000
 * client book vs. tens of thousands of active listings). Instead this pulls
 * the *change set* since `sinceMs` — small and bounded by `db.changesSince`
 * — and matches the caller-supplied subjects against only that set. Cost is
 * O(subjects × changes), not O(subjects × whole list).
 *
 * Read-only: only calls `SanctionsDb.changesSince` and the name-matching
 * primitive `nameSimilarity` from `search.ts`. Does not touch db.ts,
 * search.ts, server.ts or http.ts.
 */
import { SanctionsDb } from './db.js';
import { nameSimilarity } from './search.js';
import type { SanctionedEntity, SanctionSource } from './types.js';

/**
 * A client/portfolio subject to check against recent sanctions changes.
 * At least one of `name` / `ico` is required — otherwise there is nothing
 * to match against.
 */
export interface PortfolioSubject {
  /** Caller's own identifier for this subject (client ID, case number, ...).
   *  Echoed back on every hit so the caller can join results without a
   *  second lookup. */
  ref: string;
  name?: string;
  ico?: string;
}

export interface RescreenOptions {
  subjects: PortfolioSubject[];
  /** Epoch ms. Only changes with `change_log.ts >= sinceMs` are considered
   *  (same semantics as `SanctionsDb.changesSince`). */
  sinceMs: number;
  /** Restrict to a single list source. Omit to check across all sources. */
  source?: SanctionSource;
  /** Min fuzzy name-match confidence (0-100) to count as a hit. Default 80 —
   *  same default `SanctionsSearch.searchByName` uses (search.ts:29). Kept
   *  in sync deliberately: a rescreen hit should trigger at the same bar a
   *  manual `search_person` call would have caught it at, so results don't
   *  silently diverge from what an analyst would find by hand. */
  threshold?: number;
}

/**
 * Portfolio size cap. A rescreen call is synchronous, in-process work that
 * scores every subject's name against every changed entity's primary_name
 * plus all its aliases (see `scoreSubjectName`) — cost is
 * O(subjects × changes × aliases-per-entity). 500 comfortably covers a
 * single compliance officer's active client list pasted into one call;
 * beyond that, callers should page the portfolio across multiple calls
 * (e.g. by client segment) rather than risk one call blocking the MCP
 * connection for a long-running batch score.
 */
export const MAX_PORTFOLIO_SUBJECTS = 500;

/** Default fuzzy name-match threshold — mirrors search.ts's `searchByName` default. */
const DEFAULT_THRESHOLD = 80;

export class RescreenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RescreenValidationError';
  }
}

export type RescreenChangeType = 'added' | 'removed' | 'modified';

export interface RescreenFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** Sanctions entity data, minus the raw source payload (`raw`) — that field
 *  carries verbatim source XML/JSON kept for audit, not useful for an agent
 *  deciding what to do next; fetch it via `get_listing` if needed. */
export type RescreenEntitySnapshot = Omit<SanctionedEntity, 'raw'>;

export interface RescreenMatch {
  /** The `ref` of the affected PortfolioSubject, as supplied by the caller. */
  ref: string;
  change_type: RescreenChangeType;
  /** How the subject matched the entity: exact IČO hit, or fuzzy name. */
  matched_on: 'ico' | 'name';
  /** 0-100. 100 for the exact IČO match; fuzzy-name score otherwise. */
  confidence: number;
  /** Set when a specific alias (not the primary name) produced the best score. */
  matched_alias?: string;
  /** For `change_type: 'modified'`, whether the match came from the entity's
   *  state before or after the change — e.g. a subject can match the *old*
   *  name of an entity that was just renamed on the list, which is still a
   *  compliance-relevant hit even though the current primary_name no longer
   *  matches. Absent for 'added' (always 'after') / 'removed' (always 'before'). */
  matched_against?: 'before' | 'after';
  /** The listing as it stands after the change (or at removal, before it
   *  was taken off the list). */
  entity: RescreenEntitySnapshot;
  /** Only for `change_type: 'modified'`: which fields differ between the
   *  before/after listing snapshots. Empty array is possible in principle
   *  (a no-op write) but changesSince already collapses those out. */
  changed_fields?: RescreenFieldChange[];
}

export interface RescreenSummary {
  /** How many subjects were submitted. */
  subjects_screened: number;
  /** Total add+remove+modify events in the window (post `source` filter). */
  changes_in_window: number;
  /** Distinct subjects (by `ref`) that had at least one hit. */
  subjects_affected: number;
  /** ISO timestamp — start of the window (== input `sinceMs`). */
  since: string;
  /** ISO timestamp — when this rescreen ran. */
  until: string;
  source?: SanctionSource;
}

export interface RescreenResult {
  summary: RescreenSummary;
  /** Only the subjects touched by a change. Unaffected subjects are omitted
   *  entirely — silence for a subject means "no hit", not "not checked"
   *  (see `summary.subjects_screened` for what was checked). */
  matches: RescreenMatch[];
}

export interface RescreenDeps {
  db: SanctionsDb;
}

/**
 * Rescreen a portfolio of subjects against sanctions list changes since
 * `sinceMs`. See module doc for the "change-set, not whole-portfolio-scan"
 * design rationale.
 *
 * Throws `RescreenValidationError` on invalid input (never returns a silent
 * empty result for a malformed call).
 */
export function rescreenPortfolio(deps: RescreenDeps, options: RescreenOptions): RescreenResult {
  validateOptions(options);

  const { subjects, sinceMs, source } = options;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const now = Date.now();

  const changes = deps.db.changesSince(sinceMs, source);
  const changesInWindow = changes.added.length + changes.removed.length + changes.modified.length;

  const matches: RescreenMatch[] = [];

  for (const subject of subjects) {
    for (const entity of changes.added) {
      const hit = matchSubjectToEntity(subject, entity, threshold);
      if (hit) {
        matches.push({
          ref: subject.ref,
          change_type: 'added',
          entity: snapshot(entity),
          ...hit,
        });
      }
    }

    for (const entity of changes.removed) {
      const hit = matchSubjectToEntity(subject, entity, threshold);
      if (hit) {
        matches.push({
          ref: subject.ref,
          change_type: 'removed',
          entity: snapshot(entity),
          ...hit,
        });
      }
    }

    for (const { before, after } of changes.modified) {
      const hitAfter = matchSubjectToEntity(subject, after, threshold);
      const hit = hitAfter ?? matchSubjectToEntity(subject, before, threshold);
      if (hit) {
        matches.push({
          ref: subject.ref,
          change_type: 'modified',
          matched_against: hitAfter ? 'after' : 'before',
          entity: snapshot(after),
          changed_fields: diffEntities(before, after),
          ...hit,
        });
      }
    }
  }

  const subjectsAffected = new Set(matches.map((m) => m.ref)).size;

  return {
    summary: {
      subjects_screened: subjects.length,
      changes_in_window: changesInWindow,
      subjects_affected: subjectsAffected,
      since: new Date(sinceMs).toISOString(),
      until: new Date(now).toISOString(),
      source,
    },
    matches,
  };
}

/**
 * Match one subject against one changed entity. IČO is checked first (exact,
 * confidence 100) — mirrors `SanctionsSearch.searchByIco`'s preference for
 * direct ID hits over fuzzy name matching. Falls back to fuzzy name scoring
 * (best of primary_name + aliases, same primitive `search.ts` uses) only
 * when no IČO hit, so a subject with both fields set doesn't get scored
 * twice for the same entity.
 */
function matchSubjectToEntity(
  subject: PortfolioSubject,
  entity: SanctionedEntity,
  threshold: number,
): { matched_on: 'ico' | 'name'; confidence: number; matched_alias?: string } | null {
  if (subject.ico) {
    const icoHit = (entity.ids ?? []).some((id) => id.type === 'ico' && id.value === subject.ico);
    if (icoHit) return { matched_on: 'ico', confidence: 100 };
  }

  if (subject.name) {
    const scored = scoreSubjectName(subject.name, entity);
    if (scored && scored.confidence >= threshold) {
      return { matched_on: 'name', confidence: scored.confidence, matched_alias: scored.matched_alias };
    }
  }

  return null;
}

/** Best fuzzy-name score across primary_name + aliases — same shape as the
 *  private `scoreEntity` helper in search.ts, reusing its exported scoring
 *  primitive (`nameSimilarity`) rather than duplicating the matching logic. */
function scoreSubjectName(
  name: string,
  entity: SanctionedEntity,
): { confidence: number; matched_alias?: string } | null {
  let best: { confidence: number; matched_alias?: string } = {
    confidence: nameSimilarity(name, entity.primary_name),
  };
  for (const alias of entity.aliases ?? []) {
    const score = nameSimilarity(name, alias);
    if (score > best.confidence) {
      best = { confidence: score, matched_alias: alias };
    }
  }
  return best.confidence > 0 ? best : null;
}

function snapshot(entity: SanctionedEntity): RescreenEntitySnapshot {
  const { raw, ...rest } = entity;
  return rest;
}

/** Fields compared to build `changed_fields` for a modified listing. Value
 *  diff (JSON equality), not a semantic set-diff — e.g. an alias list that
 *  was merely reordered will show as changed. That's an intentional
 *  simplification: for a compliance read this is display-only detail on top
 *  of a hit that already fired, not something a caller branches on. */
const DIFF_FIELDS: Array<keyof SanctionedEntity> = [
  'type',
  'primary_name',
  'aliases',
  'programs',
  'listed_on',
  'dobs',
  'nationalities',
  'addresses',
  'ids',
];

function diffEntities(before: SanctionedEntity, after: SanctionedEntity): RescreenFieldChange[] {
  const changes: RescreenFieldChange[] = [];
  for (const field of DIFF_FIELDS) {
    const beforeValue = before[field];
    const afterValue = after[field];
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changes.push({ field, before: beforeValue ?? null, after: afterValue ?? null });
    }
  }
  return changes;
}

function validateOptions(options: RescreenOptions): void {
  const { subjects, sinceMs, threshold } = options;

  if (!Array.isArray(subjects)) {
    throw new RescreenValidationError('subjects must be an array of PortfolioSubject.');
  }
  if (subjects.length === 0) {
    throw new RescreenValidationError('subjects is empty — nothing to rescreen. Pass at least one subject.');
  }
  if (subjects.length > MAX_PORTFOLIO_SUBJECTS) {
    throw new RescreenValidationError(
      `subjects has ${subjects.length} entries, over the cap of ${MAX_PORTFOLIO_SUBJECTS}. ` +
        'Split the portfolio across multiple calls (see MAX_PORTFOLIO_SUBJECTS doc comment for why).',
    );
  }

  subjects.forEach((subject, index) => {
    if (!subject || typeof subject.ref !== 'string' || subject.ref.trim() === '') {
      throw new RescreenValidationError(`subjects[${index}] is missing a non-empty "ref".`);
    }
    const hasName = typeof subject.name === 'string' && subject.name.trim() !== '';
    const hasIco = typeof subject.ico === 'string' && subject.ico.trim() !== '';
    if (!hasName && !hasIco) {
      throw new RescreenValidationError(
        `subjects[${index}] (ref="${subject.ref}") has neither "name" nor "ico" — nothing to match against.`,
      );
    }
  });

  if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) {
    throw new RescreenValidationError('sinceMs must be a finite number (epoch milliseconds).');
  }
  if (sinceMs > Date.now()) {
    throw new RescreenValidationError(
      `sinceMs (${new Date(sinceMs).toISOString()}) is in the future — no changes can exist yet for that window.`,
    );
  }

  if (threshold !== undefined && (typeof threshold !== 'number' || threshold < 0 || threshold > 100)) {
    throw new RescreenValidationError('threshold must be a number between 0 and 100.');
  }
}
