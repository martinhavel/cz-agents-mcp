# @czagents/eu-registry

European business registry lookups in one MCP — verify companies across 13 EU/EEA countries via official national registries and GLEIF/LEI + VIES. Full national data for 9 countries; identity + ownership baseline for the rest. Entity status, registration data, addresses, parent-company resolution, and EU VAT validation. Built for cross-border due-diligence and KYC directly in your AI assistant.

Part of the [cz-agents](https://cz-agents.dev) suite.

## Supported registries

**Full national data** (entity, status, address, registration date):

| Country | Source | Notes |
|---------|--------|-------|
| GB | Companies House | Requires free `CH_API_KEY` from developer.company-information.service.gov.uk |
| SK | ORSR / RPO | No auth required |
| PL | KRS | No auth required |
| FR | SIRENE | No auth required |
| NO | Brønnøysund (BRREG) | No auth required |
| DK | CVR (Erhvervsstyrelsen) | Optional `DK_CVR_USER`/`DK_CVR_PASS` (free, request at cvrselvbetjening@erst.dk); public fallback otherwise |
| FI | PRH YTJ Open Data v3 | Free, no API key, CC BY 4.0 |
| EE | RIK open data dump | Daily bulk ingest to local SQLite via `EE_RIK_DB_PATH`; no API key, CC BY 4.0 |
| SE | Bolagsverket HVD API | Free OAuth credentials from Bolagsverket; exact organisation-number lookup. Name search uses GLEIF/LEI because HVD has no name-search endpoint. |

**Identity + ownership baseline** (name, address, status, VAT validity, GLEIF/LEI parent-company resolution — no officer/board data; for registries that are paywalled):

| Country | Source | Notes |
|---------|--------|-------|
| DE | GLEIF/LEI + VIES | No auth required |
| NL | GLEIF/LEI + VIES | No auth required |
| IT | GLEIF/LEI + VIES | No auth required |
| AT | GLEIF/LEI + VIES | No auth required |
| ES | GLEIF/LEI + VIES | VIES returns validity only for ES (no name/address) |

## Tools

- `search_company(name, country?, limit?)` — search by company name across all or a single country. `country` is ISO 3166-1 alpha-2 (e.g. `"gb"`). Default limit 10, max 20.
- `get_company(id, country)` — fetch a company by national ID (CRN for GB, IČO for SK, KRS number for PL, SIREN for FR, org.nr for NO, CVR number for DK, Business ID for FI, registry code for EE, Swedish organisation number for SE, LEI for DE/NL, VAT for IT/AT/ES/NL).
- `lookup_company_by_vat(vat)` — free EU VAT validation via VIES; returns validity plus registered name/address where the member state discloses them (ES/DE return validity only).

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `CH_API_KEY` | No | UK Companies House API key. Without it GB adapter returns empty results. |
| `GLEIF_CACHE_PATH` | No | Path to SQLite cache file for GLEIF responses (DE/NL/IT/AT/ES). Falls back to in-memory if unset. |
| `GLEIF_CACHE_TTL_DAYS` | No | Cache TTL in days. Default: 7. |
| `DK_CVR_USER` / `DK_CVR_PASS` | No | Denmark CVR data credentials (free, request at cvrselvbetjening@erst.dk). Without them the DK adapter uses its public fallback. |
| `EE_RIK_DB_PATH` | No | Path to SQLite store for Estonia RIK bulk data. Default: `./ee-rik.db`. |
| `SE_BOLAGSVERKET_CLIENT_ID` / `SE_BOLAGSVERKET_CLIENT_SECRET` | No | Sweden Bolagsverket HVD OAuth credentials. Without them exact SE lookups return no result; name search still uses GLEIF. |
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

Estonia bulk ingest:

```bash
EE_RIK_DB_PATH=/absolute/path/ee-rik.db npm run build --workspace=@czagents/eu-registry
EE_RIK_DB_PATH=/absolute/path/ee-rik.db npm run ingest:ee-rik --workspace=@czagents/eu-registry
```
