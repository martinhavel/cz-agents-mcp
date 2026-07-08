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
  DdSanctions,
  EsmOnramp,
  OwnershipNetworkTeaser,
  SanctionMatchSummary,
  StatutoryMember,
} from './types.js';
import { getOwnershipNetwork } from './ownership-network.js';

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

  // The primary ARES subject lookup distinguishes "404 → genuinely null" from
  // "threw → ARES outage". Collapsing both to null (as plain safe() does) makes
  // an outage indistinguishable from a non-existent IČO and yields a misleading
  // NOT_FOUND_IN_ARES flag on a clean-looking report. Track the outage instead.
  const subjectResult = await safeWithError(() => clients.ares.getByIco(ico));
  const subject = subjectResult.value;
  const aresUnavailable = subjectResult.errored;
  const [bankAccounts, vr] = await Promise.all([
    safe(() => clients.ares.getBankAccounts(ico)),
    safe(() => clients.ares.getVrRecord(ico)),
  ]);

  const { members, mostRecentStatutoryChange } = extractStatutoryMembers(vr);

  const statutoryScreening = await screenStatutory(members, clients.sanctions);
  const screenedMembers = statutoryScreening.members;

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
  // Heuristic: search ARES for companies whose obchodniJmeno contains the
  // statutory's FULL NAME (not just surname — surname-only matches are too
  // noisy on common Czech surnames; e.g. Michal Peřina ≠ Radek Peřina).
  // We then verify via ARES VR that this person actually sits in that
  // company's statutory body before flagging.
  // True precision requires ESM (evidence skutečných majitelů) — future package.
  const priorBankruptcyHits: Array<{ name: string; ico: string; company_name?: string; spisova_znacka?: string }> = [];
  if (!basicOnly && clients.isir) {
    await Promise.all(
      members.map(async (m, i) => {
        if (!m.is_person) return;
        const surname = m.surname;
        // Need both first name + surname to do a precise full-name match
        const firstName = m.name.replace(new RegExp(`\\s*${surname ?? ''}\\s*$`), '').trim();
        if (!surname || surname.length < 4 || !firstName) return;
        const otherIcos = await findOtherCompaniesByFullName(
          clients.ares,
          firstName,
          surname,
          ico,
        );
        for (const co of otherIcos.slice(0, 5)) {
          const status = await safe(() => clients.isir!.checkActiveInsolvency(co.ico));
          if (!status?.has_active) continue;
          // Verify this person is ACTUALLY in the bankrupt company's statutory
          // body, not just a name collision (Pavel Novák s.r.o. vs Pavel Novák
          // the LUGI jednatel are different people).
          const isReallyStatutory = await verifyPersonIsStatutory(
            clients.ares,
            co.ico,
            firstName,
            surname,
          );
          if (!isReallyStatutory) continue;
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

  const companyScreening = screenCompany(ico, subject?.obchodniJmeno, clients.sanctions);
  const companyMatch = companyScreening.match;
  const sanctionsUnavailable = statutoryScreening.error === 'sanctions_unavailable' || companyScreening.error === 'sanctions_unavailable';

  const insolvency = !basicOnly && clients.isir
    ? await checkCompanyInsolvency(clients.isir, ico)
    : { status: null, error: null };

  // ADIS unreliable-VAT-payer check. Cheap (~1s) and runs even in basic depth
  // because joint-liability under § 109 ZDPH is one of the more material risks
  // the report should surface. Returns null when ADIS not wired or DIČ unknown.
  // Use ARES-supplied DIČ when available — natural persons have DIČ ≠ CZ+IČO
  // (birth-number based), so looking up by IČO alone returns NENALEZEN.
  // VAT-group members (§ 5a ZDPH): ARES returns dicSkDph for the group's DIČ.
  // ADIS only knows the group DIČ, not the member's own DIČ — use dicSkDph when present.
  const adisDic = subject?.dicSkDph ?? subject?.dic ?? undefined;
  const adisResult = await checkAdisPayer(clients.adis, adisDic ? { dic: adisDic } : { ico });
  const adisStatus = adisResult.status;

  const isVirtualAddress = !basicOnly
    ? await checkVirtualAddress(clients.ares, subject)
    : undefined;

  const flags = evaluateFlags({
    ico,
    subject: subject ?? null,
    aresUnavailable,
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
    insolvency: insolvency.status ?? null,
    isVirtualAddress,
    mostRecentStatutoryChange,
    statutoryPersonalInsolvencies: screenedMembers
      .filter((m) => m.personal_insolvency)
      .map((m) => ({ name: m.name, spisova_znacka: m.personal_insolvency!.spisova_znacka })),
    statutoryGovtAddresses: govtAddrFlags,
    statutoryPriorBankruptcies: priorBankruptcyHits,
    adisStatus: adisStatus
      ? {
          reliability: adisStatus.reliability,
          unreliable_since: adisStatus.unreliable_since,
          subject_type: adisStatus.subject_type,
        }
      : null,
  });

  const ownershipNetworkTeaser = await buildOwnershipNetworkTeaser(ico);

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
      ...(aresUnavailable ? { checked: false as const, error: 'ares_unavailable' as const } : {}),
    },
    vat: {
      is_payer: !!subject?.dic,
      dic: subject?.dic,
      dic_sk_dph: subject?.dicSkDph,
      // ADIS bank accounts are richer (predcisli + dates) than ARES — prefer ADIS when both present.
      bank_accounts: adisStatus && adisStatus.accounts.length > 0
        ? adisStatus.accounts.map((a) => a.formatted)
        : (bankAccounts ?? []).map((a) => `${a.cisloUctu}/${a.kodBanky}`),
      financial_office: subject?.financniUrad,
      reliability: adisStatus?.reliability,
      unreliable_since: adisStatus?.unreliable_since,
      subject_type: adisStatus?.subject_type,
      ...(adisResult.error ? { checked: false as const, error: adisResult.error } : {}),
    },
    statutory_body: screenedMembers,
    insolvency: insolvency.error
      ? { checked: false, error: 'isir_unavailable' }
      : insolvency.status
      ? {
          has_active_proceeding: insolvency.status.has_active,
          spisova_znacka: insolvency.status.spisova_znacka,
          started_on: insolvency.status.started_on,
        }
      : !basicOnly && clients.isir
        ? { has_active_proceeding: false, note: 'No record found' }
        : undefined,
    sanctions: buildSanctionsReport({
      company_match: companyMatch ? toSummary(companyMatch) : undefined,
      any_statutory_match: screenedMembers.some((m) => m.sanctions_match),
      unavailable: sanctionsUnavailable,
    }),
    red_flags: flags,
    risk_score: scoreFromFlags(flags),
    ownership_network_teaser: ownershipNetworkTeaser,
    esm_onramp: ESM_ONRAMP,
  };
}

const OWNERSHIP_NETWORK_TEASER_TITLE = 'Vlastnická a personální síť (z veřejného VR)' as const;
const OWNERSHIP_NETWORK_UPGRADE_HINT = 'Pro plnou síť a signály přejděte na vyšší tarif.' as const;
const OWNERSHIP_NETWORK_PREPARING_TEXT = 'Síť se připravuje.' as const;

const ESM_ONRAMP: EsmOnramp = {
  title: 'Skutečný majitel (ESM)',
  copy: [
    'ESM je od 17.12.2025 neveřejný registr.',
    'Povinná osoba má zákonnou povinnost zjistit skutečného majitele (AML zákon 253/2008 Sb.).',
    "Postup: přihlásit se datovou schránkou → podat žádost o dálkový přístup → prokázat identitu na úrovni 'značná'.",
  ],
  link: 'https://esm.justice.cz',
  separation: {
    dolozeny_ubo: 'Pouze co klient sám získá z ESM.',
    indikovana_struktura: 'Náš VR odhad z veřejného rejstříku.',
  },
};

async function buildOwnershipNetworkTeaser(ico: string): Promise<OwnershipNetworkTeaser> {
  try {
    const summary = await getOwnershipNetwork(ico, { level: 'summary' });
    if (!summary || isEmptyOwnershipSummary(summary)) {
      return emptyOwnershipNetworkTeaser();
    }
    return {
      title: OWNERSHIP_NETWORK_TEASER_TITLE,
      network_size: normalizeNonNegativeInteger(summary.network_size),
      shared_role_link_count: normalizeNonNegativeInteger(summary.shared_role_link_count),
      coverage_pct: normalizeCoverage(summary.coverage_pct),
      as_of: summary.as_of ?? null,
      upgrade_hint: OWNERSHIP_NETWORK_UPGRADE_HINT,
    };
  } catch {
    return emptyOwnershipNetworkTeaser();
  }
}

function emptyOwnershipNetworkTeaser(): OwnershipNetworkTeaser {
  return {
    title: OWNERSHIP_NETWORK_TEASER_TITLE,
    network_size: 0,
    shared_role_link_count: 0,
    coverage_pct: 0,
    as_of: null,
    upgrade_hint: OWNERSHIP_NETWORK_UPGRADE_HINT,
    text: OWNERSHIP_NETWORK_PREPARING_TEXT,
  };
}

function isEmptyOwnershipSummary(summary: {
  network_size?: number;
  shared_role_link_count?: number;
  coverage_pct?: number;
  as_of?: string | null;
}): boolean {
  return (
    summary.network_size === undefined &&
    summary.shared_role_link_count === undefined &&
    summary.coverage_pct === undefined &&
    summary.as_of === undefined
  );
}

function normalizeNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

function normalizeCoverage(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Like safe(), but reports whether the call threw. Used for the primary ARES
 * lookup so a genuine 404 (value=null, errored=false) is distinguishable from
 * an upstream outage (value=null, errored=true).
 */
async function safeWithError<T>(fn: () => Promise<T>): Promise<{ value: T | null; errored: boolean }> {
  try {
    return { value: await fn(), errored: false };
  } catch {
    return { value: null, errored: true };
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
      const member = mapMember(m, organ.nazevOrganu);
      if (member) out.members.push(member);

      const ts = m.datumZapisu ? Date.parse(m.datumZapisu) : NaN;
      if (!Number.isNaN(ts) && ts > mostRecent) mostRecent = ts;
    }
  }
  if (mostRecent > 0) out.mostRecentStatutoryChange = new Date(mostRecent).toISOString().slice(0, 10);
  return out;
}

function mapMember(raw: AresStatutoryMember, organName?: string): StatutoryExtract['members'][number] | null {
  const role = raw.funkce?.nazev ?? inferRoleFromOrganName(organName);
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

function inferRoleFromOrganName(organName?: string): string {
  const normalized = normalizeCzech(organName ?? '');
  if (normalized.includes('jednatele')) return 'jednatel';
  if (normalized.includes('predseda predstavenstva')) return 'předseda představenstva';
  if (normalized.includes('predstavenstvo')) return 'člen představenstva';
  return 'člen';
}

function normalizeCzech(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

async function checkCompanyInsolvency(
  isir: NonNullable<DdClients['isir']>,
  ico: string,
): Promise<{
  status: Awaited<ReturnType<NonNullable<DdClients['isir']>['checkActiveInsolvency']>>;
  error: 'isir_unavailable' | null;
}> {
  try {
    return { status: await isir.checkActiveInsolvency(ico), error: null };
  } catch {
    return { status: null, error: 'isir_unavailable' };
  }
}

async function screenStatutory(
  members: StatutoryExtract['members'],
  sanctions: SanctionsLike | undefined,
): Promise<{ members: StatutoryMember[]; error: 'sanctions_unavailable' | null }> {
  const unscreenedMembers = () => members.map((m) => ({
    name: m.name,
    role: m.role,
    since: m.since,
    is_person: m.is_person,
    datumNarozeni: m.dob,
    legal_entity_ico: m.legal_entity_ico,
  }));

  if (!sanctions) {
    return { members: unscreenedMembers(), error: 'sanctions_unavailable' };
  }

  try {
    return {
      members: members.map((m) => {
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
          datumNarozeni: m.dob,
          legal_entity_ico: m.legal_entity_ico,
          sanctions_match: top ? toSummary(top, m.dob) : undefined,
        };
      }),
      error: null,
    };
  } catch {
    return { members: unscreenedMembers(), error: 'sanctions_unavailable' };
  }
}

function screenCompany(
  ico: string,
  name: string | undefined,
  sanctions: SanctionsLike | undefined,
): { match: SanctionsMatch | null; error: 'sanctions_unavailable' | null } {
  if (!sanctions) return { match: null, error: 'sanctions_unavailable' };
  try {
    const matches = sanctions.searchByIco(ico, name);
    return { match: matches[0] ?? null, error: null };
  } catch {
    return { match: null, error: 'sanctions_unavailable' };
  }
}

async function checkAdisPayer(
  adis: DdClients['adis'],
  input: { ico?: string; dic?: string },
): Promise<{
  status: Awaited<ReturnType<NonNullable<DdClients['adis']>['checkPayer']>>;
  error: 'adis_unavailable' | null;
}> {
  if (!adis) return { status: null, error: 'adis_unavailable' };
  try {
    return { status: await adis.checkPayer(input), error: null };
  } catch {
    return { status: null, error: 'adis_unavailable' };
  }
}

function buildSanctionsReport(input: {
  company_match?: SanctionMatchSummary;
  any_statutory_match: boolean;
  unavailable: boolean;
}): DdSanctions {
  return {
    company_match: input.company_match,
    any_statutory_match: input.any_statutory_match,
    ...(input.unavailable ? { checked: false as const, error: 'sanctions_unavailable' as const } : {}),
  };
}

function toSummary(match: SanctionsMatch, subjectDob?: string): SanctionMatchSummary {
  const listDobs = nonEmptyArray(match.entity.dobs);
  const nationalities = nonEmptyArray(match.entity.nationalities);
  const programs = nonEmptyArray(match.entity.programs);
  const dobStatus = deriveDobStatus(listDobs, subjectDob);

  return {
    source: match.entity.source,
    list_id: match.entity.id,
    confidence: match.confidence,
    matched_on: match.matched_on,
    primary_name: match.entity.primary_name,
    matched_alias: match.matched_alias,
    list_dobs: listDobs,
    subject_dob: subjectDob,
    dob_status: dobStatus,
    match_strength: deriveMatchStrength(match, dobStatus),
    nationalities,
    programs,
    listed_on: match.entity.listed_on,
  };
}

function rebuildSanctionsMatch(s: SanctionMatchSummary): SanctionsMatch {
  return {
    entity: {
      id: s.list_id,
      source: s.source,
      primary_name: s.primary_name,
      type: 'person',
      dobs: s.list_dobs,
      nationalities: s.nationalities,
      programs: s.programs,
      listed_on: s.listed_on,
    },
    confidence: s.confidence,
    matched_on: s.matched_on,
    matched_alias: s.matched_alias,
  };
}

function nonEmptyArray(values: string[] | undefined): string[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function deriveDobStatus(
  listDobs: string[] | undefined,
  subjectDob: string | undefined,
): SanctionMatchSummary['dob_status'] {
  if (!subjectDob) return 'subject_missing';
  if (!listDobs || listDobs.length === 0) return 'list_missing';
  return listDobs.some((listDob) => dobValuesMatch(listDob, subjectDob)) ? 'match' : 'mismatch';
}

function dobValuesMatch(listDob: string, subjectDob: string): boolean {
  if (listDob === subjectDob) return true;
  if (/^\d{4}$/.test(listDob)) {
    return extractYear(subjectDob) === listDob;
  }
  return false;
}

function extractYear(value: string): string | null {
  return value.match(/\d{4}/)?.[0] ?? null;
}

function deriveMatchStrength(
  match: SanctionsMatch,
  dobStatus: SanctionMatchSummary['dob_status'],
): SanctionMatchSummary['match_strength'] {
  if (match.matched_on === 'id' || match.matched_on === 'ico') return 'strong';
  if (match.confidence >= 90 && dobStatus === 'match') return 'strong';
  if (
    (match.confidence >= 80 && (dobStatus === 'list_missing' || dobStatus === 'subject_missing')) ||
    match.confidence >= 90
  ) {
    return 'possible';
  }
  return 'weak-name-only';
}

/** Older surname-only match — kept for compat with chain.ts callers. */
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

/**
 * Tighter than surname-only: searches ARES for companies whose obchodniJmeno
 * contains BOTH first name and surname (typical for self-named s.r.o. like
 * "Radek Peřina"). Eliminates the false-positive class of "different person,
 * same surname" that surname-only search produced.
 */
async function findOtherCompaniesByFullName(
  ares: AresLike,
  firstName: string,
  surname: string,
  excludeIco: string,
): Promise<Array<{ ico: string; name?: string }>> {
  try {
    const r = await ares.search({ obchodniJmeno: `${firstName} ${surname}`, pocet: 20 });
    return r.ekonomickeSubjekty
      .filter((s) => s.ico && s.ico !== excludeIco)
      .map((s) => ({ ico: s.ico, name: s.obchodniJmeno }));
  } catch {
    return [];
  }
}

/**
 * Confirms a candidate person is actually in the target company's statutory
 * body. Used to filter out remaining false positives where ARES name search
 * returned a company that happens to have someone-with-similar-name in name
 * (or unrelated company). Returns true only if first-name + surname match
 * an active statutory member of the bankrupt company.
 */
async function verifyPersonIsStatutory(
  ares: AresLike,
  ico: string,
  firstName: string,
  surname: string,
): Promise<boolean> {
  try {
    const vr = await ares.getVrRecord(ico);
    if (!vr?.statutarniOrgany) return false;
    const fnLower = firstName.toLowerCase();
    const snLower = surname.toLowerCase();
    for (const organ of vr.statutarniOrgany) {
      if (organ.datumVymazu) continue;
      for (const m of organ.clenoveOrganu ?? []) {
        if (m.datumVymazu) continue;
        const fo = m.fyzickaOsoba;
        if (!fo) continue;
        const fn = (fo.jmeno ?? '').toLowerCase();
        const sn = (fo.prijmeni ?? '').toLowerCase();
        if (fn === fnLower && sn === snLower) return true;
      }
    }
    return false;
  } catch {
    return false;
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
