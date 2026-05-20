/**
 * "Bílý kůň" — nominee-director detector. Basic (public) variant.
 *
 * Three surface-level indicators computable from a single ARES report,
 * no cross-DB enrichment required. Rich variant (8 indicators + scoring
 * breakdown) is available in @czagents/ddplus (paid Compliance tier).
 *
 * Indicators:
 *   1. AGE_OUTLIER          — director age <25 or >70 (from ARES DOB)
 *   2. MULTI_BOARD          — director member of many companies (proxy via
 *                             prior-bankrupt-company count; full active-firm
 *                             count requires ARES OpenData dump, roadmap)
 *   3. RECENT_APPOINTMENT   — director added within last 30 days
 *
 * Sources:
 *   All three derive from DdReport (ARES VR + score flags), no async I/O.
 */

import type { DdReport, StatutoryMember } from '../types.js';

export type IndicatorCode =
  | 'AGE_OUTLIER'
  | 'MULTI_BOARD'
  | 'RECENT_APPOINTMENT';

export const INDICATOR_LABELS: Record<IndicatorCode, string> = {
  AGE_OUTLIER: 'Věk jednatele mimo běžný rozsah (<25 nebo >70 let)',
  MULTI_BOARD: 'Statutář s opakovanou účastí ve zkrachovalých firmách',
  RECENT_APPOINTMENT: 'Statutář přidán nedávno (<30 dní)',
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
  /** Whether the data needed to compute this indicator was available. */
  available: boolean;
}

export interface NomineeReport {
  /** Total indicators checked. */
  total: number;
  /** Count of indicators that fired (only where data was available). */
  fired: number;
  /** Weighted risk score 0-100. */
  riskScore: number;
  indicators: NomineeIndicator[];
  /** Indicator codes where upstream data was unavailable (returns available=false). */
  unavailable: IndicatorCode[];
  /** Actionable recommendations (populated by rich variant). */
  recommendations?: string[];
}

const TOTAL = 3;

/** Weight per indicator for the 0-100 riskScore. Must sum to 100. */
const WEIGHTS: Record<IndicatorCode, number> = {
  AGE_OUTLIER: 30,
  MULTI_BOARD: 40,
  RECENT_APPOINTMENT: 30,
};

export function detectNomineeDirector(r: DdReport): NomineeReport {
  const indicators: NomineeIndicator[] = [
    detectAgeOutlier(r.statutory_body),
    detectMultiBoard(r.statutory_body),
    detectRecentAppointment(r),
  ];

  const fired = indicators.filter((i) => i.fired).length;
  const unavailable = indicators
    .filter((i) => !i.available)
    .map((i) => i.code);

  const riskScore = indicators
    .filter((i) => i.available && i.fired)
    .reduce((sum, i) => sum + WEIGHTS[i.code], 0);

  return {
    total: TOTAL,
    fired,
    riskScore: Math.min(100, riskScore),
    indicators,
    unavailable,
  };
}

// ── Indicator implementations ─────────────────────────────────────────────────

function detectAgeOutlier(members: StatutoryMember[]): NomineeIndicator {
  const persons = members.filter((m) => m.is_person);
  if (persons.length === 0) {
    return {
      code: 'AGE_OUTLIER',
      fired: false,
      label: INDICATOR_LABELS.AGE_OUTLIER,
      detail: 'Žádné fyzické osoby ve statutárním orgánu.',
      available: false,
    };
  }

  const today = new Date();
  const hits: string[] = [];

  for (const p of persons) {
    const dob = p.datumNarozeni;
    if (!dob) continue;
    const dobDate = new Date(dob);
    if (Number.isNaN(dobDate.getTime())) continue;
    const age = Math.floor(
      (today.getTime() - dobDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
    );
    if (age < 25 || age > 70) {
      hits.push(p.name);
    }
  }

  // If no DOB data present at all — mark unavailable
  const hasDobData = persons.some((p) => p.datumNarozeni);
  if (!hasDobData) {
    return {
      code: 'AGE_OUTLIER',
      fired: false,
      label: INDICATOR_LABELS.AGE_OUTLIER,
      detail:
        'Datum narození statutářů není dostupné v ARES VR (není veřejně exponováno).',
      available: false,
    };
  }

  if (hits.length === 0) {
    return {
      code: 'AGE_OUTLIER',
      fired: false,
      label: INDICATOR_LABELS.AGE_OUTLIER,
      available: true,
    };
  }
  return {
    code: 'AGE_OUTLIER',
    fired: true,
    label: INDICATOR_LABELS.AGE_OUTLIER,
    members: hits,
    detail: `${hits.length === 1 ? 'Jednatel' : 'Jednatelé'} mimo běžný věkový rozsah (25–70 let): ${hits.join(', ')}.`,
    available: true,
  };
}

function detectMultiBoard(members: StatutoryMember[]): NomineeIndicator {
  const persons = members.filter((m) => m.is_person);
  // Proxy: prior_bankrupt_companies count ≥ 3 indicates serial-bankruptcy
  // pattern. Full active-firm count (≥20 threshold) requires ARES OpenData
  // offline dump — too expensive at report-render time, deferred to roadmap.
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
    detail:
      `${heavyMembers.length} statutář${heavyMembers.length === 1 ? '' : heavyMembers.length < 5 ? 'i' : 'ů'} má 3+ známých ` +
      'konkurzních firem v historii. Aktivní počet firem nelze ověřit bez ARES OpenData — toto je dolní mez.',
    available: true,
  };
}

function detectRecentAppointment(r: DdReport): NomineeIndicator {
  const matching = r.red_flags.filter((f) => f.code === 'RECENT_STATUTORY_CHANGE');
  const fired = matching.length > 0;
  return {
    code: 'RECENT_APPOINTMENT',
    fired,
    label: INDICATOR_LABELS.RECENT_APPOINTMENT,
    detail: fired
      ? 'Změna ve statutárním orgánu během posledních 30 dní.'
      : undefined,
    available: true,
  };
}
