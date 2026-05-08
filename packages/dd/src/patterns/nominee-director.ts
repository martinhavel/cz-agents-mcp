/**
 * "Bílý kůň" — nominee-director detector. Sprint-2 priority 1.
 *
 * Eight independent indicators each contribute to a 0–8 score. Compliance
 * users want to see *which* signals fired, not just an opaque score —
 * every indicator carries a description and a per-statutář subset where
 * applicable.
 *
 * Sources:
 *   1. STATUTORY_REGISTERED_AT_GOVT_OFFICE  → bydliště na úřadě (existing)
 *   2. count(active companies for this person) ≥ 20  → multi-board
 *   3. STATUTORY_PERSONAL_INSOLVENCY        → osobní bankrot
 *   4. STATUTORY_PRIOR_BANKRUPT_COMPANY     → dříve v insolvenční firmě
 *   5. RECENT_STATUTORY_CHANGE              → nedávno přidán (<30 dní)
 *   6. age estimate via DOB <25 + revenue 50M+  → mladý + vysoký obrat
 *      (revenue requires Sbírka listin → DEFERRED, returns 0 here)
 *   7. shared address with another flagged company  → DEFERRED
 *      (requires cross-IČO query against ARES)
 *   8. company HQ === statutory's residence  → match in current report
 *
 * Indicators 6 & 7 require data we don't have today (Sbírka listin /
 * cross-IČO scan). They are wired into the type so Sprint-3 can fill
 * them in without a structural change.
 */

import type { DdReport, RedFlag, StatutoryMember } from '../types.js';

export type IndicatorCode =
  | 'GOVT_RESIDENCE'
  | 'MULTI_BOARD'
  | 'PERSONAL_INSOLVENCY'
  | 'PRIOR_BANKRUPT_COMPANY'
  | 'RECENT_APPOINTMENT'
  | 'SHARED_FLAGGED_ADDRESS'
  | 'HQ_EQUALS_RESIDENCE';

export const INDICATOR_LABELS: Record<IndicatorCode, string> = {
  GOVT_RESIDENCE: 'Bydliště statutáře evidované na úřadě',
  MULTI_BOARD: 'Statutář s opakovanou účastí ve zkrachovalých firmách',
  PERSONAL_INSOLVENCY: 'Osobní bankrot statutáře',
  PRIOR_BANKRUPT_COMPANY: 'Statutář byl ve firmě s aktivní insolvencí',
  RECENT_APPOINTMENT: 'Statutář přidán nedávno (<30 dní)',
  SHARED_FLAGGED_ADDRESS: 'Sdílená adresa s další podezřelou firmou',
  HQ_EQUALS_RESIDENCE: 'Sídlo firmy = bydliště statutáře',
};

export interface NomineeIndicator {
  code: IndicatorCode;
  fired: boolean;
  /** Czech short description, ready to display. */
  label: string;
  /** Names of the statutory persons this indicator hits, when applicable. */
  members?: string[];
  /** Free-form detail for tooltip / drilldown. */
  detail?: string;
  /** Whether the data needed to compute this indicator is available. */
  available: boolean;
}

export interface NomineeReport {
  total: number; // 8
  fired: number; // 0–8 (only counts indicators where data was available)
  indicators: NomineeIndicator[];
  /** Indicators we couldn't compute (no upstream data yet). */
  unavailable: IndicatorCode[];
}

// TOTAL = 7 visible indicators. The originally-planned 8th
// (YOUNG_HIGH_REVENUE) is dropped — both required datasets are
// legally blocked, not just temporarily unavailable.
const TOTAL = 7;

export function detectNomineeDirector(r: DdReport): NomineeReport {
  const flags = r.red_flags;
  const members = r.statutory_body;

  const indicators: NomineeIndicator[] = [
    // 1 — bydliště na úřadě (data ready in score.ts via STATUTORY_REGISTERED_AT_GOVT_OFFICE)
    fromFlag(
      'GOVT_RESIDENCE',
      flags,
      'STATUTORY_REGISTERED_AT_GOVT_OFFICE',
      members,
    ),
    // 2 — multi-board (renamed): pattern of repeated bankruptcy. Full
    // count of active firms per statutary requires ARES OpenData (offline
    // dump) — too expensive at report-render time. We use the
    // prior_bankrupt_companies list as the working signal: if a single
    // statutary has 3+ historical entries, that's already a serial-
    // bankrupt pattern.
    detectMultiBoard(members),
    // 3 — personal insolvency (data ready)
    fromFlag('PERSONAL_INSOLVENCY', flags, 'STATUTORY_PERSONAL_INSOLVENCY', members),
    // 4 — prior bankrupt company (data ready)
    fromFlag(
      'PRIOR_BANKRUPT_COMPANY',
      flags,
      'STATUTORY_PRIOR_BANKRUPT_COMPANY',
      members,
    ),
    // 5 — recent appointment of a member (data ready)
    fromFlag(
      'RECENT_APPOINTMENT',
      flags,
      'RECENT_STATUTORY_CHANGE',
      members,
      'Změna ve statutárním orgánu během posledních 30 dní.',
    ),
    // (Dropped: YOUNG_HIGH_REVENUE — DOB not public in ARES VR + Sbírka
    // listin scraping legally blocked. Total reduced from 8 → 7.)
    // 7 — shared address with another flagged company. We can detect
    // the SAME thing partially using existing flags: if VIRTUAL_ADDRESS
    // fires (sídlo sdílené s 50+ firmami) AND HQ_EQUALS_RESIDENCE fires
    // (statutary lives at company HQ), then the statutary's residence
    // is at a known suspicious-density address. Not the full theory
    // ("with another flagged company") but the practical equivalent.
    detectSharedFlaggedAddress(r),
    // 8 — HQ === residence (computable now from report payload)
    detectHqEqualsResidence(r),
  ];

  const fired = indicators.filter((i) => i.fired).length;
  const unavailable = indicators
    .filter((i) => !i.available)
    .map((i) => i.code);

  return {
    total: TOTAL,
    fired,
    indicators,
    unavailable,
  };
}

