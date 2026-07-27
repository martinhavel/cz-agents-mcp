# @czagents/isir

Czech insolvency register (ISIR) lookups — check whether a company or person has active or historical insolvency proceedings, bankruptcy, or debt-relief filings. Direct monitoring and lookup from the official Ministry of Justice register. Essential for vendor and counterparty risk checks.

## Status

`v0.x` is alpha — the direct SOAP integration is in progress and current responses may be empty for some queries. Behaviour is expected to stabilise during the `0.x` line; the surface (tool names, schemas) is settled.

## Install

```bash
npm install -g @czagents/isir
```

## Usage with Claude Desktop

```json
{
  "mcpServers": {
    "isir": {
      "command": "npx",
      "args": ["-y", "@czagents/isir"],
      "env": {
        "ISIR_SOAP_ENABLED": "1"
      }
    }
  }
}
```

## Tools

### `check_ico_insolvency`

Use it to check whether a Czech company identified by IČO has an active ISIR insolvency proceeding. Do not use a clean result as a historical insolvency screen: this tool checks active proceedings only, and an unavailable/unconfigured service yields no verdict.

```json
{"ico":"26168685"}
```

### `search_person_insolvency`

Use it to search an individual by name, preferably with date of birth, for active personal insolvency proceedings; set `only_active` to `false` to include closed or dismissed cases. Do not use a name alone for an identity-critical decision when the person has a common name; provide the date of birth or verify manually.

```json
{"name":"Jan Novák","dob":"1980-05-15","only_active":true}
```

### `poll_isir_events`

Use it to consume the append-only ISIR event feed for monitoring or index backfill, advancing the next request with the returned `last_id`. Do not use it to answer an ad-hoc question about one company or person; use the dedicated lookup tool.

```json
{"since_id":0}
```

## Self-host

Source: https://github.com/martinhavel/cz-agents-mcp

```bash
git clone https://github.com/martinhavel/cz-agents-mcp
cd cz-agents-mcp
npm install
npm run build
ISIR_SOAP_ENABLED=1 node packages/isir/dist/index.js
```

## Free tier & pricing

ISIR itself is a free public service. The hosted endpoint at `https://isir.cz-agents.dev/mcp` is rate-limited per IP. Higher limits and commercial use: https://cz-agents.dev/pricing

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
