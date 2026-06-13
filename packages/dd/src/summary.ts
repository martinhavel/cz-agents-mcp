import { resolveLegalForm } from '@czagents/shared';
import type { DdReport, RedFlag, RiskLevel } from './types.js';

export interface RiskScoreSummaryPayload {
  ico: string;
  company_name?: string;
  value: number;
  level: RiskLevel;
  top_flags: RedFlag[];
  retrieved_at?: string;
  unavailable_sources?: SourceAvailability[];
}

const RISK_LEVEL_CS: Record<RiskLevel, string> = {
  low: 'nízké',
  medium: 'střední',
  high: 'vysoké',
};

function zdrojeWord(n: number): string {
  if (n === 1) return 'zdroj';
  if (n >= 2 && n <= 4) return 'zdroje';
  return 'zdrojů';
}

function formatDateCs(isoDate: string): string {
  // Converts YYYY-MM-DD → D. M. YYYY (without leading zeros)
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  return `${parseInt(day!, 10)}. ${parseInt(month!, 10)}. ${year}`;
}

export function buildDdSummaryMarkdown(report: DdReport): string {
  const name = report.company.name ?? 'Nenalezeno';
  const unavailableSources = getUnavailableReferencedSources(report);
  const verdict = verdictFor(report.risk_score.level, unavailableSources);
  const levelCs = RISK_LEVEL_CS[report.risk_score.level];
  const lines = [
    `**${name}** · IČO ${report.ico} — ${verdict.icon} ${verdict.text}. Riziko ${report.risk_score.value}/100 (${levelCs}).`,
    buildStatusLine(report),
    buildBasicDataLine(report),
    buildSourcesLine(report),
    buildStatutoryLine(report),
    ...buildFlagLines(report.red_flags),
    `*Snapshot ${report.retrieved_at} · veřejné registry · cz-agents.dev*`,
    '*Trvalý auditní záznam s časovým razítkem a hash-chain (CDD Karta, doložitelné pro auditora): placená úroveň.*',
  ];
  return lines.filter(Boolean).slice(0, 15).join('\n');
}

export function buildRiskScoreSummaryMarkdown(payload: RiskScoreSummaryPayload): string {
  const verdict = verdictFor(payload.level, payload.unavailable_sources ?? []);
  const levelCs = RISK_LEVEL_CS[payload.level];
  const lines = [
    `**${payload.company_name ?? 'Nenalezeno'}** · IČO ${payload.ico} — ${verdict.icon} ${verdict.text}. Riziko ${payload.value}/100 (${levelCs}).`,
    ...buildFlagLines(payload.top_flags),
    `*Snapshot ${payload.retrieved_at ?? 'neuveden'} · cz-agents.dev*`,
  ];
  return lines.filter(Boolean).join('\n');
}

function verdictFor(level: RiskLevel, unavailableSources: SourceAvailability[] = []): { icon: string; text: string } {
  if (level === 'high') return { icon: '🔴', text: 'RIZIKO' };
  if (level === 'medium') return { icon: '⚠', text: 'POZOR' };
  if (unavailableSources.length > 0) return { icon: '⚠', text: 'ČÁSTEČNĚ PROVĚŘENO' };
  return { icon: '✅', text: 'ČISTÉ' };
}

function buildStatusLine(report: DdReport): string {
  const parts: string[] = [];
  if (report.insolvency?.checked === false && report.insolvency.error === 'isir_unavailable') {
    parts.push('ISIR nedostupný — insolvence neověřena');
  } else if (report.insolvency?.has_active_proceeding) {
    parts.push(`Insolvence: aktivní${report.insolvency.spisova_znacka ? ` (${report.insolvency.spisova_znacka})` : ''}`);
  } else if (report.insolvency && report.insolvency.has_active_proceeding === false) {
    parts.push('Insolvence: bez insolvence');
  } else if (report.basic_only) {
    parts.push("Insolvence neprověřena (depth:'full' zdarma)");
  }

  const sanctionsMatches = report.statutory_body.filter((m) => m.sanctions_match).length;
  const sanctionsText = report.sanctions.checked === false && report.sanctions.error === 'sanctions_unavailable'
    ? 'sankce neprověřeny (sankce nedostupný)'
    : report.sanctions.company_match || report.sanctions.any_statutory_match
      ? `sankční shoda (${sanctionsMatches}/${report.statutory_body.length} statutárů)`
      : `bez sankcí (${sanctionsMatches}/${report.statutory_body.length} statutárů)`;
  parts.push(sanctionsText);

  if (report.vat.checked === false && report.vat.error === 'adis_unavailable') {
    parts.push('ADIS nedostupný — DPH spolehlivost neověřena');
  }
  return parts.join(' · ');
}

function buildBasicDataLine(report: DdReport): string {
  const legalForm = resolveLegalForm(report.company.legal_form) ?? 'forma neuvedena';
  const address = report.company.address ?? 'adresa neuvedena';
  const founded = report.company.registered_on
    ? `vznik ${formatDateCs(report.company.registered_on)}${formatAge(report.company.registered_on)}`
    : 'vznik neuveden';
  const vat = report.vat.is_payer
    ? `DPH ${report.vat.dic ?? report.vat.dic_sk_dph ?? 'plátce'}`
    : 'DPH ne';
  return `Základní údaje: ${legalForm} · ${address} · ${founded} · ${vat}.`;
}