function fromFlag(
  code: IndicatorCode,
  flags: RedFlag[],
  flagCode: string,
  members: StatutoryMember[],
  detail?: string,
): NomineeIndicator {
  const matching = flags.filter((f) => f.code === flagCode);
  const fired = matching.length > 0;
  const memberNames = fired
    ? Array.from(
        new Set(
          matching
            .map((f) => {
              const ev = f.evidence as { name?: string } | undefined;
              return ev?.name;
            })
            .filter((n): n is string => typeof n === 'string'),
        ),
      )
    : undefined;
  void members;
  return {
    code,
    fired,
    label: INDICATOR_LABELS[code],
    members: memberNames,
    detail: detail ?? matching[0]?.description,
    available: true,
  };
}

function detectHqEqualsResidence(r: DdReport): NomineeIndicator {
  // Simple check: any FO-statutář whose `address` (when surfaced via VR)
  // equals the company's sídlo. We don't always have the residence on
  // the StatutoryMember in the typed payload — so this indicator is
  // soft-marked unavailable when we can't determine.
  const sidlo = (r.company.address ?? '').toLowerCase().trim();
  if (!sidlo) {
    return {
      code: 'HQ_EQUALS_RESIDENCE',
      fired: false,
      label: INDICATOR_LABELS.HQ_EQUALS_RESIDENCE,
      detail: 'Sídlo firmy v reportu neuvedeno.',
      available: false,
    };
  }
  const persons = r.statutory_body.filter((s) => s.is_person);
  const hits: string[] = [];
  for (const p of persons) {
    const evidence = p as unknown as { address?: { textovaAdresa?: string } };
    const addr = evidence.address?.textovaAdresa?.toLowerCase().trim();
    if (addr && addressMatch(sidlo, addr)) {
      hits.push(p.name);
    }
  }
  if (hits.length === 0) {
    return {
      code: 'HQ_EQUALS_RESIDENCE',
      fired: false,
      label: INDICATOR_LABELS.HQ_EQUALS_RESIDENCE,
      available: true,
    };
  }
  return {
    code: 'HQ_EQUALS_RESIDENCE',
    fired: true,
    label: INDICATOR_LABELS.HQ_EQUALS_RESIDENCE,
    members: hits,
    detail:
      'Statutární osoba má bydliště na stejné adrese jako sídlo firmy. ' +
      'Není to vždy red flag (rodinný podnik), ale kombinace s dalšími indikátory zvyšuje váhu.',
    available: true,
  };
}

function detectMultiBoard(members: StatutoryMember[]): NomineeIndicator {
  const persons = members.filter((m) => m.is_person);
  // Lower-bound count = entries we have evidence for (prior bankrupt firms
  // is the most reliable proxy because score.ts already verified statutary
  // role). Threshold of 3 = pattern even without active-firm count.
  const heavyMembers = persons.filter(
    (m) => (m.prior_bankrupt_companies?.length ?? 0) >= 3,
  );
  if (heavyMembers.length === 0) {
    return {
      code: 'MULTI_BOARD',
      fired: false,
      label: INDICATOR_LABELS.MULTI_BOARD,
      detail:
        'Žádný ze statutářů nemá 3+ známých konkurzních firem. Plný počet aktivních firem (≥20) vyžaduje ARES OpenData dump (roadmap).',
      available: true,
    };
  }
  return {
    code: 'MULTI_BOARD',
    fired: true,
    label: INDICATOR_LABELS.MULTI_BOARD,
    members: heavyMembers.map((m) => m.name),
    detail: `${heavyMembers.length} statutář${heavyMembers.length === 1 ? '' : heavyMembers.length < 5 ? 'i' : 'ů'} má 3+ známých konkurzních firem v historii. Aktivní počet firem nelze ověřit bez ARES OpenData — toto je dolní mez.`,
    available: true,
  };
}

function detectSharedFlaggedAddress(r: DdReport): NomineeIndicator {
  const isVirtualAddress = r.red_flags.some((f) => f.code === 'VIRTUAL_ADDRESS');
  // Did HQ === residence fire? Reuse the same logic.
  const hqRes = detectHqEqualsResidence(r);
  if (!isVirtualAddress) {
    return {
      code: 'SHARED_FLAGGED_ADDRESS',
      fired: false,
      label: INDICATOR_LABELS.SHARED_FLAGGED_ADDRESS,
      detail:
        'Sídlo firmy není evidováno jako sdílená (virtuální) adresa. Detail v Profilu firmy.',
      available: true,
    };
  }
  if (!hqRes.fired) {
    return {
      code: 'SHARED_FLAGGED_ADDRESS',
      fired: false,
      label: INDICATOR_LABELS.SHARED_FLAGGED_ADDRESS,
      detail:
        'Sídlo firmy je virtuální (sdílené 50+ firmami), ale žádný statutář tam nebydlí.',
      available: true,
    };
  }
  return {
    code: 'SHARED_FLAGGED_ADDRESS',
    fired: true,
    label: INDICATOR_LABELS.SHARED_FLAGGED_ADDRESS,
    members: hqRes.members,
    detail:
      'Sídlo firmy je sdílené 50+ firmami (virtuální adresa) A statutární osoba má bydliště na téže adrese. Klasický pattern shell company.',
    available: true,
  };
}

function addressMatch(a: string, b: string): boolean {
  // Loose street + city match — strip whitespace, punctuation, lowercase.
  const norm = (s: string) =>
    s.replace(/[,\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}
