import type { VrLike } from './clients.js';

export type PersonRiskConfidenceTier = 'HIGH' | 'LOW';
export type PersonRiskClassification = 'shell-factory' | 'serial-liquidation' | 'mass-nominee' | 'clean';
export type PersonRiskFlag = 'serial-liquidation' | 'shell-factory' | null;

export interface PersonRiskMetrics {
  N: number;
  L: number;
  ln: number;
  batch: number;
}

export interface PersonRiskCompany {
  ico: string;
  name: string | null;
  status: string | null;
  registered_at: string | null;
  deleted_at: string | null;
  roles: string[];
}

export interface PersonRiskProfile {
  canonical_key: string;
  repr_full_name: string;
  confidence: PersonRiskConfidenceTier;
  namesake_flag: boolean;
  namesake_count: number;
  classification: PersonRiskClassification;
  score: number;
  requires_review: boolean;
  metrics: PersonRiskMetrics;
  triggers: string[];
  raw_companies: PersonRiskCompany[];
}

export interface PersonRiskInput {
  name: string;
  birthYear: number;
}

export const PERSON_RISK_ROLE_FILTER_SQL = `
    array_to_string(e.role_types, ' ') ~* '(jednatel|spole)'
    AND array_to_string(e.role_types, ' ') !~* '(likvid|insolven|správce|spravce)'
`;

// paid tool - ddplus tier
export const PERSON_RISK_SQL = `
WITH input AS (
  SELECT
    lower(trim($1::text)) AS q_name,
    $2::int AS q_birth_year
),
matched_persons AS (
  SELECT
    p.id,
    p.canonical_key,
    p.full_name,
    p.birth_date,
    CASE WHEN p.birth_date IS NOT NULL
         AND extract(year FROM p.birth_date)::int = i.q_birth_year THEN 'HIGH' ELSE 'LOW' END AS confidence_tier
  FROM vr.persons p
  CROSS JOIN input i
  WHERE (
        lower(trim(p.full_name)) = i.q_name
        OR lower(trim(coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, ''))) = i.q_name
        OR lower(trim(p.family_name)) = i.q_name
      )
    AND p.birth_date IS NOT NULL
    AND extract(year FROM p.birth_date)::int = i.q_birth_year
  LIMIT 8000
),
namesake AS (
  SELECT count(*)::int AS namesake_count
  FROM (
    SELECT 1 FROM matched_persons WHERE birth_date IS NOT NULL GROUP BY canonical_key
  ) t
),
identities AS (
  SELECT
    canonical_key,
    max(full_name) AS repr_full_name,
    max(confidence_tier) AS confidence_tier
  FROM matched_persons
  GROUP BY canonical_key
  ORDER BY max(full_name), canonical_key
  LIMIT 25
),
filtered_edges AS (
  SELECT DISTINCT
    id.canonical_key,
    id.repr_full_name,
    id.confidence_tier,
    e.company_ico,
    e.role_types,
    c.name,
    c.status,
    c.registered_at,
    c.deleted_at
  FROM identities id
  JOIN vr.company_entity_edge e ON e.canonical_key = id.canonical_key
  LEFT JOIN vr.companies c ON c.ico = e.company_ico
  WHERE ${PERSON_RISK_ROLE_FILTER_SQL}
),
metrics AS (
  SELECT
    fe.canonical_key,
    count(DISTINCT fe.company_ico)::int AS n,
    count(DISTINCT fe.company_ico) FILTER (
      WHERE fe.status = 'deleted' OR fe.name ILIKE '%likvidaci%'
    )::int AS l
  FROM filtered_edges fe
  GROUP BY fe.canonical_key
),
batch_windows AS (
  SELECT
    a.canonical_key,
    count(DISTINCT b.company_ico)::int AS batch_count
  FROM filtered_edges a
  JOIN filtered_edges b
    ON b.canonical_key = a.canonical_key
   AND a.registered_at IS NOT NULL
   AND b.registered_at IS NOT NULL
   AND b.registered_at >= a.registered_at
   AND b.registered_at <= a.registered_at + interval '45 days'
  GROUP BY a.canonical_key, a.company_ico
),
batch AS (
  SELECT canonical_key, coalesce(max(batch_count), 0)::int AS batch
  FROM batch_windows
  GROUP BY canonical_key
)
SELECT
  id.canonical_key,
  id.repr_full_name,
  id.confidence_tier,
  (SELECT namesake_count FROM namesake) AS namesake_count,
  coalesce(m.n, 0)::int AS n,
  coalesce(m.l, 0)::int AS l,
  coalesce(b.batch, 0)::int AS batch,
  coalesce(jsonb_agg(DISTINCT jsonb_build_object(
    'ico', fe.company_ico,
    'name', fe.name,
    'status', fe.status,
    'registered_at', fe.registered_at,
    'deleted_at', fe.deleted_at,
    'roles', fe.role_types
  )) FILTER (WHERE fe.company_ico IS NOT NULL), '[]'::jsonb) AS raw_companies
FROM identities id
LEFT JOIN metrics m ON m.canonical_key = id.canonical_key
LEFT JOIN batch b ON b.canonical_key = id.canonical_key
LEFT JOIN filtered_edges fe ON fe.canonical_key = id.canonical_key
GROUP BY
  id.canonical_key,
  id.repr_full_name,
  id.confidence_tier,
  m.n,
  m.l,
  b.batch
`;

