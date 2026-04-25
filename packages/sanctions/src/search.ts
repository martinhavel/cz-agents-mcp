/**
 * Fuzzy match against the sanctions DB.
 *
 * Scoring strategy (0-100):
 *   - Exact ID match (passport, IČO, tax_id) → 100, matched_on='id'
 *   - Token-set Jaccard with edit-distance fallback for misspellings
 *   - Best score across primary_name + aliases
 *   - Optional DOB / nationality filters reduce false positives
 *
 * Designed for batches < 1000 candidates (DB pre-filter does the heavy lifting).
 */
import { SanctionsDb } from './db.js';
import { normalizeName, tokenSet } from './normalize.js';
import type { MatchResult, SanctionedEntity } from './types.js';

export interface SearchOptions {
  threshold?: number;   // 0-100, default 80
  limit?: number;       // default 20
  typeFilter?: 'person' | 'entity';
}

export class SanctionsSearch {
  constructor(private readonly db: SanctionsDb) {}

  searchByName(
    rawName: string,
    opts: SearchOptions & { dob?: string; nationality?: string } = {},
  ): MatchResult[] {
    const threshold = opts.threshold ?? 80;
    const limit = opts.limit ?? 20;
    const queryTokens = tokenSet(rawName);
    if (queryTokens.length === 0) return [];

    const candidates = this.db.candidatesByTokens(queryTokens, opts.typeFilter);
    const results: MatchResult[] = [];

    for (const ent of candidates) {
      const score = scoreEntity(rawName, ent);
      if (!score) continue;
      if (score.confidence < threshold) continue;
      if (opts.dob && !dobMatches(ent, opts.dob)) continue;
      if (opts.nationality && !nationalityMatches(ent, opts.nationality)) continue;
      results.push({ entity: ent, ...score });
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return results.slice(0, limit);
  }

  /** Look up a CZ company by IČO. Tries exact-id table then name search via ARES (caller-supplied name). */
  searchByIco(ico: string, fallbackName?: string): MatchResult[] {
    const direct = this.db.findByExternalId('ico', ico);
    if (direct.length > 0) {
      return direct.map((entity) => ({
        entity,
        confidence: 100,
        matched_on: 'ico' as const,
      }));
    }
    if (!fallbackName) return [];
    return this.searchByName(fallbackName, { typeFilter: 'entity', threshold: 85 });
  }

  /** Look up a person by passport / national ID etc. */
  searchByDocument(type: string, value: string): MatchResult[] {
    const direct = this.db.findByExternalId(type, value);
    return direct.map((entity) => ({
      entity,
      confidence: 100,
      matched_on: 'id' as const,
    }));
  }
}

function scoreEntity(query: string, entity: SanctionedEntity): { confidence: number; matched_on: 'primary_name' | 'alias'; matched_alias?: string } | null {
  const primaryScore = nameSimilarity(query, entity.primary_name);
  let best: { confidence: number; matched_on: 'primary_name' | 'alias'; matched_alias?: string } = {
    confidence: primaryScore,
    matched_on: 'primary_name',
  };

  for (const alias of entity.aliases ?? []) {
    const s = nameSimilarity(query, alias);
    if (s > best.confidence) {
      best = { confidence: s, matched_on: 'alias', matched_alias: alias };
    }
  }
  return best.confidence > 0 ? best : null;
}

/**
 * Token-set ratio (industry standard for fuzzy name matching, e.g. FuzzyWuzzy).
 *
 * Splits both names into token sets, isolates the intersection, then takes
 * max(intersection vs full-a, intersection vs full-b, full-a vs full-b).
 * Effect:
 *  - "Bank" vs "Bank Rossiya" → 100 (subset of tokens matches fully)
 *  - "John Smyth" vs "John Smith" → ~90 (typo tolerated)
 *  - "Smith, John" vs "John Smith" → 100 (token order ignored)
 *  - "Jane Doe" vs "Vladimir Putin" → low (no overlap)
 *
 * Sanctions screening intentionally favors recall (false positives reviewed,
 * false negatives missed = compliance breach).
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const setA = new Set(ta);
  const setB = new Set(tb);
  const intersection = ta.filter((t) => setB.has(t)).sort();
  const aOnly = ta.filter((t) => !setB.has(t)).sort();
  const bOnly = tb.filter((t) => !setA.has(t)).sort();

  const t0 = intersection.join(' ');
  const ab = [...intersection, ...aOnly].join(' ');
  const bb = [...intersection, ...bOnly].join(' ');

  const s1 = stringRatio(t0, ab);
  const s2 = stringRatio(t0, bb);
  const s3 = stringRatio(ab, bb);

  return Math.round(Math.max(s1, s2, s3) * 100);
}

function stringRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  let prev: number[] = new Array(n + 1).fill(0).map((_, i) => i);
  let curr: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] as number;
}

function dobMatches(entity: SanctionedEntity, queryDob: string): boolean {
  const dobs = entity.dobs ?? [];
  if (dobs.length === 0) return true; // no info → don't exclude
  const queryYear = queryDob.slice(0, 4);
  for (const d of dobs) {
    if (d === queryDob) return true;
    if (d.startsWith(queryYear) || queryDob.startsWith(d)) return true;
  }
  return false;
}

function nationalityMatches(entity: SanctionedEntity, queryNat: string): boolean {
  const nats = entity.nationalities ?? [];
  if (nats.length === 0) return true;
  const q = normalizeName(queryNat);
  return nats.some((n) => normalizeName(n).includes(q));
}
