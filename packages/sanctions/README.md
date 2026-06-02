# @czagents/sanctions

Sanctions screening for KYC/AML — check Czech companies and individuals against EU Financial Sanctions (FSF) and US OFAC SDN lists. Per-entity and per-statutory-member checks. Official consolidated lists, updated from source.

## Install

```bash
npm install -g @czagents/sanctions
```

## Usage with Claude Desktop

```json
{
  "mcpServers": {
    "sanctions": {
      "command": "npx",
      "args": ["-y", "@czagents/sanctions"],
      "env": {
        "SANCTIONS_DB": "/absolute/path/to/sanctions.db"
      }
    }
  }
}
```

The local SQLite database is built by the bundled refresh CLI:

```bash
npx @czagents/sanctions-refresh
```

This fetches and normalizes the upstream lists into a single SQLite file. Re-run on a daily cron for fresh data.

## Tools

- `search_person` — fuzzy match a person by name across all loaded lists. Optional `dob` and `nationality` narrow results. Returns matches with confidence scores (0-100; 100 = exact ID match, 80+ = strong fuzzy match).
- `search_entity` — fuzzy-search a sanctioned entity (company, organization) by name, optionally narrowed by country.
- `check_ico` — direct exact-ID lookup of a Czech IČO; pass `name` to also fuzzy-match if no direct hit.
- `get_listing` — full record for a single listing by ID (`${source}:${source_list_id}`, e.g. `ofac:12345`).
- `list_recent_updates` — sanctions added/removed/modified since a given date — for daily watchlist monitoring.

Example prompts:

> Screen "Acme Imports s.r.o." against all sanctions lists.

> Is IČO 12345678 on any sanctions list?

## Self-host

Source: https://github.com/martinhavel/cz-agents-mcp

```bash
git clone https://github.com/martinhavel/cz-agents-mcp
cd cz-agents-mcp
npm install
npm run build
node packages/sanctions/dist/cli-refresh.js   # build sanctions.db
SANCTIONS_DB=$PWD/sanctions.db node packages/sanctions/dist/index.js
```

## Free tier & pricing

Free tier rate-limited. Higher limits and commercial use: https://cz-agents.dev/pricing

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
