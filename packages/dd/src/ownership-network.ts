import { vrClient } from './vr-client.js';

export interface OwnershipNetworkFreeResult {
  ico: string;
  network_size: number;
  shared_role_link_count: number;
  coverage_pct: number;
  as_of: string | null;
  _teaser: true;
}

interface SummaryRow {
  ico: string;
  network_size: number;
  shared_role_link_count: number;
  coverage_pct: string | number;
  as_of: string | Date | null;
}

const SUMMARY_SQL = `
SELECT ico, network_size, shared_role_link_count, coverage_pct, as_of
FROM vr.company_network_summary
WHERE ico = $1
`;

export async function getOwnershipNetwork(
  ico: string,
  opts: { level: 'summary' },
): Promise<OwnershipNetworkFreeResult> {
  void opts;
  const cleanIco = ico.trim();
  if (!vrClient) {
    throw new Error('vr_client_unavailable');
  }

  const summaryResult = await vrClient.query<SummaryRow>(SUMMARY_SQL, [cleanIco]);
  const summary = summaryResult.rows[0];
  if (!summary) {
    throw new Error(`ownership_network_not_found:${cleanIco}`);
  }

  return {
    ico: summary.ico,
    network_size: Number(summary.network_size),
    shared_role_link_count: Number(summary.shared_role_link_count),
    coverage_pct: Number(summary.coverage_pct),
    as_of: formatIsoDate(summary.as_of),
    _teaser: true,
  };
}

function formatIsoDate(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}
