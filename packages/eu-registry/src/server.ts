import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logToolCall, wrapServerTools } from '@czagents/shared';
import { UkCompaniesHouseAdapter } from './adapters/uk-companies-house.js';
import { SkOrsrAdapter } from './adapters/sk-orsr.js';
import { PlKrsAdapter } from './adapters/pl-krs.js';
import { FrSireneAdapter } from './adapters/fr-sirene.js';
import { GleifAdapter, DeGleifAdapter } from './adapters/de-gleif.js';
import { GleifCache } from './gleif-cache.js';
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
        'Supports GB (Companies House), SK (ORSR), PL (KRS), NL (GLEIF/LEI), DE (GLEIF/LEI), FR (SIRENE). ' +
        'This server does not handle Czech registry lookups.',
    },
  );
  wrapServerTools(server);

  const gleifCache = buildGleifCache();
  const adapters = options.adapters ?? {
    gb: new UkCompaniesHouseAdapter(),
    sk: new SkOrsrAdapter(),
    pl: new PlKrsAdapter(),
    nl: new GleifAdapter('NL', globalThis.fetch, gleifCache),
    de: new DeGleifAdapter(globalThis.fetch, gleifCache),
    fr: new FrSireneAdapter(),
  };

  server.tool(
    'search_company',
    'Search non-Czech business registries by company name. Supported: GB (Companies House), SK (ORSR/RPO), PL (KRS), NL (GLEIF/LEI), DE (GLEIF/LEI), FR (SIRENE).',
    {
      name: z.string().min(1).describe('Company name or partial company name.'),
      country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. "gb".').optional(),
      limit: z.number().int().min(1).max(20).default(10).describe('Max results per search, default 10, max 20.'),
    },
    { title: 'Search Non-Czech Company', readOnlyHint: true, openWorldHint: true },
    async ({ name, country, limit }) => {
      const normalizedCountry = country?.toLowerCase();
      const cappedLimit = Math.min(Math.max(limit ?? 10, 1), 20);
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
    'Get a non-Czech company by national ID and country code. Supported: gb (CRN), sk (IČO), pl (KRS number), nl (LEI), de (LEI), fr (SIREN).',
    {
      id: z.string().min(1).describe('National company ID, e.g. UK Companies House CRN "14356670".'),
      country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. "gb".'),
    },
    { title: 'Get Non-Czech Company', readOnlyHint: true, openWorldHint: true },
    async ({ id, country }) => {
      const normalizedCountry = country.toLowerCase();
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
