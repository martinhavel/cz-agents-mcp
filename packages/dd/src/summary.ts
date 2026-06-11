import { resolveLegalForm } from '@czagents/shared';
import type { DdReport, RedFlag, RiskLevel } from './types.js';

export interface RiskScoreSummaryPayload {
  ico: string;
  company_name?: string;
  value: number;
  level: RiskLevel;
  top_flags: RedFlag[];
  retrieved_at?: string;
}

export function buildDdSummaryMarkdown(report: DdReport): string {
  const name = report.company.name ?? 'Nenalezeno';
  const verdict = verdictFor(report.risk_score.level);
  const lines = [
    `**${name}** · IČO ${report.ico} — ${verdict.icon} ${verdict.text}. Riziko ${report.risk_score.value}/100 (${report.risk_score.level}).`,
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
  const verdict = verdictFor(payload.level);
  const lines = [
    `**${payload.company_name ?? 'Nenalezeno'}** · IČO ${payload.ico} — ${verdict.icon} ${verdict.text}. Riziko ${payload.value}/100 (${payload.level}).`,
    ...buildFlagLines(payload.top_flags),
    `*Snapshot ${payload.retrieved_at ?? 'neuveden'} · cz-agents.dev*`,
  ];
  return lines.filter(Boolean).join('\n');
}

function verdictFor(level: RiskLevel): { icon: string; text: string } {
  if (level === 'high') return { icon: '🔴', text: 'RIZIKO' };
  if (level === 'medium') return { icon: '⚠', text: 'POZOR' };
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
  const sanctionsText = report.sanctions.company_match || report.sanctions.any_statutory_match
    ? `sankční shoda (${sanctionsMatches}/${report.statutory_body.length} statutárů)`
    : `bez sankcí (${sanctionsMatches}/${report.statutory_body.length} statutárů)`;
  parts.push(sanctionsText);
  return parts.join(' · ');
}

function buildBasicDataLine(report: DdReport): string {
  const legalForm = resolveLegalForm(report.company.legal_form) ?? 'forma neuvedena';
  const address = report.company.address ?? 'adresa neuvedena';
  const founded = report.company.registered_on
    ? `vznik ${report.company.registered_on}${formatAge(report.company.registered_on)}`
    : 'vznik neuveden';
  const vat = report.vat.is_payer
    ? `DPH ${report.vat.dic ?? report.vat.dic_sk_dph ?? 'plátce'}`
    : 'DPH ne';
  return `Základní údaje: ${legalForm} · ${address} · ${founded} · ${vat}.`;
}

function buildSourcesLine(report: DdReport): string {
  const sources = ['ARES', 'EU+OFAC sankce'];
  if (report.vat.reliability || report.vat.subject_type || report.vat.unreliable_since) sources.push('ADIS');
  if (report.insolvency) sources.push('ISIR');
  if (!report.basic_only || report.red_flags.some((f) => f.code === 'VIRTUAL_ADDRESS')) sources.push('test virt.adresy');
  return `${sources.length} zdrojů: ${sources.join(' · ')}.`;
}

function buildStatutoryLine(report: DdReport): string {
  const count = report.statutory_body.length;
  const role = count === 0 ? 'bez statutárů' : summarizeRoles(report.statutory_body.map((m) => m.role));
  const matches = report.statutory_body.filter((m) => m.sanctions_match).map((m) => m.name);
  return `Statutární orgán: ${count} ${count === 1 ? 'osoba' : count > 1 && count < 5 ? 'osoby' : 'osob'} · ${role} · sankční shoda: ${matches[0] ?? 'žádná'}.`;
}

function buildFlagLines(flags: RedFlag[]): string[] {
  if (flags.length === 0) return ['Žádné nálezy v prověřených zdrojích.'];
  return flags.map((flag) => `${severityIcon(flag.severity)} ${flag.description} ${gloss(flag.severity)}`);
}

function severityIcon(severity: RedFlag['severity']): string {
  return severity === 'critical' || severity === 'high' ? '🔴' : severity === 'medium' ? '⚠' : 'ℹ';
}

function gloss(severity: RedFlag['severity']): string {
  if (severity === 'low') return 'Formalita.';
  if (severity === 'medium') return 'Prověřit.';
  return 'Blokující.';
}

function summarizeRoles(roles: string[]): string {
  const unique = [...new Set(roles.filter(Boolean))];
  return unique.length === 0 ? 'člen' : unique.slice(0, 2).join(', ');
}

function formatAge(date: string): string {
  const started = Date.parse(date);
  if (Number.isNaN(started)) return '';
  const years = Math.floor((Date.now() - started) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 ? ` (${years} let)` : '';
}
