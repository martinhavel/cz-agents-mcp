/**
 * Risk score = sum of triggered red-flag weights, capped at 100.
 *
 * Bands:
 *   0–20   low
 *   21–50  medium
 *   51+    high
 *
 * Each rule is transparent: the report exposes every triggered flag with
 * its weight and evidence. No black-box ML — auditors can re-derive the score.
 */
import type { AresSubjectLike, AresVrLike, SanctionsMatch } from './clients.js';
import type { RedFlag, RiskLevel } from './types.js';

const HIGH_CONFIDENCE_SANCTIONS = 85;

export interface ScoreInputs {
  ico: string;
  subject: AresSubjectLike | null;
  vr: AresVrLike | null;
  vatPayer: boolean;
  bankAccountsCount: number;
  companySanction?: SanctionsMatch;
  statutorySanctions: Array<{ name: string; match: SanctionsMatch }>;
  insolvency?: { has_active: boolean; started_on?: string } | null;
  /** True if same address shared by 50+ companies (caller computes). */
  isVirtualAddress?: boolean;
  /** Most recent statutory zápis (ISO date), used for "recent change" rule. */
  mostRecentStatutoryChange?: string;
  /** Statutory persons with active personal insolvency in ISIR. */
  statutoryPersonalInsolvencies?: Array<{ name: string; spisova_znacka: string }>;
  /** Statutory persons with permanent residence at a municipal office address. */
  statutoryGovtAddresses?: Array<{ name: string; signal: string; matched_token?: string }>;
  /** Statutory persons matched to a (possibly insolvent) prior company by surname. */
  statutoryPriorBankruptcies?: Array<{ name: string; ico: string; company_name?: string; spisova_znacka?: string }>;
  /** ADIS unreliable-VAT-payer status. Set when ADIS lookup succeeded. */
  adisStatus?: { reliability: 'ANO' | 'NE' | 'NENALEZEN'; unreliable_since?: string; subject_type?: string } | null;
}

