import { resolveLegalForm, resolveNace } from '@czagents/shared';
import type { AresSubject } from './client.js';

/**
 * Formats an ISO date string (YYYY-MM-DD) to Czech format D. M. RRRR.
 * Leading zeros are stripped from day and month.
 */
function formatDateCs(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  return `${parseInt(day!, 10)}. ${parseInt(month!, 10)}. ${year}`;
}

/**
 * Calculates full years between a date and today.
 */
function ageInYears(isoDate: string): number | undefined {
  const started = Date.parse(isoDate);
  if (Number.isNaN(started)) return undefined;
  return Math.floor((Date.now() - started) / (365.25 * 24 * 60 * 60 * 1000));
}

/**
 * Builds a neutral managerial summary block for an ARES subject.
 *
 * Intentionally contains NO risk verdict, NO ✅ — ARES holds only legal/registry
 * data; a green verdict would mislead about checks that have not been performed.
 * CTA hint is appended separately by the server handler.
 */
export function buildAresSummaryMarkdown(subject: AresSubject): string {
  const name = subject.obchodniJmeno ?? '(název neueden)';
  const ico = subject.ico;

  // Legal form
  const legalForm = resolveLegalForm(subject.pravniForma) ?? 'forma neuvedena';

  // City from address
  const mesto = subject.sidlo?.nazevObce ?? 'sídlo neuvedeno';

  // Founding date + age
  let vznikLine = '';
  if (subject.datumVzniku) {
    const age = ageInYears(subject.datumVzniku);
    vznikLine = `Vznik ${formatDateCs(subject.datumVzniku)}${age != null ? ` (${age} let)` : ''}`;
  } else {
    vznikLine = 'vznik neuveden';
  }

  // VAT status
  const dicDisplay = subject.dic
    ? `plátce DPH (${subject.dic})`
    : 'neplátce DPH';

  // Active / dissolved
  let stavLine: string;
  if (subject.datumZaniku) {
    stavLine = `zaniklá k ${formatDateCs(subject.datumZaniku)}`;
  } else {
    stavLine = 'aktivní';
  }

  // NACE — first code from czNace array, if available
  let naceLine: string | undefined;
  const firstNace = subject.czNace?.[0];
  if (firstNace) {
    const naceLabel = resolveNace(firstNace);
    if (naceLabel) {
      naceLine = `Obor: ${naceLabel} (${firstNace.slice(0, 2)})`;
    }
  }

  const lines: string[] = [
    `**${name}** · IČO ${ico} — ${legalForm}, ${mesto}.`,
    `${vznikLine} · ${dicDisplay} · ${stavLine}.`,
  ];
  if (naceLine) {
    lines.push(naceLine);
  }
  lines.push('*Veřejné registry · cz-agents.dev*');
  lines.push('*Rizikový profil (insolvence, sankce, skóre 0–100) zdarma: get_dd_report — dd.cz-agents.dev/mcp.*');

  return lines.join('\n');
}
