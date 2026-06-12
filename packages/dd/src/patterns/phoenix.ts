/**
 * Phoenix company detector — basic (public) variant.
 *
 * Detects the "phoenix company" pattern: a new firm set up by the same
 * people who buried a prior company in insolvency, in the same line of
 * business. Three surface-level indicators computable from a single
 * DdReport payload; no cross-DB enrichment required.
 *
 * Indicators:
 *   1. SURNAME_MATCH        — current statutory member has prior_bankrupt_companies
 *                             (= was at a firm that went into insolvency)
 *   2. FOUNDING_PROXIMITY   — current firm was founded within 12 months of a
 *                             related insolvency start date (ISIR)
 *   3. NACE_MATCH           — current firm has NACE codes (informational; cross-ARES
 *                             comparison with prior firm's NACE in rich variant)
 *
 * Sources: DdReport (ARES VR + ISIR), no async I/O.
 * Rich variant (4 additional indicators + deeper scoring) is available
 * in @czagents/ddplus (Compliance tier).
 */

import type { DdReport, StatutoryMember } from '../types.js';

export type PhoenixIndicatorCode =
  | 'SURNAME_MATCH'
  | 'FOUNDING_PROXIMITY'
  | 'NACE_MATCH';

export const INDICATOR_LABELS: Record<PhoenixIndicatorCode, string> = {
  SURNAME_MATCH: 'Jednatel byl dříve v insolvenční firmě (příjmení v ARES/ISIR záznamu)',
  FOUNDING_PROXIMITY: 'Vznik firmy do 12 měsíců od zahájení insolvence příbuzné firmy',
  NACE_MATCH: 'Stejný hlavní obor (NACE) jako předchozí insolvenční firma',
};

export interface PhoenixIndicator {
  code: PhoenixIndicatorCode;
  fired: boolean;
  label: string;
  /** Names of statutory members implicated, when applicable. */
  members?: string[];
  /** Free-form detail for tooltip / drilldown. */
  detail?: string;
  /** Whether the data needed to compute this indicator was available. */
  available: boolean;
}

export interface PhoenixReport {
  /** Total indicators checked. */
  total: number;
  /** Count of indicators that fired (only where data was available). */
  fired: number;
  /** Weighted risk score 0–100. */
  riskScore: number;
  indicators: PhoenixIndicator[];
  /** Indicator codes where upstream data was unavailable. */
  unavailable: PhoenixIndicatorCode[];
  /** Actionable recommendations (populated by rich variant). */
  recommendations?: string[];
}

const TOTAL = 3;

/** Weight per indicator for the 0-100 riskScore. Must sum to 100. */
const WEIGHTS: Record<PhoenixIndicatorCode, number> = {
  SURNAME_MATCH: 40,
  FOUNDING_PROXIMITY: 35,
  NACE_MATCH: 25,
};

export function detectPhoenix(r: DdReport): PhoenixReport {
  const indicators: PhoenixIndicator[] = [
    detectSurnameMatch(r.statutory_body),
    detectFoundingProximity(r),
    detectNaceMatch(r),
  ];

  const fired = indicators.filter((i) => i.fired).length;
  const unavailable = indicators
    .filter((i) => !i.available)
    .map((i) => i.code);

  const riskScore = Math.min(
    100,
    indicators
      .filter((i) => i.available && i.fired)
      .reduce((sum, i) => sum + WEIGHTS[i.code], 0),
  );

  return {
    total: TOTAL,
    fired,
    riskScore,
    indicators,
    unavailable,
  };
}

// ── Indicator implementations ─────────────────────────────────────────────────

/**
 * SURNAME_MATCH — any current statutory member has prior_bankrupt_companies
 * in their record (= was a director at a company that entered insolvency,
 * and is now directing the current subject). This is the strongest basic
 * phoenix signal derivable from a single report.
 */
function detectSurnameMatch(members: StatutoryMember[]): PhoenixIndicator {
  const persons = members.filter((m) => m.is_person);
  if (persons.length === 0) {
    return {
      code: 'SURNAME_MATCH',
      fired: false,
      label: INDICATOR_LABELS.SURNAME_MATCH,
      detail: 'Žádné fyzické osoby ve statutárním orgánu.',
      available: false,
    };
  }

  const hits = persons.filter(
    (m) => (m.prior_bankrupt_companies?.length ?? 0) >= 1,
  );

  if (hits.length === 0) {
    return {
      code: 'SURNAME_MATCH',
      fired: false,
      label: INDICATOR_LABELS.SURNAME_MATCH,
      detail: 'Žádný ze statutářů nemá záznamy o předchozích insolvenčních firmách.',
      available: true,
    };
  }

  const priorIcos = hits.flatMap(
    (m) => m.prior_bankrupt_companies?.map((p) => p.ico) ?? [],
  );

  return {
    code: 'SURNAME_MATCH',
    fired: true,
    label: INDICATOR_LABELS.SURNAME_MATCH,
    members: hits.map((m) => m.name),
    detail:
      `${hits.length} statutář${hits.length === 1 ? '' : 'i'} byl${hits.length === 1 ? '' : 'i'} ` +
      `dříve jednateli v insolvenční firmě (IČO: ${priorIcos.join(', ')}).`,
    available: true,
  };
}

