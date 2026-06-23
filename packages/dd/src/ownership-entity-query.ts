import { vrBaseClient } from './vr-client.js';

export interface OwnershipEntityEdge {
  src_ico: string;
  dst_ico: string;
  canonical_key: string;
  role_types: string[];
}

export interface OwnershipEntityNetwork {
  network_size: number;
  shared_role_link_count: number;
  coverage: number;
  edges: OwnershipEntityEdge[];
  collapsed_hubs: string[];
}

interface QueryClient {
  query<T>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

interface FirstHopRow {
  canonical_key: string;
  role_types: string[] | null;
}

interface DegreeRow {
  canonical_key: string;
  company_count: string | number | null;
}

interface TwoHopRow {
  company_ico: string;
  canonical_key: string;
  role_types: string[] | null;
}

const FIRST_HOP_SQL = `
SELECT e.canonical_key, e.role_types
FROM vr.company_entity_edge e
LEFT JOIN vr.person_entity pe ON pe.canonical_key = e.canonical_key
WHERE e.company_ico = $1
ORDER BY e.canonical_key
`;

const DEGREE_SQL = `
SELECT canonical_key, company_count
FROM vr.entity_degree
WHERE canonical_key = ANY($1::text[])
`;

const TWO_HOP_SQL = `
SELECT DISTINCT e.company_ico, e.canonical_key, e.role_types
FROM vr.company_entity_edge e
WHERE e.canonical_key = ANY($1::text[])
  AND e.company_ico <> $2
ORDER BY e.company_ico, e.canonical_key
`;

let overrideClient: QueryClient | undefined;

export function setOwnershipEntityQueryClientForTests(client: QueryClient | undefined): void {
  overrideClient = client;
}

export async function getCompanyNetwork(
  ico: string,
  opts: { maxDegree?: number; maxNodes?: number } = {},
): Promise<OwnershipEntityNetwork> {
  const cleanIco = ico.trim();
  const maxDegree = opts.maxDegree ?? 50;
  const maxNodes = opts.maxNodes ?? 200;
  const client = overrideClient ?? vrBaseClient;
  if (!client) {
    throw new Error('vr_base_client_unavailable');
  }

  const firstHopResult = await client.query<FirstHopRow>(FIRST_HOP_SQL, [cleanIco]);
  const firstHop = firstHopResult.rows;
  const canonicalKeys = firstHop.map((row) => row.canonical_key);
  if (canonicalKeys.length === 0) {
    return emptyNetwork();
  }

  const degreeResult = await client.query<DegreeRow>(DEGREE_SQL, [canonicalKeys]);
  const degreeByKey = new Map(
    degreeResult.rows.map((row) => [row.canonical_key, Number(row.company_count ?? 0)]),
  );
  const collapsedHubs: string[] = [];
  const nonHubKeys: string[] = [];
  for (const row of firstHop) {
    const companyCount = degreeByKey.get(row.canonical_key) ?? 0;
    if (companyCount > maxDegree) {
      collapsedHubs.push(row.canonical_key);
    } else {
      nonHubKeys.push(row.canonical_key);
    }
  }

  const twoHopRows = nonHubKeys.length === 0
    ? []
    : (await client.query<TwoHopRow>(TWO_HOP_SQL, [nonHubKeys, cleanIco])).rows;

  const companiesByIco = new Map<string, OwnershipEntityEdge[]>();
  for (const row of twoHopRows) {
    if (!companiesByIco.has(row.company_ico) && companiesByIco.size >= maxNodes) {
      continue;
    }
    const edges = companiesByIco.get(row.company_ico) ?? [];
    edges.push({
      src_ico: cleanIco,
      dst_ico: row.company_ico,
      canonical_key: row.canonical_key,
      role_types: row.role_types ?? [],
    });
    companiesByIco.set(row.company_ico, edges);
  }

  const edges = [...companiesByIco.values()].flat();
  const companyCoverage = twoHopRows.length === 0
    ? 1
    : companiesByIco.size / new Set(twoHopRows.map((row) => row.company_ico)).size;
  const entityCoverage = canonicalKeys.length === 0 ? 0 : nonHubKeys.length / canonicalKeys.length;

  return {
    network_size: 1 + new Set(canonicalKeys).size + companiesByIco.size,
    shared_role_link_count: firstHop.length + edges.length,
    coverage: roundCoverage(entityCoverage * companyCoverage),
    edges,
    collapsed_hubs: collapsedHubs,
  };
}

function emptyNetwork(): OwnershipEntityNetwork {
  return {
    network_size: 0,
    shared_role_link_count: 0,
    coverage: 0,
    edges: [],
    collapsed_hubs: [],
  };
}

function roundCoverage(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 10000) / 10000;
}
