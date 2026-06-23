const GLEIF_API = 'https://api.gleif.org/api/v1';

export interface GleifFullRecord {
  lei: string;
  name: string;
  status: 'active' | 'dissolved' | 'unknown';
  country: string;
  jurisdiction: string;
  registered_as?: string;
  address?: string;
  created_on?: string;
  source_url: string;
}

export interface GleifMatch {
  lei: string;
  name: string;
  country: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  name_match_score: number;
  source_url: string;
}

export interface GleifRegistrationMatch extends GleifMatch {
  registered_as?: string;
}

const LEGAL_SUFFIXES = /\b(s\.r\.o\.?|a\.s\.?|spol\. s r\.o\.?|k\.s\.?|v\.o\.s\.?|gmbh|ag|ltd|limited|bv|nv|sa|se|plc|oy|ab|as|llc|inc|corp|sàrl|srl|spa|aps|asa)\b\.?/gi;

function normalize(name: string): string {
  return name.toLowerCase().replace(LEGAL_SUFFIXES, '').replace(/[,.\s]+/g, ' ').trim();
}

function computeConfidence(aresName: string, gleifName: string): { confidence: 'HIGH' | 'MEDIUM' | 'LOW'; score: number } {
  const a = normalize(aresName);
  const g = normalize(gleifName);

  if (!a || !g) return { confidence: 'LOW', score: 0 };
  if (a === g) return { confidence: 'HIGH', score: 1.0 };

  // One name fully contained in the other (e.g. "Siemens" in "Siemens s.r.o.")
  if (a.includes(g) || g.includes(a)) return { confidence: 'MEDIUM', score: 0.85 };

  // Word overlap (ignore short words < 3 chars)
  const aWords = new Set(a.split(' ').filter((w) => w.length >= 3));
  const gWords = g.split(' ').filter((w) => w.length >= 3);
  if (gWords.length === 0) return { confidence: 'LOW', score: 0 };
  const matched = gWords.filter((w) => aWords.has(w)).length;
  const score = matched / gWords.length;

  if (score >= 0.66) return { confidence: 'MEDIUM', score };
  if (score >= 0.33) return { confidence: 'LOW', score };
  return { confidence: 'LOW', score };
}

export async function getByLei(lei: string): Promise<GleifFullRecord | null> {
  try {
    const url = new URL(`${GLEIF_API}/lei-records/${encodeURIComponent(lei)}`);
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/vnd.api+json' },
    });
    if (!res.ok) return null;

    const json = await res.json() as { data?: Record<string, unknown> };
    const record = json.data;
    if (!record) return null;

    const attrs = record.attributes as Record<string, unknown> | undefined;
    const entity = attrs?.entity as Record<string, unknown> | undefined;
    const name = (entity?.legalName as Record<string, unknown> | undefined)?.name as string ?? '';
    const jurisdiction = (entity?.jurisdiction as string) ?? '';
    if (!name) return null;

    return {
      lei: record.id as string,
      name,
      status: mapGleifStatus(entity?.status as string | undefined),
      country: jurisdiction.toLowerCase().slice(0, 2),
      jurisdiction,
      registered_as: entity?.registeredAs as string | undefined,
      address: formatGleifAddress(entity?.legalAddress as Record<string, unknown> | undefined),
      created_on: (entity?.creationDate as string | undefined)?.slice(0, 10),
      source_url: `https://search.gleif.org/#/record/${record.id}`,
    };
  } catch {
    return null;
  }
}

function mapGleifStatus(status: string | undefined): 'active' | 'dissolved' | 'unknown' {
  const s = status?.toUpperCase();
  if (s === 'ACTIVE') return 'active';
  if (s === 'INACTIVE') return 'dissolved';
  return 'unknown';
}

function formatGleifAddress(addr: Record<string, unknown> | undefined): string | undefined {
  if (!addr) return undefined;
  const lines = (addr.addressLines as string[] | undefined) ?? [];
  const parts = [...lines, addr.postalCode as string | undefined, addr.city as string | undefined]
    .filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export async function lookupGleifParent(companyName: string): Promise<GleifMatch | null> {
  try {
    const url = new URL(`${GLEIF_API}/lei-records`);
    url.searchParams.set('filter[fulltext]', companyName);
    url.searchParams.set('page[size]', '5');

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/vnd.api+json' },
    });
    if (!res.ok) return null;

    const json = await res.json() as { data?: unknown[] };
    const records = json.data;
    if (!Array.isArray(records) || records.length === 0) return null;

    const scored = (records as Array<Record<string, unknown>>)
      .map((r) => {
        const attrs = r.attributes as Record<string, unknown> | undefined;
        const entity = attrs?.entity as Record<string, unknown> | undefined;
        const gleifName = (entity?.legalName as Record<string, unknown> | undefined)?.name as string ?? '';
        const country = ((entity?.jurisdiction as string) ?? '').toLowerCase();
        const { confidence, score } = computeConfidence(companyName, gleifName);
        return {
          lei: r.id as string,
          name: gleifName,
          country,
          confidence,
          name_match_score: Math.round(score * 100) / 100,
          source_url: `https://search.gleif.org/#/record/${r.id}`,
        };
      })
      .filter((m) => m.name_match_score > 0)
      .sort((a, b) => b.name_match_score - a.name_match_score);

    return scored[0] ?? null;
  } catch {
    return null;
  }
}

export async function lookupGleifByRegistrationNumber(
  registrationNumber: string,
  expectedName?: string,
): Promise<GleifRegistrationMatch | null> {
  const clean = registrationNumber.trim();
  if (!clean) return null;
  try {
    const url = new URL(`${GLEIF_API}/lei-records`);
    url.searchParams.set('filter[entity.registeredAs]', clean);
    url.searchParams.set('page[size]', '5');

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/vnd.api+json' },
    });
    if (!res.ok) return null;

    const json = await res.json() as { data?: unknown[] };
    const records = json.data;
    if (!Array.isArray(records) || records.length === 0) return null;

    const scored = (records as Array<Record<string, unknown>>)
      .map((r) => {
        const attrs = r.attributes as Record<string, unknown> | undefined;
        const entity = attrs?.entity as Record<string, unknown> | undefined;
        const gleifName = (entity?.legalName as Record<string, unknown> | undefined)?.name as string ?? '';
        const country = ((entity?.jurisdiction as string) ?? '').toLowerCase();
        const { confidence, score } = expectedName
          ? computeConfidence(expectedName, gleifName)
          : { confidence: 'HIGH' as const, score: 1 };
        return {
          lei: r.id as string,
          name: gleifName,
          country,
          confidence,
          name_match_score: Math.round(score * 100) / 100,
          registered_as: entity?.registeredAs as string | undefined,
          source_url: `https://search.gleif.org/#/record/${r.id}`,
        };
      })
      .filter((m) => m.name)
      .sort((a, b) => b.name_match_score - a.name_match_score);

    return scored[0] ?? null;
  } catch {
    return null;
  }
}
