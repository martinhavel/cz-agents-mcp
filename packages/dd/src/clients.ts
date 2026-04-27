/**
 * Wires dd to its underlying data sources via narrow structural interfaces.
 * Tests inject fakes implementing these shapes; production wires real
 * AresClient + SanctionsSearch instances which structurally satisfy them.
 *
 * Defining the shapes locally (rather than importing concrete classes)
 * keeps dd compilable in isolation and decouples it from ARES/sanctions
 * version bumps that don't change the consumed surface.
 */

export interface AresAddressLike {
  textovaAdresa?: string;
  nazevUlice?: string;
  cisloDomovni?: number;
  cisloOrientacni?: string;
  nazevObce?: string;
  nazevCastiObce?: string;
  psc?: number;
  kodObce?: number;
  kodAdresnihoMista?: number;
}

export interface AresStatutoryMember {
  fyzickaOsoba?: {
    jmeno?: string;
    prijmeni?: string;
    titulPredJmenem?: string;
    titulZaJmenem?: string;
    datumNarozeni?: string;
    statniObcanstvi?: string;
    adresa?: AresAddressLike;
  };
  pravnickaOsoba?: {
    obchodniJmeno?: string;
    ico?: string;
  };
  funkce?: { nazev?: string };
  datumZapisu?: string;
  datumVymazu?: string;
}

export interface AresStatutoryOrgan {
  nazevOrganu?: string;
  datumZapisu?: string;
  datumVymazu?: string;
  clenoveOrganu?: AresStatutoryMember[];
}

export interface AresVrLike {
  ico: string;
  obchodniJmeno?: string;
  spisovaZnacka?: string;
  rejstrik?: string;
  stavSubjektu?: string;
  datumZapisu?: string;
  statutarniOrgany?: AresStatutoryOrgan[];
}

export interface AresSubjectLike {
  ico: string;
  obchodniJmeno?: string;
  dic?: string;
  sidlo?: {
    textovaAdresa?: string;
    nazevObce?: string;
    nazevUlice?: string;
    psc?: number;
  };
  pravniForma?: string;
  datumVzniku?: string;
  datumZaniku?: string;
  financniUrad?: string;
  czNace?: string[];
}

export interface AresBankAccountLike {
  cisloUctu: string;
  kodBanky: string;
  menaUctu?: string;
}

export interface AresSearchHit {
  ico: string;
  obchodniJmeno?: string;
}

export interface AresSearchResultLike {
  pocetCelkem: number;
  ekonomickeSubjekty: AresSearchHit[];
}

export interface AresLike {
  getByIco(ico: string): Promise<AresSubjectLike | null>;
  getBankAccounts(ico: string): Promise<AresBankAccountLike[]>;
  getVrRecord(ico: string): Promise<AresVrLike | null>;
  search(params: {
    query?: string;
    obchodniJmeno?: string;
    sidlo?: { nazevUlice?: string; nazevObce?: string; psc?: number };
    pocet?: number;
  }): Promise<AresSearchResultLike>;
}

export interface SanctionsMatch {
  entity: {
    id: string;
    source: string;
    primary_name: string;
    type: string;
  };
  confidence: number;
  matched_on: string;
  matched_alias?: string;
}

export interface SanctionsLike {
  searchByName(
    name: string,
    opts?: {
      typeFilter?: 'person' | 'entity';
      threshold?: number;
      limit?: number;
      nationality?: string;
      dob?: string;
    },
  ): SanctionsMatch[];
  searchByIco(ico: string, fallbackName?: string): SanctionsMatch[];
}

export interface IsirPersonHit {
  spisova_znacka: string;
  jmeno_osoby?: string;
  datum_narozeni?: string;
  druh_stav_konkursu?: string;
  url_detail?: string;
}

export interface IsirLike {
  /** Returns null if ISIR can't determine status; tool degrades gracefully. */
  checkActiveInsolvency(
    ico: string,
  ): Promise<{ has_active: boolean; spisova_znacka?: string; started_on?: string; phase?: string } | null>;

  /** Optional: search insolvency by person name + DOB. May not be implemented by all clients. */
  searchPersonInsolvency?(input: {
    name: string;
    dob?: string;
    onlyActive?: boolean;
  }): Promise<IsirPersonHit[]>;
}

export interface AdisPayerStatusLike {
  dic: string;
  ico: string | null;
  reliability: 'ANO' | 'NE' | 'NENALEZEN';
  subject_type?: 'PLATCE_DPH' | 'IDENTIFIKOVANA_OSOBA' | 'SKUPINA_DPH' | 'NESPOLEHLIVA_OSOBA' | 'NENALEZEN';
  unreliable_since?: string;
  tax_office?: string;
  accounts: Array<{ formatted: string; predcisli?: string; cislo: string; kod_banky: string }>;
}

export interface AdisLike {
  /** Returns null when DIČ is not in the VAT registry, or when ADIS is in stub mode. */
  checkPayer(input: { ico?: string; dic?: string }): Promise<AdisPayerStatusLike | null>;
}

export interface DdClients {
  ares: AresLike;
  sanctions?: SanctionsLike;
  isir?: IsirLike;
  adis?: AdisLike;
}
