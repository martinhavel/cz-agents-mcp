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

### `get_rates`

Use it to obtain the full ČNB daily currency sheet, either latest or for a valid historical ISO date. Do not use it when only one currency rate is needed; use `get_rate`.

```json
{"date":"2024-01-15"}
```

### `convert`

Use it to convert a numeric amount between ISO 4217 currencies with ČNB’s official daily rates, including a historical date when necessary. Do not use it for a rate quotation without an amount; use `get_rate`.

```json
{"amount":100,"from":"USD","to":"CZK","date":"2024-01-15"}
```

### `get_rate`

Use it to retrieve one currency’s official CZK rate from the latest or a historical ČNB sheet. Do not use it for a cross-currency conversion such as USD to EUR; use `convert`.

```json
{"code":"EUR","date":"2024-01-15"}
```

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

ČNB exposes the rate sheet for free. The hosted endpoint at `https://cnb.cz-agents.dev/mcp` is rate-limited per IP. Higher limits and commercial use: https://cz-agents.dev/pricing.html

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
