import type { Company, CompanySearchResult, RegistryAdapter } from '../types.js';
import { lookupCompanyByVat, parseVat } from '../vies.js';
import { GleifAdapter } from './de-gleif.js';

export class ViesGleifAdapter implements RegistryAdapter {
  constructor(
    private readonly country: string,
    private readonly gleif: GleifAdapter,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async searchByName(name: string, limit = 10): Promise<CompanySearchResult> {
    return this.gleif.searchByName(name, limit);
  }

  async getById(id: string): Promise<Company | null> {
    const vat = parseVat(id) ? id : `${this.country}${id}`;
    const parsed = parseVat(vat);
    if (!parsed || parsed.country !== this.country.toLowerCase()) return null;
    return lookupCompanyByVat(parsed.vat, this.fetchImpl);
  }
}
