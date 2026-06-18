import type { VrLike } from './clients.js';

const MAX_DEPTH_LIMIT = 5;

export type OwnerKind = 'person' | 'company';
export type OwnerConfidenceTier = 'HIGH' | 'LOW';

export interface OwnerConfidence {
  tier: OwnerConfidenceTier;
  score: number;
  basis: 'NAME_AND_BIRTH_YEAR' | 'NAME_ONLY' | 'COMPANY_ICO';
  ambiguous: boolean;
}

export interface OwnerEntry {
  kind: OwnerKind;
  name: string | null;
  ico: string | null;
  person_id: string | null;
  birth_year: number | null;
  share: string | null;
  share_percent: number | null;
  type: string | null;
  role: string | null;
  valid_from: string | null;
  confidence: OwnerConfidence;
  namesake_flag: boolean;
}

export interface OwnershipNode {
  ico: string;
  name: string | null;
  depth: number;
  path: string[];
  cycle: boolean;
  owners: OwnerEntry[];
  children: OwnershipNode[];
}

export interface OwnersResult {
  query: {
    ico: string;
    max_depth: number;
  };
  as_of: string | null;
  source: 'vr';
  root: OwnershipNode;
  direct_owners: OwnerEntry[];
  chains: string[][];
  warnings: string[];
}

export const OWNERSHIP_ROLE_FILTER_SQL = `
  r.valid_to IS NULL
  AND r.share_type IS NOT NULL
  AND (
    r.share_type ILIKE '%spole%'
    OR r.share_type ILIKE '%akcion%'
  )
`;

export const OWNERS_SQL = `
WITH RECURSIVE owner_nodes_raw AS (
  SELECT
    c.ico,
    c.name,
    c.source_dataset,
    0::int AS depth,
    ARRAY[c.ico]::text[] AS path,
    false AS cycle
  FROM vr.companies c
  WHERE c.ico = $1

  UNION ALL

  SELECT
    owner_edge.member_ico AS ico,
    mc.name,
    mc.source_dataset,
    n.depth + 1 AS depth,
    n.path || owner_edge.member_ico,
    owner_edge.member_ico = ANY(n.path) AS cycle
  FROM owner_nodes_raw n
  JOIN LATERAL (
    SELECT DISTINCT r.member_ico
    FROM vr.roles r
    WHERE r.company_ico = n.ico
      AND ${OWNERSHIP_ROLE_FILTER_SQL}
      AND r.member_ico IS NOT NULL
  ) owner_edge ON true
  LEFT JOIN vr.companies mc ON mc.ico = owner_edge.member_ico
  WHERE n.depth < $2
    AND n.cycle = false
),
owner_nodes AS (
  SELECT DISTINCT ON (path) *
  FROM owner_nodes_raw
  ORDER BY path, depth
),
person_name_counts AS (
  SELECT
    p.full_name,
    extract(year FROM p.birth_date)::int AS birth_year,
    count(*)::int AS same_name_birth_year_count
  FROM vr.persons p
  JOIN (
    SELECT DISTINCT
      owner_person.full_name,
      extract(year FROM owner_person.birth_date)::int AS birth_year
    FROM owner_nodes n
    JOIN vr.roles r ON r.company_ico = n.ico AND ${OWNERSHIP_ROLE_FILTER_SQL}
    JOIN vr.persons owner_person ON owner_person.id = r.person_id
    WHERE r.member_ico IS NULL
  ) owner_names
    ON owner_names.full_name = p.full_name
   AND owner_names.birth_year IS NOT DISTINCT FROM extract(year FROM p.birth_date)::int
  GROUP BY p.full_name, extract(year FROM p.birth_date)::int
)
SELECT
  n.ico,
  n.name,
  n.source_dataset,
  n.depth,
  n.path,
  n.cycle,
  asof.finished_at AS as_of,
  COALESCE(o.owners, '[]'::jsonb) AS owners
FROM owner_nodes n
LEFT JOIN LATERAL (
  SELECT il.finished_at
  FROM vr.import_log il
  WHERE il.dataset = n.source_dataset
    AND il.status = 'done'
  ORDER BY il.finished_at DESC NULLS LAST
  LIMIT 1
) asof ON true
LEFT JOIN LATERAL (
  -- Dedup vlastníků na IDENTITU (member_ico u firem; jméno+rok u osob/cizích
  -- entit). VR raw data mají duplicitní role řádky (re-ingest + historie) lišící
  -- se valid_from/role → DISTINCT na celém objektu je NEsloučí. DISTINCT ON
  -- identitu, bereme nejnovější záznam (valid_from DESC).
  SELECT jsonb_agg(d.owner_obj) AS owners
  FROM (
    SELECT DISTINCT ON (COALESCE(r.member_ico, lower(trim(p.full_name)) || '|' || COALESCE(extract(year FROM p.birth_date)::text, '')))
      jsonb_build_object(
        'kind', CASE WHEN r.member_ico IS NULL THEN 'person' ELSE 'company' END,
        'name', COALESCE(mc.name, p.full_name),
        'ico', r.member_ico,
        'person_id', CASE WHEN r.member_ico IS NULL THEN p.id::text ELSE NULL END,
        'birth_year', CASE WHEN r.member_ico IS NULL THEN extract(year FROM p.birth_date)::int ELSE NULL END,
        'share', r.share_type,
        'type', split_part(r.share_type, ' | ', 1),
        'role', r.role,
        'valid_from', r.valid_from,
        'namesake_flag', CASE WHEN r.member_ico IS NULL THEN COALESCE(pnc.same_name_birth_year_count, 0) > 1 ELSE false END
      ) AS owner_obj
    FROM vr.roles r
    LEFT JOIN vr.persons p ON p.id = r.person_id
    LEFT JOIN vr.companies mc ON mc.ico = r.member_ico
    LEFT JOIN person_name_counts pnc
      ON pnc.full_name = p.full_name
     AND pnc.birth_year IS NOT DISTINCT FROM extract(year FROM p.birth_date)::int
    WHERE r.company_ico = n.ico
      AND ${OWNERSHIP_ROLE_FILTER_SQL}
      AND r.person_id IS NOT NULL
    ORDER BY COALESCE(r.member_ico, lower(trim(p.full_name)) || '|' || COALESCE(extract(year FROM p.birth_date)::text, '')),
             r.valid_from DESC NULLS LAST
  ) d
) o ON true
ORDER BY n.depth, n.path
`;

