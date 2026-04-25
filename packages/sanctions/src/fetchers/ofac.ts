/**
 * OFAC SDN list parser.
 *
 * Source: home.treasury.gov / sanctionslistservice.ofac.treas.gov — XML, free, daily.
 * Schema reference (SDN.XML simplified subset):
 *   <sdnList>
 *     <sdnEntry>
 *       <uid>12345</uid>
 *       <firstName>...</firstName>
 *       <lastName>...</lastName>
 *       <sdnType>Individual|Entity|Vessel|Aircraft</sdnType>
 *       <programList><program>SDGT</program></programList>
 *       <akaList><aka><type>a.k.a.</type><lastName>...</lastName><firstName>...</firstName></aka></akaList>
 *       <addressList><address><address1>...</address1><city>...</city><country>...</country></address></addressList>
 *       <dateOfBirthList><dateOfBirthItem><dateOfBirth>1965</dateOfBirth></dateOfBirthItem></dateOfBirthList>
 *       <nationalityList><nationality><country>...</country></nationality></nationalityList>
 *       <idList><id><idType>Passport</idType><idNumber>X1234</idNumber><idCountry>...</idCountry></id></idList>
 *     </sdnEntry>
 *   </sdnList>
 */
import { XMLParser } from 'fast-xml-parser';
import type { SanctionAddress, SanctionedEntity, SanctionId } from '../types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  isArray: (name) =>
    [
      'sdnEntry',
      'aka',
      'address',
      'dateOfBirthItem',
      'nationality',
      'id',
      'program',
    ].includes(name),
});

interface RawSdnEntry {
  uid?: string | number;
  sdnType?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  programList?: { program?: string[] };
  akaList?: {
    aka?: Array<{
      type?: string;
      category?: string;
      firstName?: string;
      lastName?: string;
    }>;
  };
  addressList?: {
    address?: Array<{
      address1?: string;
      address2?: string;
      city?: string;
      stateOrProvince?: string;
      postalCode?: string;
      country?: string;
    }>;
  };
  dateOfBirthList?: {
    dateOfBirthItem?: Array<{ dateOfBirth?: string }>;
  };
  nationalityList?: {
    nationality?: Array<{ country?: string }>;
  };
  idList?: {
    id?: Array<{
      idType?: string;
      idNumber?: string | number;
      idCountry?: string;
    }>;
  };
  remarks?: string;
}

export function parseOfac(xml: string): SanctionedEntity[] {
  const tree = parser.parse(xml) as { sdnList?: { sdnEntry?: RawSdnEntry[] } };
  const raws = tree.sdnList?.sdnEntry ?? [];
  const out: SanctionedEntity[] = [];
  for (const r of raws) {
    const mapped = mapEntry(r);
    if (mapped) out.push(mapped);
  }
  return out;
}

function mapEntry(r: RawSdnEntry): SanctionedEntity | null {
  const uid = r.uid !== undefined ? String(asString(r.uid) ?? r.uid) : '';
  if (!uid) return null;

  const primaryName = joinName(asString(r.firstName), asString(r.lastName));
  if (!primaryName) return null;

  const aliases: string[] = [];
  for (const aka of r.akaList?.aka ?? []) {
    const name = joinName(asString(aka.firstName), asString(aka.lastName));
    if (name && name !== primaryName && !aliases.includes(name)) aliases.push(name);
  }

  const dobs = (r.dateOfBirthList?.dateOfBirthItem ?? [])
    .map((d) => asString(d.dateOfBirth))
    .filter((s): s is string => Boolean(s));

  const nationalities = (r.nationalityList?.nationality ?? [])
    .map((n) => asString(n.country))
    .filter((s): s is string => Boolean(s));

  const addresses: SanctionAddress[] = (r.addressList?.address ?? []).map((a) => ({
    street: joinAddressLines(asString(a.address1), asString(a.address2)),
    city: asString(a.city),
    region: asString(a.stateOrProvince),
    postal_code: asString(a.postalCode),
    country: asString(a.country),
  }));

  const ids: SanctionId[] = (r.idList?.id ?? [])
    .filter((i) => i.idNumber !== undefined && i.idNumber !== null)
    .map((i) => ({
      type: asString(i.idType) ?? 'document',
      value: String(asString(i.idNumber) ?? i.idNumber).trim(),
      country: asString(i.idCountry),
    }));

  const programs = (r.programList?.program ?? [])
    .map((p) => asString(p))
    .filter((s): s is string => Boolean(s))
    .map((s) => `OFAC.${s}`);

  const sdnType = (asString(r.sdnType) ?? 'Entity').toLowerCase();
  const type: SanctionedEntity['type'] =
    sdnType === 'individual'
      ? 'person'
      : sdnType === 'vessel'
        ? 'vessel'
        : sdnType === 'aircraft'
          ? 'aircraft'
          : 'entity';

  return {
    id: `ofac:${uid}`,
    source: 'ofac',
    source_list_id: uid,
    type,
    primary_name: primaryName,
    aliases,
    dobs: dobs.length > 0 ? dobs : undefined,
    nationalities: nationalities.length > 0 ? nationalities : undefined,
    addresses: addresses.length > 0 ? addresses : undefined,
    ids: ids.length > 0 ? ids : undefined,
    programs,
    remarks: asString(r.remarks),
    raw: r,
  };
}

function joinName(...parts: Array<unknown>): string {
  return parts
    .map((p) => (typeof p === 'string' ? p.trim() : typeof p === 'number' ? String(p) : ''))
    .filter((s) => s.length > 0)
    .join(' ')
    .trim();
}

function joinAddressLines(...parts: Array<unknown>): string | undefined {
  const strs = parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((s) => s.length > 0);
  return strs.length > 0 ? strs.join(', ') : undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    const t = (v as Record<string, unknown>)['#text'];
    return typeof t === 'string' ? t : typeof t === 'number' ? String(t) : undefined;
  }
  return undefined;
}
