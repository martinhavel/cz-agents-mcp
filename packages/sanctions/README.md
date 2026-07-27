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

### `search_person`

Fuzzy-search a person across the loaded EU, OFAC and other sanctions lists. Use it for an individual name-screening step; add date of birth or nationality when you have them to reduce false positives. Do **not** use a low-confidence name-only match as a final sanctions decision — review the returned record and identifiers.

```json
{"name":"Jan Novak","dob":"1974-05-12","nationality":"CZ","threshold":80,"limit":20}
```

### `search_entity`

Fuzzy-search a company or organisation by name, optionally narrowed by country. Use it when you have a legal name but no reliable identifier. Do **not** use it for an exact Czech company-ID check; use `check_ico` instead.

```json
{"name":"Acme Imports s.r.o.","country":"CZ","threshold":80,"limit":20}
```

### `check_ico`

Check whether a Czech IČO, or another comparable company identifier, appears on the sanctions lists. Add `name` only as a fuzzy fallback when the identifier itself is not listed. Do **not** treat an empty result as a clean screening result if the server reports that its sanctions database is unavailable or stale.

```json
{"ico":"12345678","name":"Acme Imports s.r.o."}
```

### `get_listing`

Retrieve the complete source record for one sanctions-list entry returned by a search. Use it to inspect identifiers, aliases and source data before a human decision. Do **not** call it with a company IČO or person name; it accepts a listing ID such as `ofac:12345`.

```json
{"id":"ofac:12345"}
```

### `list_recent_updates`

Return sanctions entries added, removed or modified since a given time, optionally for one source. Use it to update an existing watchlist workflow. Do **not** use it to screen a particular customer portfolio: it is a global change feed, not a per-customer match.

```json
{"since":"2026-07-01","source":"eu"}
```

### `rescreen_portfolio` *(paid; available when x402 is enabled)*

Re-screen a supplied portfolio against changes in sanctions lists since its last screening and return only affected subjects. Use it for a watchlist you already maintain. Do **not** use it for a single person or company, or as a replacement for `list_recent_updates` when you need the global change feed.

```json
{"subjects":[{"ref":"customer-42","name":"Acme Imports s.r.o.","ico":"12345678"}],"since":"2026-07-01","source":"eu"}
```

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

Free tier rate-limited. Higher limits and commercial use: https://cz-agents.dev/pricing.html

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
