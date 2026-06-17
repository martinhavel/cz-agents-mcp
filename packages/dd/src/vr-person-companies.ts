import type { VrLike } from './clients.js';

export type PersonCompaniesConfidenceTier = 'HIGH' | 'LOW';

export interface PersonCompanyRole {
  ico: string;
  name: string | null;
  role: string | null;
  share_type: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: string | null;
  registered_at: string | null;
  deleted_at: string | null;
  member_ico: string | null;
  member_company_name: string | null;
}

export interface PersonCompaniesPerson {
  person_id: string;
  full_name: string;
  given_name: string | null;
  family_name: string | null;
  birth_year: number | null;
  confidence: {
    tier: PersonCompaniesConfidenceTier;
    score: number;
    basis: 'NAME_AND_BIRTH_YEAR' | 'NAME_ONLY';
  };
  namesake_flag: boolean;
  distinguisher: string;
  companies: PersonCompanyRole[];
}

export interface PersonCompaniesResult {
  query: {
    name: string;
    birth_year?: number;
  };
  persons: PersonCompaniesPerson[];
  namesake_flag: boolean;
}

export const PERSON_COMPANIES_SQL = `
WITH input AS (
  SELECT
    lower(trim($1::text)) AS q_name,
    $2::int AS q_birth_year
),
matched_persons AS (
  SELECT
    p.id,
    p.full_name,
    p.given_name,
    p.family_name,
    p.birth_date,
    CASE
      WHEN i.q_birth_year IS NOT NULL
       AND p.birth_date IS NOT NULL
       AND extract(year FROM p.birth_date)::int = i.q_birth_year
        THEN 'HIGH'
      ELSE 'LOW'
    END AS confidence_tier,
    CASE
      WHEN i.q_birth_year IS NOT NULL
       AND p.birth_date IS NOT NULL
       AND extract(year FROM p.birth_date)::int = i.q_birth_year
        THEN 0.95
      ELSE 0.50
    END AS confidence_score,
    CASE
      WHEN i.q_birth_year IS NOT NULL
       AND p.birth_date IS NOT NULL
       AND extract(year FROM p.birth_date)::int = i.q_birth_year
        THEN 'NAME_AND_BIRTH_YEAR'
      ELSE 'NAME_ONLY'
    END AS confidence_basis
  FROM vr.persons p
  CROSS JOIN input i
  WHERE lower(trim(p.full_name)) = i.q_name
    AND (
      i.q_birth_year IS NULL
      OR (
        p.birth_date IS NOT NULL
        AND extract(year FROM p.birth_date)::int = i.q_birth_year
      )
    )
),
person_counts AS (
  SELECT count(*)::int AS matched_person_count FROM matched_persons
),
person_roles AS (
  SELECT
    mp.id AS person_id,
    mp.full_name,
    mp.given_name,
    mp.family_name,
    extract(year FROM mp.birth_date)::int AS birth_year,
    mp.confidence_tier,
    mp.confidence_score,
    mp.confidence_basis,
    r.company_ico AS ico,
    c.name,
    r.role,
    r.share_type,
    r.valid_from,
    r.valid_to,
    c.status,
    c.registered_at,
    c.deleted_at,
    r.member_ico,
    mc.name AS member_company_name
  FROM matched_persons mp
  JOIN vr.roles r ON r.person_id = mp.id
  LEFT JOIN vr.companies c ON c.ico = r.company_ico
  LEFT JOIN vr.companies mc ON mc.ico = r.member_ico
  WHERE r.company_ico IS NOT NULL
)
SELECT
  pr.person_id::text,
  pr.full_name,
  pr.given_name,
  pr.family_name,
  pr.birth_year,
  pr.confidence_tier,
  pr.confidence_score,
  pr.confidence_basis,
  (pc.matched_person_count > 1) AS namesake_flag,
  concat(
    'person_id=', pr.person_id::text,
    coalesce(', birth_year=' || pr.birth_year::text, ', birth_year=unknown')
  ) AS distinguisher,
  jsonb_agg(
    jsonb_build_object(
      'ico', pr.ico,
      'name', pr.name,
      'role', pr.role,
      'share_type', pr.share_type,
      'valid_from', pr.valid_from,
      'valid_to', pr.valid_to,
      'status', pr.status,
      'registered_at', pr.registered_at,
      'deleted_at', pr.deleted_at,
      'member_ico', pr.member_ico,
      'member_company_name', pr.member_company_name
    )
    ORDER BY pr.valid_to NULLS FIRST, pr.valid_from DESC NULLS LAST, pr.ico
  ) AS companies
FROM person_roles pr
CROSS JOIN person_counts pc
GROUP BY
  pr.person_id,
  pr.full_name,
  pr.given_name,
  pr.family_name,
  pr.birth_year,
  pr.confidence_tier,
  pr.confidence_score,
  pr.confidence_basis,
  pc.matched_person_count
ORDER BY pr.full_name, pr.birth_year NULLS LAST, pr.person_id
LIMIT 200
`;

interface PersonCompaniesRow {
  person_id: string;
  full_name: string;
  given_name: string | null;
  family_name: string | null;
  birth_year: number | null;
  confidence_tier: PersonCompaniesConfidenceTier;
  confidence_score: string | number;
  confidence_basis: 'NAME_AND_BIRTH_YEAR' | 'NAME_ONLY';
  namesake_flag: boolean;
  distinguisher: string;
  companies: PersonCompanyRole[] | string;
}

export async function lookupPersonCompanies(
  vr: VrLike,
  input: { name: string; birthYear?: number },
): Promise<PersonCompaniesResult> {
  const cleanName = input.name.trim();
  const birthYear = input.birthYear ?? null;
  const result = await vr.query<PersonCompaniesRow>(PERSON_COMPANIES_SQL, [cleanName, birthYear]);
  const persons = result.rows.map((row) => ({
    person_id: row.person_id,
    full_name: row.full_name,
    given_name: row.given_name,
    family_name: row.family_name,
    birth_year: row.birth_year,
    confidence: {
      tier: row.confidence_tier,
      score: Number(row.confidence_score),
      basis: row.confidence_basis,
    },
    namesake_flag: row.namesake_flag,
    distinguisher: row.distinguisher,
    companies: parseCompanies(row.companies),
  }));

  return {
    query: {
      name: cleanName,
      ...(input.birthYear === undefined ? {} : { birth_year: input.birthYear }),
    },
    persons,
    namesake_flag: persons.some((p) => p.namesake_flag),
  };
}

function parseCompanies(companies: PersonCompanyRole[] | string): PersonCompanyRole[] {
  if (typeof companies === 'string') return JSON.parse(companies) as PersonCompanyRole[];
  return companies;
}
