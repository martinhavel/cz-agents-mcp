import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { entityIdUnitKey, logToolCall, queryUnitKey, trackQuery, wrapServerTools } from '@czagents/shared';
import { UkCompaniesHouseAdapter } from './adapters/uk-companies-house.js';
import { SkOrsrAdapter } from './adapters/sk-orsr.js';
import { PlKrsAdapter } from './adapters/pl-krs.js';
import { FrSireneAdapter } from './adapters/fr-sirene.js';
import { GleifAdapter, DeGleifAdapter } from './adapters/de-gleif.js';
import { ViesGleifAdapter } from './adapters/vies-gleif.js';
import { NoBrregAdapter } from './adapters/no-brreg.js';
import { DkCvrAdapter } from './adapters/dk-cvr.js';
import { FiPrhAdapter } from './adapters/fi-prh.js';
import { EeRikAdapter } from './adapters/ee-rik.js';
import { SeBolagsverketAdapter } from './adapters/se-bolagsverket.js';
import { GleifCache } from './gleif-cache.js';
import { lookupCompanyByVat, parseVat } from './vies.js';
import type { Company, RegistryAdapter } from './types.js';

export type RegistryAdapters = Record<string, RegistryAdapter>;

export interface EuRegistryServerOptions {
  adapters?: RegistryAdapters;
  authorizeLookup?: RegistryLookupAuthorizer;
  vatLookup?: typeof lookupCompanyByVat;
}

export interface RegistryLookupRequest {
  country: string;
  tool: 'search_company' | 'get_company' | 'lookup_company_by_vat';
  depth: 'basic';
}

export interface RegistryLookupAccess {
  upstreamAllowed: boolean;
  country?: string;
  error?: unknown;
  record?: (upstreamCalled:boolean, options?: { ctaSuppressed?: boolean })=>void;
}

export type RegistryLookupAuthorizer = (request:RegistryLookupRequest)=>RegistryLookupAccess|Promise<RegistryLookupAccess>;

