import { getCompanyNetwork } from './ownership-entity-query.js';

export interface OwnershipNetworkFreeResult {
  ico: string;
  network_size: number;
  shared_role_link_count: number;
  coverage_pct: number;
  as_of: string | null;
  _teaser: true;
}

export async function getOwnershipNetwork(
  ico: string,
  opts: { level: 'summary' },
): Promise<OwnershipNetworkFreeResult> {
  void opts;
  const cleanIco = ico.trim();
  const summary = await getCompanyNetwork(cleanIco);

  return {
    ico: cleanIco,
    network_size: Number(summary.network_size),
    shared_role_link_count: Number(summary.shared_role_link_count),
    coverage_pct: Number(summary.coverage),
    as_of: summary.network_size === 0 ? null : currentIsoDate(),
    _teaser: true,
  };
}

function currentIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
