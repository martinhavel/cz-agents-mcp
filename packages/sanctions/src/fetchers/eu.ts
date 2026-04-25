/**
 * EU Financial Sanctions consolidated list parser.
 *
 * Source: webgate.ec.europa.eu/fsd/fsf — XML export, free, requires bound token
 * (URL pattern: .../public/files/xmlFullSanctionsList_1_1/content?token=<TOKEN>)
 *
 * Schema reference (EU FSF 1.1):
 *   <export ...>
 *     <sanctionEntity euReferenceNumber="..." designationDate="2022-02-25">
 *       <subjectType code="P|E"/>
 *       <nameAlias firstName="..." lastName="..." wholeName="..." function="..."/>
 *       <birthdate birthdate="1965-03-12" country="..."/>
 *       <citizenship countryDescription="..." region="..."/>
 *       <address street="..." city="..." countryDescription="..."/>
 *       <identification documentType="passport" number="..." countryDescription="..."/>
 *       <regulation programme="..."/>
 *     </sanctionEntity>
 *   </export>
 */
import { XMLParser } from 'fast-xml-parser';
import type { SanctionAddress, SanctionedEntity, SanctionId } from '../types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  isArray: (name) => ['sanctionEntity', 'nameAlias', 'birthdate', 'citizenship', 'address', 'identification', 'regulation'].includes(name),
});

interface RawSanctionEntity {
  '@_euReferenceNumber'?: string;
  '@_designationDate'?: string;
  '@_logicalId'?: string;
  subjectType?: { '@_code'?: string };
  nameAlias?: Array<{
    '@_firstName'?: string;
    '@_middleName'?: string;
    '@_lastName'?: string;
    '@_wholeName'?: string;
    '@_function'?: string;
    '@_nameLanguage'?: string;
  }>;
  birthdate?: Array<{ '@_birthdate'?: string; '@_year'?: string; '@_country'?: string }>;
  citizenship?: Array<{ '@_countryDescription'?: string; '@_region'?: string }>;
  address?: Array<{
    '@_street'?: string;
    '@_city'?: string;
    '@_zipCode'?: string;
    '@_region'?: string;
    '@_countryDescription'?: string;
    '@_country'?: string;
  }>;
  identification?: Array<{
    '@_documentType'?: string;
    '@_number'?: string;
    '@_country'?: string;
    '@_countryDescription'?: string;
  }>;
  regulation?: Array<{ '@_programme'?: string }>;
  remark?: string;
}

export function parseEu(xml: string): SanctionedEntity[] {
  const tree = parser.parse(xml) as { export?: { sanctionEntity?: RawSanctionEntity[] } };
  const raws = tree.export?.sanctionEntity ?? [];
  const out: SanctionedEntity[] = [];
  for (const r of raws) {
    const e = mapEntity(r);
    if (e) out.push(e);
  }
  return out;
}

function mapEntity(r: RawSanctionEntity): SanctionedEntity | null {
  const sourceListId =
    r['@_logicalId'] ?? r['@_euReferenceNumber'] ?? '';
  if (!sourceListId) return null;

  const aliasRaw = r.nameAlias ?? [];
  if (aliasRaw.length === 0) return null;

  // Pick whole-name in latin script as primary, fallback to constructed
  const primary =
    aliasRaw.find((a) => a['@_wholeName'] && (a['@_nameLanguage'] === undefined || a['@_nameLanguage'] === 'EN'))
      ?? aliasRaw[0];
  const primaryName = primary?.['@_wholeName']?.trim()
    || joinName(primary?.['@_firstName'], primary?.['@_middleName'], primary?.['@_lastName']);
  if (!primaryName) return null;

  const aliases: string[] = [];
  for (const a of aliasRaw) {
    const whole = a['@_wholeName']?.trim();
    if (whole && whole !== primaryName) aliases.push(whole);
    const built = joinName(a['@_firstName'], a['@_middleName'], a['@_lastName']);
    if (built && built !== primaryName && !aliases.includes(built)) aliases.push(built);
  }

  const dobs = (r.birthdate ?? [])
    .map((b) => b['@_birthdate'] || b['@_year'])
    .filter((s): s is string => Boolean(s));

  const nationalities = (r.citizenship ?? [])
    .map((c) => c['@_countryDescription'])
    .filter((s): s is string => Boolean(s));

  const addresses: SanctionAddress[] = (r.address ?? []).map((a) => ({
    street: attrOrUndef(a['@_street']),
    city: attrOrUndef(a['@_city']),
    region: attrOrUndef(a['@_region']),
    postal_code: attrOrUndef(a['@_zipCode']),
    country: a['@_country'] ?? a['@_countryDescription'],
  }));

  const ids: SanctionId[] = (r.identification ?? [])
    .filter((i) => i['@_number'])
    .map((i) => ({
      type: i['@_documentType'] ?? 'document',
      value: i['@_number']!.trim(),
      country: i['@_country'] ?? i['@_countryDescription'],
    }));

  const programs = (r.regulation ?? [])
    .map((p) => p['@_programme'])
    .filter((s): s is string => Boolean(s))
    .map((s) => `EU.${s}`);

  const code = r.subjectType?.['@_code'];
  const type: SanctionedEntity['type'] = code === 'P' ? 'person' : 'entity';

  return {
    id: `eu:${sourceListId}`,
    source: 'eu',
    source_list_id: sourceListId,
    type,
    primary_name: primaryName,
    aliases,
    dobs: dobs.length > 0 ? dobs : undefined,
    nationalities: nationalities.length > 0 ? nationalities : undefined,
    addresses: addresses.length > 0 ? addresses : undefined,
    ids: ids.length > 0 ? ids : undefined,
    programs,
    listed_on: r['@_designationDate'],
    remarks: r.remark,
    raw: r,
  };
}

function attrOrUndef(v: string | undefined): string | undefined {
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function joinName(...parts: Array<string | undefined>): string {
  return parts.filter((p) => p && p.trim().length > 0).join(' ').trim();
}