interface PersonRiskRow {
  canonical_key: string;
  repr_full_name: string;
  confidence_tier: PersonRiskConfidenceTier;
  namesake_count: number;
  n: number;
  l: number;
  batch: number;
  raw_companies: PersonRiskCompany[] | string;
}

export function classifyPersonRisk(metrics: PersonRiskMetrics): {
  classification: PersonRiskClassification;
  score: number;
  requires_review: boolean;
} {
  const { N, ln, batch } = metrics;

  if (N > 40) {
    return {
      classification: 'mass-nominee',
      score: Math.min(100, 40 + Math.round(ln * 30)),
      requires_review: true,
    };
  }

  if (N >= 4 && N <= 40 && batch >= 3 && ln >= 0.5) {
    return {
      classification: 'shell-factory',
      score: Math.min(100, Math.min(batch, 12) * 5 + Math.round(ln * 40)),
      requires_review: false,
    };
  }

  if (N >= 5 && ln >= 0.85 && batch < 3) {
    return {
      classification: 'serial-liquidation',
      score: Math.min(100, Math.round(ln * 60) + Math.min(N, 10) * 2),
      requires_review: false,
    };
  }

  return {
    classification: 'clean',
    score: 0,
    requires_review: false,
  };
}

export function teaserRiskFlag(metrics: PersonRiskMetrics): PersonRiskFlag {
  const { classification } = classifyPersonRisk(metrics);
  if (classification === 'shell-factory' || classification === 'serial-liquidation') return classification;
  return null;
}

export function buildPersonRiskTriggers(
  metrics: PersonRiskMetrics,
  classification: PersonRiskClassification,
): string[] {
  const triggers: string[] = [];
  if (classification === 'clean') return triggers;

  if (metrics.N > 0 && metrics.L > 0) {
    triggers.push(`${metrics.L} z ${metrics.N} firem zlikvidováno`);
  }
  if (metrics.batch >= 3) {
    triggers.push(`${metrics.batch} firem založeno do 45 dnů`);
  }
  triggers.push('Počítány jen role jednatel/společník; likvidátoři a insolvenční správci jsou vyloučeni.');
  if (classification === 'mass-nominee') {
    triggers.push('Více než 40 firem u jedné canonical_key; vyžaduje kontrolu namesake/merge artefaktu.');
  }

  return triggers;
}

// Namesake-safe: a name+birth_year may resolve to MORE than one canonical_key
// (distinct people, same name + birth year). We return EVERY matched identity —
// never pick one silently — so callers cannot misattribute risk to the wrong namesake.
export async function assessPersonRisk(
  vr: VrLike,
  input: PersonRiskInput,
): Promise<PersonRiskProfile[]> {
  const cleanName = input.name.trim();
  const result = await vr.query<PersonRiskRow>(PERSON_RISK_SQL, [cleanName, input.birthYear]);

  return result.rows.map((row) => {
    const N = Number(row.n);
    const L = Number(row.l);
    const metrics = {
      N,
      L,
      ln: N === 0 ? 0 : L / N,
      batch: Number(row.batch),
    };
    const classification = classifyPersonRisk(metrics);

    return {
      canonical_key: row.canonical_key,
      repr_full_name: row.repr_full_name,
      confidence: row.confidence_tier,
      namesake_flag: row.namesake_count > 1,
      namesake_count: row.namesake_count,
      classification: classification.classification,
      score: classification.score,
      requires_review: classification.requires_review,
      metrics,
      triggers: buildPersonRiskTriggers(metrics, classification.classification),
      raw_companies: parseRawCompanies(row.raw_companies),
    };
  });
}

function parseRawCompanies(companies: PersonRiskCompany[] | string): PersonRiskCompany[] {
  if (typeof companies === 'string') return JSON.parse(companies) as PersonRiskCompany[];
  return companies;
}