/**
 * FOUNDING_PROXIMITY — current firm was registered within 12 months of
 * an insolvency proceeding start date (ISIR). The 12-month window is the
 * canonical "suspicious timing" threshold from cz-agents webapp logic.
 */
function detectFoundingProximity(r: DdReport): PhoenixIndicator {
  const registeredOn = r.company.registered_on;
  if (!registeredOn) {
    return {
      code: 'FOUNDING_PROXIMITY',
      fired: false,
      label: INDICATOR_LABELS.FOUNDING_PROXIMITY,
      detail: 'Datum vzniku firmy není k dispozici.',
      available: false,
    };
  }

  const registeredDate = new Date(registeredOn);
  if (Number.isNaN(registeredDate.getTime())) {
    return {
      code: 'FOUNDING_PROXIMITY',
      fired: false,
      label: INDICATOR_LABELS.FOUNDING_PROXIMITY,
      detail: 'Datum vzniku firmy nelze parsovat.',
      available: false,
    };
  }

  // Check if active insolvency start is within 12 months of founding
  if (r.insolvency?.has_active_proceeding && r.insolvency.started_on) {
    const insolStart = new Date(r.insolvency.started_on);
    if (!Number.isNaN(insolStart.getTime())) {
      // monthsBetween(insolStart, registeredDate) = (registeredDate - insolStart) in
      // months. Positive ⇒ the firm was founded AFTER insolvency started; negative ⇒
      // BEFORE. (The previous labels had these two branches reversed.)
      const gapMonths = monthsBetween(insolStart, registeredDate);
      if (Math.abs(gapMonths) < 12) {
        const direction = gapMonths >= 0
          ? `${gapMonths.toFixed(1)} měs. po zahájení insolvence`
          : `${Math.abs(gapMonths).toFixed(1)} měs. před zahájením insolvence`;
        return {
          code: 'FOUNDING_PROXIMITY',
          fired: true,
          label: INDICATOR_LABELS.FOUNDING_PROXIMITY,
          detail:
            `Firma vznikla ${direction} (${r.insolvency.started_on}). ` +
            'Gap < 12 měsíců — typický phoenix pattern.',
          available: true,
        };
      }
    }
  }

  const hasPriors = r.statutory_body.some(
    (m) => (m.prior_bankrupt_companies?.length ?? 0) > 0,
  );
  if (!hasPriors) {
    return {
      code: 'FOUNDING_PROXIMITY',
      fired: false,
      label: INDICATOR_LABELS.FOUNDING_PROXIMITY,
      detail: 'Žádná aktivní insolvence ani předchozí krachy — časový test nelze provést.',
      available: true,
    };
  }

  return {
    code: 'FOUNDING_PROXIMITY',
    fired: false,
    label: INDICATOR_LABELS.FOUNDING_PROXIMITY,
    detail:
      'Záznamy o předchozích krachách existují, ale data o ISIR datumech nejsou ' +
      'dostupná pro výpočet gapu. Rich variant: cross-ARES ISIR lookup.',
    available: true,
  };
}

/**
 * NACE_MATCH — informational: flags whether the current company has NACE
 * codes at all when priors exist. Full NACE comparison of current vs. prior
 * firm requires cross-ARES lookup (available in rich variant @czagents/ddplus).
 */
function detectNaceMatch(r: DdReport): PhoenixIndicator {
  const currentNaces = r.company.nace_codes ?? [];
  const hasPriors = r.statutory_body.some(
    (m) => (m.prior_bankrupt_companies?.length ?? 0) > 0,
  );

  if (currentNaces.length === 0) {
    return {
      code: 'NACE_MATCH',
      fired: false,
      label: INDICATOR_LABELS.NACE_MATCH,
      detail: 'NACE kódy aktuální firmy nejsou k dispozici.',
      available: false,
    };
  }

  if (!hasPriors) {
    return {
      code: 'NACE_MATCH',
      fired: false,
      label: INDICATOR_LABELS.NACE_MATCH,
      detail: 'Žádné záznamy o předchozích insolvenčních firmách — NACE srovnání nelze provést.',
      available: true,
    };
  }

  // At basic level: signal informational. We know priors exist and this firm
  // has NACE codes, but we cannot compare without cross-ARES lookup.
  // Rich variant: cross-lookup of prior IČOs and compare primary 2-digit NACE.
  const primaryNace = String(currentNaces[0]).slice(0, 2);
  return {
    code: 'NACE_MATCH',
    fired: false,
    label: INDICATOR_LABELS.NACE_MATCH,
    detail:
      `Aktuální primární NACE sektor: ${primaryNace}. Záznamy o předchozích krachách existují, ` +
      'ale NACE předchozích firem vyžaduje cross-ARES dotaz (dostupné v @czagents/ddplus).',
    available: true,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthsBetween(earlier: Date, later: Date): number {
  const ms = later.getTime() - earlier.getTime();
  return ms / (1000 * 60 * 60 * 24 * 30.44);
}