interface OwnersRow {
  ico: string;
  name: string | null;
  depth: number;
  path: string[] | string;
  cycle: boolean;
  as_of: string | null;
  owners: RawOwner[] | string;
}

interface RawOwner {
  kind: OwnerKind;
  name: string | null;
  ico: string | null;
  person_id: string | null;
  birth_year: number | null;
  share: string | null;
  type: string | null;
  role: string | null;
  valid_from: string | null;
  namesake_flag: boolean;
}

export async function lookupOwners(
  vr: VrLike,
  input: { ico: string; maxDepth?: number },
): Promise<OwnersResult> {
  const ico = input.ico.trim();
  const maxDepth = Math.min(input.maxDepth ?? MAX_DEPTH_LIMIT, MAX_DEPTH_LIMIT);
  const result = await vr.query<OwnersRow>(OWNERS_SQL, [ico, maxDepth]);
  if (result.rows.length === 0) {
    throw new Error(`ico_not_found:${ico}`);
  }

  const nodes = result.rows.map(rowToNode);
  const root = buildTree(nodes);
  const warnings = collectWarnings(root);

  return {
    query: { ico, max_depth: maxDepth },
    as_of: result.rows.find((row) => row.depth === 0)?.as_of ?? null,
    source: 'vr',
    root,
    direct_owners: root.owners,
    chains: collectChains(root),
    warnings,
  };
}

export function buildOwnersMarkdown(result: OwnersResult): string {
  const rootName = result.root.name ?? result.root.ico;
  const lines = [
    `**Vlastníci: ${rootName} (${result.root.ico})**`,
    '',
    '| jméno/název | podíl | typ |',
    '|---|---:|---|',
  ];

  if (result.direct_owners.length === 0) {
    lines.push('| Nenalezen aktivní společník/akcionář ve VR datech | - | - |');
  } else {
    for (const owner of result.direct_owners) {
      lines.push(`| ${escapeCell(formatOwnerName(owner))} | ${escapeCell(owner.share ?? '-')} | ${escapeCell(owner.type ?? owner.role ?? '-')} |`);
    }
  }

  lines.push('', '**Vlastnický řetězec**');
  const chains = result.chains.filter((chain) => chain.length > 1);
  if (chains.length === 0) {
    lines.push('Bez nadřazené právnické osoby ve VR datech.');
  } else {
    for (const chain of chains) {
      lines.push(`- ${chain.join(' -> ')}`);
    }
  }

  if (result.warnings.includes('physical_person_ambiguity')) {
    lines.push('', 'Poznámka: U fyzických osob může dojít k záměně jmenovců; osoby jsou rozlišovány podle jména a roku narození, pokud je rok ve VR dostupný.');
  }

  lines.push('', `Zdroj: veřejný rejstřík (VR), data k ${result.as_of ?? 'neznámému datu'}`);
  return lines.join('\n');
}

