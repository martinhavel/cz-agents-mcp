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
import { GleifCache } from './gleif-cache.js';
import { lookupCompanyByVat } from './vies.js';
import type { Company, RegistryAdapter } from './types.js';

export type RegistryAdapters = Record<string, RegistryAdapter>;

export interface EuRegistryServerOptions {
  adapters?: RegistryAdapters;
}

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
        'Supports GB (Companies House), SK (ORSR), PL (KRS), NL/IT/AT/ES (VIES VAT lookup + GLEIF/LEI name search), DE (GLEIF/LEI), FR (SIRENE), NO (BRREG), DK (CVR), FI (PRH YTJ). ' +
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
    de: new DeGleifAdapter(globalThis.fetch, gleifCache),
    fr: new FrSireneAdapter(),
    no: new NoBrregAdapter(),
    dk: new DkCvrAdapter(),
    fi: new FiPrhAdapter(),
  };

  server.tool(
    'search_company',
    'Search non-Czech business registries by company name. Supported: GB (Companies House), SK (ORSR/RPO), PL (KRS), NL/IT/AT/ES (GLEIF/LEI only; exact VAT data via lookup_company_by_vat or get_company with VAT), DE (GLEIF/LEI), FR (SIRENE), NO (BRREG), DK (CVR), FI (PRH YTJ).',
    {
      name: z.string().min(1).describe('Company name or partial company name.'),
      country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. "gb".').optional(),
      limit: z.number().int().min(1).max(20).default(10).describe('Max results per search, default 10, max 20.'),
    },
    { title: 'Search Non-Czech Company', readOnlyHint: true, openWorldHint: true },
    async ({ name, country, limit }) => {
      const normalizedCountry = country?.toLowerCase();
      const cappedLimit = Math.min(Math.max(limit ?? 10, 1), 20);
      trackQuery(queryUnitKey({ name, country: normalizedCountry, limit: cappedLimit }));
      logToolCall('eu-registry', 'search_company', { name, country: normalizedCountry, limit: cappedLimit });

      const selected = Object.entries(adapters).filter(([adapterCountry]) => {
        if (normalizedCountry && adapterCountry !== normalizedCountry) return false;
        return true;
      });

      const results = await Promise.all(
        selected.map(async ([, adapter]) => adapter.searchByName(name, cappedLimit)),
      );
      const companies = results.flatMap((result) => result.companies).slice(0, cappedLimit);
      const total_results = results.reduce((sum, result) => sum + result.total_results, 0);

      return {
        content: [{ type: 'text', text: JSON.stringify({ companies, total_results }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_company',
    'Get a non-Czech company by national ID and country code. Supported: gb (CRN), sk (IČO), pl (KRS number), nl/it/at/es (VAT via VIES), de (LEI), fr (SIREN), no (organization number), dk (CVR number), fi (Business ID).',
    {
      id: z.string().min(1).describe('National company ID, e.g. UK Companies House CRN "14356670".'),
      country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. "gb".'),
    },
    { title: 'Get Non-Czech Company', readOnlyHint: true, openWorldHint: true },
    async ({ id, country }) => {
      const normalizedCountry = country.toLowerCase();
      trackQuery(entityIdUnitKey(normalizedCountry, id));
      logToolCall('eu-registry', 'get_company', { id, country: normalizedCountry });

      const company = await getCompany(adapters, id, normalizedCountry);
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

      const company = await lookupCompanyByVat(vat);
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