export function buildEuRegistryServer(options: EuRegistryServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/eu-registry',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Non-Czech business registry lookup. Use for companies outside the Czech Republic. ' +
        'Supports GB (Companies House), SK (ORSR), PL (KRS), NL/IT/AT/ES/BE/LT (VIES VAT lookup + GLEIF/LEI name search), DE (GLEIF/LEI), FR (SIRENE), NO (BRREG), DK (CVR), FI (PRH YTJ), EE (RIK open data), SE (Bolagsverket exact lookup + GLEIF name search). ' +
        'This server does not handle Czech registry lookups.',
    },
  );
  wrapServerTools(server);

  const gleifCache = buildGleifCache();
  const adapters = options.adapters ?? {
    gb: new UkCompaniesHouseAdapter(),
    sk: new SkOrsrAdapter(),
    pl: new PlKrsAdapter(),
    nl: new ViesGleifAdapter('nl', new GleifAdapter('NL', globalThis.fetch, gleifCache)),
    it: new ViesGleifAdapter('it', new GleifAdapter('IT', globalThis.fetch, gleifCache)),
    at: new ViesGleifAdapter('at', new GleifAdapter('AT', globalThis.fetch, gleifCache)),
    es: new ViesGleifAdapter('es', new GleifAdapter('ES', globalThis.fetch, gleifCache)),
    be: new ViesGleifAdapter('be', new GleifAdapter('BE', globalThis.fetch, gleifCache)),
    lt: new ViesGleifAdapter('lt', new GleifAdapter('LT', globalThis.fetch, gleifCache)),
    de: new DeGleifAdapter(globalThis.fetch, gleifCache),
    fr: new FrSireneAdapter(),
    no: new NoBrregAdapter(),
    dk: new DkCvrAdapter(),
    fi: new FiPrhAdapter(),
    ee: new EeRikAdapter(),
    se: new SeBolagsverketAdapter({
      searchAdapter: new GleifAdapter('SE', globalThis.fetch, gleifCache),
    }),
  };

  server.tool(
    'search_company',
    'Search non-Czech business registries by company name. Supported: GB (Companies House), SK (ORSR/RPO), PL (KRS), NL/IT/AT/ES/BE/LT (GLEIF/LEI only; exact VAT data via lookup_company_by_vat or get_company with VAT), DE (GLEIF/LEI), FR (SIRENE), NO (BRREG), DK (CVR), FI (PRH YTJ), EE (RIK open data), SE (GLEIF/LEI name search; use get_company for full Bolagsverket data).',
    {
      name: z.string().min(1).describe('Company name or partial company name.'),
      country: z.string().min(2).max(64).describe('ISO alpha-2 code or supported country name, e.g. "GB", "UK", or "United Kingdom".').optional(),
      limit: z.number().int().min(1).max(20).default(10).describe('Max results per search, default 10, max 20.'),
    },
    { title: 'Search Non-Czech Company', readOnlyHint: true, openWorldHint: true },
    async ({ name, country, limit }) => {
      let normalizedCountry = country === undefined ? undefined : normalizeRegistryCountry(country,adapters);
      if (country !== undefined && !normalizedCountry) {
        const decision=await authorize(options.authorizeLookup,{country,tool:'search_company',depth:'basic'});
        const resolved=decision.country?.toLowerCase();
        if(decision.upstreamAllowed && resolved && adapters[resolved])normalizedCountry=resolved;
        else {decision.record?.(false);return decision.error ? accessErrorResult(decision.error):invalidCountryResult(country);}
      }
      const cappedLimit = Math.min(Math.max(limit ?? 10, 1), 20);
      trackQuery(queryUnitKey({ name, country: normalizedCountry, limit: cappedLimit }));
      logToolCall('eu-registry', 'search_company', { name, country: normalizedCountry, limit: cappedLimit });

      const selected = Object.entries(adapters).filter(([adapterCountry]) => {
        if (normalizedCountry && adapterCountry !== normalizedCountry) return false;
        return true;
      });

      const access = await Promise.all(selected.map(async ([adapterCountry,adapter])=>({
        adapterCountry,adapter,decision:await authorize(options.authorizeLookup,{country:adapterCountry,tool:'search_company',depth:'basic'}),
      })));
      const allowed=access.filter((item)=>item.decision.upstreamAllowed);
      if (normalizedCountry && allowed.length===0) {
        const denied=access[0]!.decision; denied.record?.(false); return accessErrorResult(denied.error);
      }
      // Fanning out across every non-selected country adapter: each denied adapter still
      // gets its own entitlement_check/upstream_avoided event (per-country demand signal),
      // but the user sees one response with one combined coverage_preview — so only the
      // first denial should surface as an upgrade_cta, not one per blocked country.
      let ctaEmitted = false;
      for (const item of access) {
        if (item.decision.upstreamAllowed) continue;
        item.decision.record?.(false, ctaEmitted ? { ctaSuppressed: true } : undefined);
        ctaEmitted = true;
      }
      const results = await Promise.all(allowed.map(async ({adapter,decision}) => {
        try { return await adapter.searchByName(name,cappedLimit); }
        finally { decision.record?.(true); }
      }));
      const companies = results.flatMap((result) => result.companies).slice(0, cappedLimit);
      const total_results = results.reduce((sum, result) => sum + result.total_results, 0);

      const coverage_preview=access.filter((item)=>!item.decision.upstreamAllowed).map((item)=>({
        country:item.adapterCountry.toUpperCase(),connector_available:true,coverage_tier:'extended',
        available_field_categories:['identity','registry_status'],upgrade_cta:item.decision.error,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ companies, total_results,
          ...(coverage_preview.length>0 ? {coverage_preview}: {}) }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_company',
    'Get a non-Czech company by national ID and country code. Supported: gb (CRN), sk (IČO), pl (KRS number), nl/it/at/es/be/lt (VAT via VIES), de (LEI), fr (SIREN), no (organization number), dk (CVR number), fi (Business ID), ee (registry code), se (10-digit organisation number via Bolagsverket).',
    {
      id: z.string().min(1).describe('National company ID, e.g. UK Companies House CRN "14356670".'),
      country: z.string().min(2).max(64).describe('ISO alpha-2 code or supported country name.'),
    },
    { title: 'Get Non-Czech Company', readOnlyHint: true, openWorldHint: true },
    async ({ id, country }) => {
      let normalizedCountry = normalizeRegistryCountry(country,adapters);
      if (!normalizedCountry) {
        const decision=await authorize(options.authorizeLookup,{country,tool:'get_company',depth:'basic'});
        const resolved=decision.country?.toLowerCase();
        if(decision.upstreamAllowed && resolved && adapters[resolved])normalizedCountry=resolved;
        else {decision.record?.(false);return decision.error ? accessErrorResult(decision.error):invalidCountryResult(country);}
      }
      trackQuery(entityIdUnitKey(normalizedCountry, id));
      logToolCall('eu-registry', 'get_company', { id, country: normalizedCountry });

      const decision=await authorize(options.authorizeLookup,{country:normalizedCountry,tool:'get_company',depth:'basic'});
      if(!decision.upstreamAllowed){decision.record?.(false);return accessErrorResult(decision.error);}
      let company:Company|null;
      try { company=await getCompany(adapters,id,normalizedCountry); }
      finally { decision.record?.(true); }
      if (!company) {
        return {
          content: [
            {
              type: 'text',
              text: `No company ${id} found for country ${normalizedCountry}.`,
            },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(company, null, 2) }],
      };
    },
  );

  server.tool(
    'lookup_company_by_vat',
    'Free VIES VAT lookup. Returns VAT validity plus name/address when the member state discloses them; some countries such as ES/DE may return only validity.',
    {
      vat: z.string().min(3).describe('EU VAT number including ISO-2 country prefix, e.g. "NL123456789B01".'),
    },
    { title: 'Lookup Company by VAT', readOnlyHint: true, openWorldHint: true },
    async ({ vat }) => {
      trackQuery(entityIdUnitKey('vat', vat));
      logToolCall('eu-registry', 'lookup_company_by_vat', { vat });

      const parsed=parseVat(vat);
      if(!parsed)return invalidCountryResult(vat);
      const normalizedCountry=normalizeVatCountry(parsed.country);
      if(!normalizedCountry)return invalidCountryResult(parsed.country);
      const decision=await authorize(options.authorizeLookup,{country:normalizedCountry,tool:'lookup_company_by_vat',depth:'basic'});
      if(!decision.upstreamAllowed){decision.record?.(false);return accessErrorResult(decision.error);}
      let company:Company|null;
      try { company=await (options.vatLookup ?? lookupCompanyByVat)(vat); }
      finally { decision.record?.(true); }
      if (!company) {
        return {
          content: [
            {
              type: 'text',
              text: `No VIES result found for VAT ${vat}.`,
            },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(company, null, 2) }],
      };
    },
  );

  return server;
}

async function authorize(authorizer:RegistryLookupAuthorizer|undefined,request:RegistryLookupRequest):Promise<RegistryLookupAccess> {
  return authorizer ? authorizer(request) : {upstreamAllowed:true};
}

function accessErrorResult(error:unknown) {
  const body=error ?? {error:'access_denied',message:'The hosted lookup is not available.'};
  return {content:[{type:'text' as const,text:JSON.stringify(body,null,2)}],isError:true};
}

function invalidCountryResult(input:string) {
  return accessErrorResult({error:'invalid_country',dimension:'coverage',input,
    message:'Unknown or unsupported country. Use a supported ISO alpha-2 code or country name.'});
}

function normalizeRegistryCountry(input:string,adapters:RegistryAdapters):string|null {
  const value=input.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleUpperCase('en-US');
  const aliases:Record<string,string>={UK:'GB','UNITED KINGDOM':'GB','GREAT BRITAIN':'GB',
    SLOVAKIA:'SK',POLAND:'PL',NETHERLANDS:'NL','THE NETHERLANDS':'NL',ITALY:'IT',AUSTRIA:'AT',
    SPAIN:'ES',GERMANY:'DE',FRANCE:'FR',NORWAY:'NO',DENMARK:'DK',FINLAND:'FI',ESTONIA:'EE',SWEDEN:'SE',
    BELGIUM:'BE',LITHUANIA:'LT'};
  const canonical=aliases[value] ?? value;
  const key=canonical.toLowerCase(); return adapters[key] ? key : null;
}

function normalizeVatCountry(input:string):string|null {
  const value=input.normalize('NFKC').trim().toUpperCase();
  if(!/^[A-Z]{2}$/.test(value))return null;
  // VIES uses EL for Greece. Hosted policy remains ISO-based and therefore sees GR.
  if(value==='EL')return 'gr';
  if(value==='UK')return 'gb';
  return value.toLowerCase();
}

async function getCompany(
  adapters: RegistryAdapters,
  id: string,
  country: string,
): Promise<Company | null> {
  const adapter = adapters[country];
  if (!adapter) return null;
  return adapter.getById(id);
}

function buildGleifCache(): GleifCache {
  const dbPath = process.env['GLEIF_CACHE_PATH'];
  const ttlDays = Number(process.env['GLEIF_CACHE_TTL_DAYS'] ?? 7);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 7) * 24 * 3600 * 1000;
  const cache = new GleifCache(dbPath, ttlMs);
  cache.prune();
  return cache;
}
