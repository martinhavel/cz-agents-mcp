import { Pool } from 'pg';
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

interface QueryClient {
  query<T>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

const VR_SUMMARY_SQL = `
SELECT ico, network_size, shared_role_link_count, coverage_pct, as_of
FROM vr.company_network_summary
WHERE ico = $1
`;

const CACHE_SUMMARY_SQL = `
SELECT ico, network_size, shared_role_link_count, coverage_pct, as_of
FROM ownership_cache.company_network_summary
WHERE ico = $1
`;

const FILL_REQUEST_SQL = `
INSERT INTO ownership_cache.fill_requests (ico)
VALUES ($1)
ON CONFLICT (ico) DO UPDATE
  SET last_requested = now(),
      request_count = fill_requests.request_count + 1
`;

const FILL_REQUEST_TIMEOUT_MS = 250;

let cacheClient: QueryClient | undefined;

export async function getOwnershipNetwork(
  ico: string,
  opts: { level: 'summary' },
): Promise<OwnershipNetworkFreeResult> {
  void opts;
  const cleanIco = ico.trim();
  const client = getSummaryClient();
  if (!client) {
    throw new Error('vr_client_unavailable');
  }

  let summaryResult: { rows: SummaryRow[] };
  try {
    summaryResult = await client.query<SummaryRow>(
      process.env.OWNERSHIP_CACHE_DATABASE_URL ? CACHE_SUMMARY_SQL : VR_SUMMARY_SQL,
      [cleanIco],
    );
  } catch (error) {
    if (isMissingTableError(error)) {
      captureCacheMiss(cleanIco, client);
      return emptyTeaser(cleanIco);
    }
    // Cache mode: a cache outage / connection error must NOT break the dd report.
    // Degrade to an empty teaser (graceful "preparing") and queue the fill.
    if (process.env.OWNERSHIP_CACHE_DATABASE_URL) {
      console.error('ownership teaser cache read failed; degrading to empty teaser', error);
      captureCacheMiss(cleanIco, client);
      return emptyTeaser(cleanIco);
    }
    throw error;
  }
  const summary = summaryResult.rows[0];
  if (!summary) {
    captureCacheMiss(cleanIco, client);
    return emptyTeaser(cleanIco);
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

function getSummaryClient(): QueryClient | undefined {
  const connectionString = process.env.OWNERSHIP_CACHE_DATABASE_URL;
  if (!connectionString) return vrClient;
  if (!cacheClient) {
    cacheClient = new Pool({ connectionString });
  }
  return cacheClient;
}

function captureCacheMiss(ico: string, client: QueryClient): void {
  if (!process.env.OWNERSHIP_CACHE_DATABASE_URL) return;
  try {
    void ignoreAfterTimeout(client.query(FILL_REQUEST_SQL, [ico]), FILL_REQUEST_TIMEOUT_MS);
  } catch {
    // Best-effort queue write: cache miss capture must not affect teaser reads.
  }
}

function ignoreAfterTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guarded = promise.then(() => undefined).catch(() => undefined);
  const timer = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
    if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
  });
  return Promise.race([guarded, timer]).then(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function isMissingTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === '42P01' || error.message.includes('does not exist');
}

function emptyTeaser(ico: string): OwnershipNetworkFreeResult {
  return {
    ico,
    network_size: 0,
    shared_role_link_count: 0,
    coverage_pct: 0,
    as_of: null,
    _teaser: true,
  };
}

function formatIsoDate(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}
