import naceData from './codebooks/nace.json' with { type: 'json' };

const NACE_DIVISIONS: Record<string, string> = naceData;

/**
 * Resolves a CZ-NACE code (2–6 digits) to a Czech human-readable description
 * of the division (first 2 digits). Returns undefined for unknown codes.
 *
 * Examples:
 *   resolveNace('62')      → 'programování, poradenství a činnosti v oblasti IT'
 *   resolveNace('62010')   → 'programování, poradenství a činnosti v oblasti IT'
 *   resolveNace('99999')   → undefined
 */
export function resolveNace(code?: string): string | undefined {
  if (code == null) return undefined;
  const clean = code.trim();
  if (!clean || !/^\d{2,6}$/.test(clean)) return undefined;
  const division = clean.slice(0, 2);
  return NACE_DIVISIONS[division];
}
