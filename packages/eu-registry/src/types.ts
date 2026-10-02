export type CompanyStatus = 'active' | 'dissolved' | 'unknown';

export interface Company {
  id: string;
  country: string;
  name: string;
  status: CompanyStatus;
  address?: string;
  registered_on?: string;
  lei?: string;
  source_url?: string;
  /** The official source label, retained when no unambiguous shared status exists. */
  status_label?: string;
  /** `active` only when the national source is unequivocal; otherwise null. */
  normalized_status?: 'active' | null;
  /** Publication time of the source snapshot, distinct from local ingestion time. */
  source_snapshot_at?: string;
  /** Time this service successfully ingested the source snapshot. */
  ingested_at?: string;
  source_attribution?: string;
  source_note?: string;
  source_publication?: string;
  /** DK CVR: reklamebeskyttet — entity opted out of marketing use. License term
   *  (Erhvervsstyrelsen declaration): data of such entities MUST NOT be used for
   *  unsolicited advertising. Lookup/DD display is fine; propagate so consumers can comply. */
  marketing_protected?: boolean;
}

export interface CompanySearchResult {
  companies: Company[];
  total_results: number;
}

export interface RegistryAdapter {
  searchByName(name: string, limit?: number): Promise<CompanySearchResult>;
  getById(id: string): Promise<Company | null>;
}