function buildSourcesLine(report: DdReport): string {
  const sources = ['ARES', 'EU+OFAC sankce'];
  if (report.vat.checked === false || report.vat.reliability || report.vat.subject_type || report.vat.unreliable_since) sources.push('ADIS');
  if (report.insolvency) sources.push('ISIR');
  if (!report.basic_only || report.red_flags.some((f) => f.code === 'VIRTUAL_ADDRESS')) sources.push('ověření virtuální adresy');
  const unavailable = getUnavailableReferencedSources(report);
  const suffix = unavailable.length > 0
    ? ` — ${unavailable.map((source) => `${source.label} ${source.notChecked ? 'neprověřeno' : 'nedostupný'}`).join(' · ')}`
    : '';
  return `${sources.length} ${zdrojeWord(sources.length)}: ${sources.join(' · ')}${suffix}.`;
}

function buildStatutoryLine(report: DdReport): string {
  const count = report.statutory_body.length;
  const roleDesc = count === 0 ? 'bez statutárů' : statutoryCountLabel(count, report.statutory_body.map((m) => m.role));
  const matches = report.statutory_body.filter((m) => m.sanctions_match).map((m) => m.name);
  return `Statutární orgán: ${roleDesc} · sankční shoda: ${matches[0] ?? 'žádná'}.`;
}

function statutoryCountLabel(count: number, roles: string[]): string {
  const unique = [...new Set(roles.filter(Boolean))];
  const primaryRole = unique[0] ?? '';
  // Map known role strings to Czech plural genitive forms
  const genitivePlural = resolveRoleGenitivePlural(primaryRole, count);
  if (genitivePlural) {
    return `${count} ${genitivePlural}`;
  }
  // Fallback: keep count + role but Czech numerals without "osob ·"
  const fallbackRole = unique.length === 0 ? 'člen' : unique.slice(0, 2).join(', ');
  return `${count} (${fallbackRole})`;
}

function resolveRoleGenitivePlural(role: string, count: number): string | null {
  const normalized = role.toLowerCase().trim();
  // jednatel / jednatelé → "jednatele" (2-4) / "jednatelů" (5+) / "jednatel" (1)
  if (normalized === 'jednatel' || normalized === 'jednatelé') {
    if (count === 1) return 'jednatel';
    if (count <= 4) return 'jednatelé';
    return 'jednatelů';
  }
  // člen představenstva → "členové představenstva" / "členů představenstva"
  if (normalized.includes('představenst')) {
    if (count === 1) return 'člen představenstva';
    if (count <= 4) return 'členové představenstva';
    return 'členů představenstva';
  }
  // člen dozorčí rady
  if (normalized.includes('dozorčí') || normalized.includes('dozorci')) {
    if (count === 1) return 'člen dozorčí rady';
    if (count <= 4) return 'členové dozorčí rady';
    return 'členů dozorčí rady';
  }
  // správce / správci
  if (normalized === 'správce' || normalized === 'správci') {
    if (count === 1) return 'správce';
    if (count <= 4) return 'správci';
    return 'správců';
  }
  return null;
}

function buildFlagLines(flags: RedFlag[]): string[] {
  if (flags.length === 0) return ['Žádné nálezy v prověřených zdrojích.'];
  return flags.map((flag) => `${severityIcon(flag.severity)} ${flag.description} ${gloss(flag.severity)}`);
}

export interface SourceAvailability {
  id: 'isir' | 'sanctions' | 'adis' | 'ares';
  label: string;
  /** true = source was skipped/not run (e.g. depth:basic); false/undefined = source errored/unavailable. */
  notChecked?: boolean;
}

export function getUnavailableReferencedSources(report: DdReport): SourceAvailability[] {
  const unavailable: SourceAvailability[] = [];
  if (report.company.checked === false && report.company.error === 'ares_unavailable') {
    unavailable.push({ id: 'ares', label: 'ARES' });
  }
  if (report.insolvency?.checked === false && report.insolvency.error === 'isir_unavailable') {
    unavailable.push({ id: 'isir', label: 'ISIR' });
  } else if (report.basic_only) {
    // Basic depth never runs ISIR. An unchecked insolvency register means the
    // subject is at best PARTIALLY screened — must not read as fully clean.
    unavailable.push({ id: 'isir', label: 'ISIR', notChecked: true });
  }
  if (report.sanctions.checked === false && report.sanctions.error === 'sanctions_unavailable') {
    unavailable.push({ id: 'sanctions', label: 'sankce' });
  }
  if (report.vat.checked === false && report.vat.error === 'adis_unavailable') {
    unavailable.push({ id: 'adis', label: 'ADIS' });
  }
  return unavailable;
}

function severityIcon(severity: RedFlag['severity']): string {
  return severity === 'critical' || severity === 'high' ? '🔴' : severity === 'medium' ? '⚠' : 'ℹ';
}

function gloss(severity: RedFlag['severity']): string {
  if (severity === 'low') return 'Formalita.';
  if (severity === 'medium') return 'Prověřit.';
  return 'Blokující.';
}

function formatAge(date: string): string {
  const started = Date.parse(date);
  if (Number.isNaN(started)) return '';
  const years = Math.floor((Date.now() - started) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 ? ` (${years} let)` : '';
}
