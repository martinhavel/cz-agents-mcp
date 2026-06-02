# @czagents/cnb

Official Czech National Bank (ČNB) exchange rates — daily and historical CZK rates against EUR, USD, and 30+ currencies. Direct from the central bank, the authoritative source for accounting and invoicing in the Czech Republic.

## Install

```bash
npm install -g @czagents/cnb
```

## Usage with Claude Desktop

```json
{
  "mcpServers": {
    "cnb": {
      "command": "npx",
      "args": ["-y", "@czagents/cnb"]
    }
  }
}
```

## Tools

- `get_rates` — full daily FX sheet (~31 majors). Optional `date` (YYYY-MM-DD) for historical rates; otherwise latest.
- `convert` — convert an amount between two currencies via the official CZK cross-rate. Optional `date` for historical conversion.
- `get_rate` — single-currency lookup; returns just the CZK rate for one currency code.

Example prompts:

> What's the CZK/EUR rate today?

> Convert 100 USD to CZK at the rate from 2024-01-15.

## Self-host

Source: https://github.com/martinhavel/cz-agents-mcp

```bash
git clone https://github.com/martinhavel/cz-agents-mcp
cd cz-agents-mcp
npm install
npm run build
node packages/cnb/dist/index.js
```

## Free tier & pricing

ČNB exposes the rate sheet for free. The hosted endpoint at `https://cnb.cz-agents.dev/mcp` is rate-limited per IP. Higher limits and commercial use: https://cz-agents.dev/pricing

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
