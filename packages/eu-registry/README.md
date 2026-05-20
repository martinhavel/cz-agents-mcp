# @czagents/eu-registry

MCP server for non-Czech business registry lookup — company search and detail across 6 countries via free public APIs.

Part of the [cz-agents](https://cz-agents.dev) suite.

## Supported registries

| Country | Source | Notes |
|---------|--------|-------|
| GB | Companies House | Requires free `CH_API_KEY` from developer.company-information.service.gov.uk |
| SK | ORSR / RPO | No auth required |
| PL | KRS | No auth required |
| NL | GLEIF/LEI | No auth required — covers LEI-registered entities |
| DE | GLEIF/LEI | No auth required — covers LEI-registered entities |
| FR | SIRENE | No auth required |

## Tools

- `search_company(name, country?, limit?)` — search by company name across all or a single country. `country` is ISO 3166-1 alpha-2 (e.g. `"gb"`). Default limit 10, max 20.
- `get_company(id, country)` — fetch a company by national ID (CRN for GB, IČO for SK, KRS number for PL, LEI for NL/DE, SIREN for FR).

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `CH_API_KEY` | No | UK Companies House API key. Without it GB adapter returns empty results. |
| `GLEIF_CACHE_PATH` | No | Path to SQLite cache file for GLEIF responses (NL + DE). Falls back to in-memory if unset. |
| `GLEIF_CACHE_TTL_DAYS` | No | Cache TTL in days. Default: 7. |
| `PORT` | No | HTTP transport port. Default: 3036. |

## Usage

### npx (stdio transport)

```json
{
  "mcpServers": {
    "eu-registry": { "command": "npx", "args": ["-y", "@czagents/eu-registry"] }
  }
}
```

### Hosted endpoint (no install)

```json
{
  "mcpServers": {
    "eu-registry": { "url": "https://eu-registry.cz-agents.dev/mcp" }
  }
}
```

## Related packages

- [`@czagents/ares`](https://www.npmjs.com/package/@czagents/ares) — Czech ARES business registry
- [`@czagents/dd`](https://www.npmjs.com/package/@czagents/dd) — Czech due-diligence aggregator (includes `get_eu_parent` and `get_eu_dd_report` on Compliance tier)
- [`@czagents/sanctions`](https://www.npmjs.com/package/@czagents/sanctions) — EU FSF + OFAC sanctions screening

## Development

```bash
npm run build
npm test
npm run start:http
```