export function evaluateFlags(input: ScoreInputs): RedFlag[] {
  const flags: RedFlag[] = [];

  if (input.insolvency?.has_active) {
    flags.push({
      code: 'INSOLVENCY_ACTIVE',
      severity: 'critical',
      weight: 50,
      description: 'Aktivní insolvenční řízení v ISIR.',
      source: 'isir',
      evidence: input.insolvency,
    });
  }

  if (input.companySanction && input.companySanction.confidence >= HIGH_CONFIDENCE_SANCTIONS) {
    flags.push({
      code: 'COMPANY_SANCTIONED',
      severity: 'critical',
      weight: 50,
      description: `Firma na sankčním seznamu (${input.companySanction.entity.source}).`,
      source: `sanctions:${input.companySanction.entity.source}`,
      evidence: input.companySanction,
    });
  }

  for (const s of input.statutorySanctions) {
    if (s.match.confidence >= HIGH_CONFIDENCE_SANCTIONS) {
      flags.push({
        code: 'STATUTORY_SANCTIONED',
        severity: 'critical',
        weight: 50,
        description: `Statutární zástupce na sankčním seznamu: ${s.name} (${s.match.entity.source}).`,
        source: `sanctions:${s.match.entity.source}`,
        evidence: s,
      });
    }
  }

  for (const g of input.statutoryGovtAddresses ?? []) {
    flags.push({
      code: 'STATUTORY_REGISTERED_AT_GOVT_OFFICE',
      severity: 'high',
      weight: 25,
      description: `Statutární osoba ${g.name} má trvalé bydliště evidované na úřadu (signál: ${g.signal}${g.matched_token ? `, ${g.matched_token}` : ''}). Klasický indikátor "bílého koně" — nestabilní bydlení nebo nominální statutář pro shell company.`,
      source: 'ares',
      evidence: g,
    });
  }

  for (const p of input.statutoryPriorBankruptcies ?? []) {
    flags.push({
      code: 'STATUTORY_PRIOR_BANKRUPT_COMPANY',
      severity: 'high',
      weight: 20,
      description: `Statutární osoba ${p.name} je pravděpodobně spojena s firmou ${p.company_name ?? p.ico} (IČO ${p.ico}), která má aktivní insolvenční řízení (${p.spisova_znacka ?? 'spis. zn. neznámá'}). Možný serial-bankrupt founder pattern. Volitelně ověřit přes ARES /historie.`,
      source: 'ares+isir',
      evidence: p,
    });
  }

  for (const p of input.statutoryPersonalInsolvencies ?? []) {
    flags.push({
      code: 'STATUTORY_PERSONAL_INSOLVENCY',
      severity: 'critical',
      weight: 50,
      description: `Statutární osoba v osobní insolvenci: ${p.name} (${p.spisova_znacka}). Dle § 13 ZSVR je nezpůsobilá řídit firmu.`,
      source: 'isir',
      evidence: p,
    });
  }

  if (input.subject?.datumZaniku) {
    flags.push({
      code: 'COMPANY_DISSOLVED',
      severity: 'critical',
      weight: 50,
      description: `Firma zanikla (${input.subject.datumZaniku}).`,
      source: 'ares',
      evidence: { datumZaniku: input.subject.datumZaniku },
    });
  }

  if (input.isVirtualAddress) {
    flags.push({
      code: 'VIRTUAL_ADDRESS',
      severity: 'medium',
      weight: 10,
      description: 'Adresa registrovaná u 50+ firem (pravděpodobně virtuální sídlo).',
      source: 'ares',
      evidence: { address: input.subject?.sidlo?.textovaAdresa },
    });
  }

  if (input.mostRecentStatutoryChange) {
    const days = daysBetween(new Date(input.mostRecentStatutoryChange), new Date());
    if (days >= 0 && days < 30) {
      flags.push({
        code: 'RECENT_STATUTORY_CHANGE',
        severity: 'medium',
        weight: 10,
        description: `Změna ve statutárním orgánu před ${days} dny.`,
        source: 'ares',
        evidence: { datumZapisu: input.mostRecentStatutoryChange },
      });
    }
  }

  if (input.subject?.datumVzniku) {
    const days = daysBetween(new Date(input.subject.datumVzniku), new Date());
    if (days >= 0 && days < 180) {
      flags.push({
        code: 'NEW_COMPANY',
        severity: 'low',
        weight: 5,
        description: `Firma registrována před ${days} dny (mladší 6 měsíců).`,
        source: 'ares',
        evidence: { datumVzniku: input.subject.datumVzniku },
      });
    }
  }

  if (input.vatPayer && input.bankAccountsCount === 0) {
    flags.push({
      code: 'NO_DPH_BANK_ACCOUNT',
      severity: 'low',
      weight: 5,
      description: 'Plátce DPH bez zveřejněného transparentního účtu.',
      source: 'ares',
    });
  }

  if (input.adisStatus?.reliability === 'ANO') {
    flags.push({
      code: 'UNRELIABLE_VAT_PAYER',
      severity: 'high',
      weight: 30,
      description:
        `Subjekt je v MFČR registru veden jako nespolehlivý plátce DPH${
          input.adisStatus.unreliable_since ? ` (od ${input.adisStatus.unreliable_since})` : ''
        }. Platba na nezveřejněný účet zakládá ručení odběratele za daň dle § 109 ZDPH.`,
      source: 'adis',
      evidence: input.adisStatus,
    });
  }
  if (input.adisStatus?.subject_type === 'NESPOLEHLIVA_OSOBA') {
    flags.push({
      code: 'UNRELIABLE_VAT_PERSON',
      severity: 'high',
      weight: 30,
      description:
        'Subjekt je veden jako nespolehlivá osoba dle § 106a ZDPH. Identifikovaný před vstupem do registru plátců DPH jako rizikový.',
      source: 'adis',
      evidence: input.adisStatus,
    });
  }

  if (!input.subject) {
    flags.push({
      code: 'NOT_FOUND_IN_ARES',
      severity: 'high',
      weight: 30,
      description: 'IČO nenalezeno v ARES.',
      source: 'ares',
    });
  }

  return flags;
}

export function scoreFromFlags(flags: RedFlag[]): { value: number; level: RiskLevel } {
  const sum = flags.reduce((acc, f) => acc + f.weight, 0);
  const value = Math.min(100, sum);
  // Any critical flag forces 'high' regardless of numeric score — compliance
  // default: insolvency / sanctions / dissolution ARE high risk by definition.
  const hasCritical = flags.some((f) => f.severity === 'critical');
  const level: RiskLevel = hasCritical
    ? 'high'
    : value <= 20
      ? 'low'
      : value <= 50
        ? 'medium'
        : 'high';
  return { value, level };
}

function daysBetween(a: Date, b: Date): number {
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return -1;
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
