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

- `check_ico_insolvency` — check whether a Czech company (by IČO) has an active insolvency proceeding. Returns spisová značka, start date, and current phase if found.
- `search_person_insolvency` — find an individual (FO) by name + optional date of birth (or birth number / IČO). Returns active oddlužení / osobní bankrot. Used to screen statutory persons in KYC/DD workflows.
- `poll_isir_events` — pull a batch of recent ISIR events since `since_id`. ISIR is an append-only feed (~1000 events per call). Use `last_id` from the response as the next `since_id`. Useful for compliance monitoring or back-filling an index.

Example prompts:

> Is IČO 12345678 in active insolvency?

> Search ISIR for a person born 1980-05-15 named Jan Novák.

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
