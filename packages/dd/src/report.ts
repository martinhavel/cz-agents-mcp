/**
 * Orchestrator: pulls company facts from ARES, screens against sanctions,
 * checks insolvency (when ISIR client provided), aggregates into a single
 * report with explainable risk score.
 */
import type {
  AresAddressLike,
  AresLike,
  AresStatutoryMember,
  AresStatutoryOrgan,
  DdClients,
  SanctionsLike,
  SanctionsMatch,
} from './clients.js';
import { evaluateFlags, scoreFromFlags } from './score.js';
import { detectGovtAddress } from './govtAddress.js';
import type {
  DdReport,
  SanctionMatchSummary,
  StatutoryMember,
} from './types.js';

const VIRTUAL_ADDRESS_THRESHOLD = 50;

export interface ReportOptions {
  /** 'basic' = ARES + sanctions only. 'full' = + ISIR + virtual-address probe. */
  depth?: 'basic' | 'full';
}

export async function buildReport(
  ico: string,
  clients: DdClients,
  opts: ReportOptions = {},
): Promise<DdReport> {
  const depth = opts.depth ?? 'basic';
  const basicOnly = depth === 'basic';

  const [subject, bankAccounts, vr] = await Promise.all([
    safe(() => clients.ares.getByIco(ico)),
    safe(() => clients.ares.getBankAccounts(ico)),
    safe(() => clients.ares.getVrRecord(ico)),
  ]);

  const { members, mostRecentStatutoryChange } = extractStatutoryMembers(vr);

  const screenedMembers = await screenStatutory(members, clients.sanctions);

  // Govt-address detection on each statutory FO (úřad bydliště = bílý kůň indicator).
  // Cheap heuristic — runs even in basic depth.
  const govtAddrFlags: Array<{ name: string; signal: string; matched_token?: string }> = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    if (!m.is_person) continue;
    const detect = detectGovtAddress(m.address);
    if (detect.is_govt_address) {
      const sm = screenedMembers[i];
      if (sm) {
        sm.registered_at_govt_office = {
          signal: detect.signal as 'marker' | 'known_address',
          matched_token: detect.matched_token,
        };
      }
      govtAddrFlags.push({ name: m.name, signal: detect.signal, matched_token: detect.matched_token });
    }
  }

  // Fáze 2: historical bankrupt-company check per statutory person.
  // For each surname, search ARES for other companies → check ISIR per company.
  // Conservative: only flag when an OTHER company (not the current ICO) had/has insolvency.
  const priorBankruptcyHits: Array<{ name: string; ico: string; company_name?: string; spisova_znacka?: string }> = [];
  if (!basicOnly && clients.isir) {
    await Promise.all(
      members.map(async (m, i) => {
        if (!m.is_person) return;
        const surname = m.surname;
        if (!surname || surname.length < 5) return; // Skip short common surnames
        const otherIcos = await findOtherCompaniesBySurname(clients.ares, surname, ico);
        for (const co of otherIcos.slice(0, 5)) {
          const status = await safe(() => clients.isir!.checkActiveInsolvency(co.ico));
          if (status?.has_active) {
            const sm = screenedMembers[i];
            if (sm) {
              if (!sm.prior_bankrupt_companies) sm.prior_bankrupt_companies = [];
              sm.prior_bankrupt_companies.push({
                ico: co.ico,
                name: co.name,
                spisova_znacka: status.spisova_znacka,
              });
            }
            priorBankruptcyHits.push({ name: m.name, ico: co.ico, company_name: co.name, spisova_znacka: status.spisova_znacka });
          }
        }
      }),
    );
  }

  // Person-level insolvency screen (full depth only) — uses ISIR person search
  // by name + DOB. Skip silently when ISIR client doesn't expose searchPersonInsolvency.
  if (!basicOnly && clients.isir?.searchPersonInsolvency) {
    await Promise.all(
      screenedMembers.map(async (m, i) => {
        if (!m.is_person) return;
        const dob = members[i]?.dob;
        try {
          const hits = await clients.isir!.searchPersonInsolvency!({ name: m.name, dob, onlyActive: true });
          if (hits.length > 0) {
            const top = hits[0]!;
            m.personal_insolvency = {
              spisova_znacka: top.spisova_znacka,
              phase: top.druh_stav_konkursu,
              url: top.url_detail,
            };
          }
        } catch {
          // Network/ISIR error — degrade gracefully, do not fail whole report
        }
      }),
    );
  }

  const companyMatch = screenCompany(ico, subject?.obchodniJmeno, clients.sanctions);

  const insolvency = !basicOnly && clients.isir
    ? await safe(() => clients.isir!.checkActiveInsolvency(ico))
    : null;

  const isVirtualAddress = !basicOnly
    ? await checkVirtualAddress(clients.ares, subject)
    : undefined;

  const flags = evaluateFlags({
    ico,
    subject: subject ?? null,
    vr: vr ?? null,
    vatPayer: !!subject?.dic,
    bankAccountsCount: bankAccounts?.length ?? 0,
    companySanction: companyMatch ?? undefined,
    statutorySanctions: screenedMembers
      .filter((m) => m.sanctions_match)
      .map((m) => ({
        name: m.name,
        match: rebuildSanctionsMatch(m.sanctions_match!),
      })),
    insolvency: insolvency ?? null,
    isVirtualAddress,
    mostRecentStatutoryChange,
    statutoryPersonalInsolvencies: screenedMembers
      .filter((m) => m.personal_insolvency)
      .map((m) => ({ name: m.name, spisova_znacka: m.personal_insolvency!.spisova_znacka })),
    statutoryGovtAddresses: govtAddrFlags,
    statutoryPriorBankruptcies: priorBankruptcyHits,
  });

  return {
    ico,
    retrieved_at: new Date().toISOString(),
    basic_only: basicOnly,
    company: {
      name: subject?.obchodniJmeno,
      legal_form: subject?.pravniForma,
      address: subject?.sidlo?.textovaAdresa,
      registered_on: subject?.datumVzniku,
      dissolved_on: subject?.datumZaniku,
      nace_codes: subject?.czNace,
      found: !!subject,
    },
    vat: {
      is_payer: !!subject?.dic,
      dic: subject?.dic,
      bank_accounts: (bankAccounts ?? []).map((a) => `${a.cisloUctu}/${a.kodBanky}`),
      financial_office: subject?.financniUrad,
    },
    statutory_body: screenedMembers,
    insolvency: insolvency
      ? {
          has_active_proceeding: insolvency.has_active,
          spisova_znacka: insolvency.spisova_znacka,
          started_on: insolvency.started_on,
        }
      : !basicOnly && clients.isir
        ? { has_active_proceeding: false, note: 'No record found' }
        : undefined,
    sanctions: {
      company_match: companyMatch ? toSummary(companyMatch) : undefined,
      any_statutory_match: screenedMembers.some((m) => m.sanctions_match),
    },
    red_flags: flags,
    risk_score: scoreFromFlags(flags),
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

interface StatutoryExtract {
  members: Array<{
    name: string;
    surname?: string;
    role: string;
    since?: string;
    is_person: boolean;
    legal_entity_ico?: string;
    nationality?: string;
    dob?: string;
    address?: AresAddressLike;
  }>;
  mostRecentStatutoryChange?: string;
}

function extractStatutoryMembers(vr: { statutarniOrgany?: AresStatutoryOrgan[] } | null): StatutoryExtract {
  if (!vr?.statutarniOrgany) return { members: [] };

  const out: StatutoryExtract = { members: [] };
  let mostRecent = 0;

  for (const organ of vr.statutarniOrgany) {
    if (organ.datumVymazu) continue;
    for (const m of organ.clenoveOrganu ?? []) {
      if (m.datumVymazu) continue;
      const member = mapMember(m);
      if (member) out.members.push(member);

      const ts = m.datumZapisu ? Date.parse(m.datumZapisu) : NaN;
      if (!Number.isNaN(ts) && ts > mostRecent) mostRecent = ts;
    }
  }
  if (mostRecent > 0) out.mostRecentStatutoryChange = new Date(mostRecent).toISOString().slice(0, 10);
  return out;
}

function mapMember(raw: AresStatutoryMember): StatutoryExtract['members'][number] | null {
  const role = raw.funkce?.nazev ?? 'člen';
  const since = raw.datumZapisu;
  if (raw.fyzickaOsoba) {
    const fo = raw.fyzickaOsoba;
    const name = [fo.titulPredJmenem, fo.jmeno, fo.prijmeni, fo.titulZaJmenem]
      .filter(Boolean).join(' ').trim();
    if (!name) return null;
    return {
      name,
      surname: fo.prijmeni,
      role,
      since,
      is_person: true,
      dob: fo.datumNarozeni,
      nationality: fo.statniObcanstvi,
      address: fo.adresa,
    };
  }
  if (raw.pravnickaOsoba) {
    const po = raw.pravnickaOsoba;
    const name = po.obchodniJmeno;
    if (!name) return null;
    return {
      name,
      role,
      since,
      is_person: false,
      legal_entity_ico: po.ico,
    };
  }
  return null;
}

async function screenStatutory(
  members: StatutoryExtract['members'],
  sanctions: SanctionsLike | undefined,
): Promise<StatutoryMember[]> {
  if (!sanctions) {
    return members.map((m) => ({
      name: m.name,
      role: m.role,
      since: m.since,
      is_person: m.is_person,
      legal_entity_ico: m.legal_entity_ico,
    }));
  }

  return members.map((m) => {
    const matches = m.is_person
      ? sanctions.searchByName(m.name, { typeFilter: 'person', threshold: 80, limit: 1, dob: m.dob })
      : m.legal_entity_ico
        ? sanctions.searchByIco(m.legal_entity_ico, m.name)
        : sanctions.searchByName(m.name, { typeFilter: 'entity', threshold: 80, limit: 1 });

    const top = matches[0];
    return {
      name: m.name,
      role: m.role,
      since: m.since,
      is_person: m.is_person,
      legal_entity_ico: m.legal_entity_ico,
      sanctions_match: top ? toSummary(top) : undefined,
    };
  });
}

function screenCompany(
  ico: string,
  name: string | undefined,
  sanctions: SanctionsLike | undefined,
): SanctionsMatch | null {
  if (!sanctions) return null;
  const matches = sanctions.searchByIco(ico, name);
  return matches[0] ?? null;
}

function toSummary(match: SanctionsMatch): SanctionMatchSummary {
  return {
    source: match.entity.source,
    list_id: match.entity.id,
    confidence: match.confidence,
    matched_on: match.matched_on,
  };
}

function rebuildSanctionsMatch(s: SanctionMatchSummary): SanctionsMatch {
  return {
    entity: { id: s.list_id, source: s.source, primary_name: '', type: 'person' },
    confidence: s.confidence,
    matched_on: s.matched_on,
  };
}

async function findOtherCompaniesBySurname(
  ares: AresLike,
  surname: string,
  excludeIco: string,
): Promise<Array<{ ico: string; name?: string }>> {
  try {
    const r = await ares.search({ obchodniJmeno: surname, pocet: 20 });
    return r.ekonomickeSubjekty
      .filter((s) => s.ico && s.ico !== excludeIco)
      .map((s) => ({ ico: s.ico, name: s.obchodniJmeno }));
  } catch {
    return [];
  }
}

async function checkVirtualAddress(
  ares: AresLike,
  subject: { sidlo?: { nazevUlice?: string; nazevObce?: string; psc?: number } } | null,
): Promise<boolean> {
  const s = subject?.sidlo;
  if (!s?.nazevObce || !s.nazevUlice) return false;
  try {
    const result = await ares.search({
      sidlo: { nazevUlice: s.nazevUlice, nazevObce: s.nazevObce, psc: s.psc },
      pocet: 1,
    });
    return result.pocetCelkem >= VIRTUAL_ADDRESS_THRESHOLD;
  } catch {
    return false;
  }
}