function rowToNode(row: OwnersRow): OwnershipNode {
  const owners = parseOwners(row.owners).map(normalizeOwner);
  return {
    ico: row.ico,
    name: row.name,
    depth: row.depth,
    path: parsePath(row.path),
    cycle: row.cycle,
    owners,
    children: [],
  };
}

function buildTree(nodes: OwnershipNode[]): OwnershipNode {
  const byPath = new Map(nodes.map((node) => [pathKey(node.path), node]));
  const root = nodes.find((node) => node.depth === 0);
  if (!root) throw new Error('ownership_root_missing');

  for (const node of nodes) {
    if (node === root) continue;
    const parent = byPath.get(pathKey(node.path.slice(0, -1)));
    if (parent) parent.children.push(node);
  }

  return root;
}

function collectChains(root: OwnershipNode): string[][] {
  const chains: string[][] = [];
  const walk = (node: OwnershipNode, chain: string[]) => {
    const label = `${node.name ?? node.ico} (${node.ico})${node.cycle ? ' [cyklus]' : ''}`;
    const next = [...chain, label];
    if (node.children.length === 0) {
      chains.push(next);
      return;
    }
    for (const child of node.children) walk(child, next);
  };
  walk(root, []);
  return chains;
}

function collectWarnings(root: OwnershipNode): string[] {
  const warnings = new Set<string>();
  const visit = (node: OwnershipNode) => {
    if (node.owners.some((owner) => owner.kind === 'person')) warnings.add('physical_person_ambiguity');
    if (node.owners.some((owner) => owner.namesake_flag || owner.confidence.ambiguous)) warnings.add('namesake_ambiguity');
    for (const child of node.children) visit(child);
  };
  visit(root);
  return [...warnings];
}

function normalizeOwner(owner: RawOwner): OwnerEntry {
  const isCompany = owner.kind === 'company';
  const birthYear = owner.birth_year == null ? null : Number(owner.birth_year);
  const namesake = Boolean(owner.namesake_flag);
  const hasBirthYear = birthYear !== null;

  return {
    kind: owner.kind,
    name: owner.name,
    ico: owner.ico,
    person_id: owner.person_id,
    birth_year: birthYear,
    share: owner.share,
    share_percent: parseSharePercent(owner.share),
    type: owner.type,
    role: owner.role,
    valid_from: owner.valid_from,
    confidence: isCompany
      ? { tier: 'HIGH', score: 0.99, basis: 'COMPANY_ICO', ambiguous: false }
      : {
          tier: hasBirthYear && !namesake ? 'HIGH' : 'LOW',
          score: hasBirthYear && !namesake ? 0.95 : 0.5,
          basis: hasBirthYear ? 'NAME_AND_BIRTH_YEAR' : 'NAME_ONLY',
          ambiguous: namesake || !hasBirthYear,
        },
    namesake_flag: namesake,
  };
}

function parseOwners(owners: RawOwner[] | string): RawOwner[] {
  if (typeof owners === 'string') return JSON.parse(owners) as RawOwner[];
  return owners;
}

function parsePath(path: string[] | string): string[] {
  if (Array.isArray(path)) return path;
  if (path.startsWith('{') && path.endsWith('}')) {
    return path.slice(1, -1).split(',').filter(Boolean);
  }
  return JSON.parse(path) as string[];
}

function parseSharePercent(share: string | null): number | null {
  const match = share?.match(/([0-9]+(?:[,.][0-9]+)?)(?:\s*\/\s*([0-9]+(?:[,.][0-9]+)?))?\s*%+/);
  if (!match) return null;

  const numerator = Number(match[1]!.replace(',', '.'));
  const denominator = match[2] === undefined ? null : Number(match[2].replace(',', '.'));
  if (!Number.isFinite(numerator)) return null;
  if (denominator === null) return numerator;
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

function formatOwnerName(owner: OwnerEntry): string {
  const base = owner.name ?? owner.ico ?? 'Neznámý vlastník';
  if (owner.kind === 'person' && owner.birth_year !== null) return `${base} (nar. ${owner.birth_year})`;
  if (owner.kind === 'company' && owner.ico) return `${base} (${owner.ico})`;
  return base;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function pathKey(path: string[]): string {
  return path.join('>');
}
