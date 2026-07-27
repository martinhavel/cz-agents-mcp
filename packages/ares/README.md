# @czagents/ares

Czech & Slovak business registry — look up companies by IČO, search by name, check legal form, address, and VAT status. Direct from ARES (Czech Ministry of Finance), the official source. Fast, free, no reseller markup.

## Install

```bash
npm install -g @czagents/ares
```

## Usage with Claude Desktop

```json
{
  "mcpServers": {
    "ares": {
      "command": "npx",
      "args": ["-y", "@czagents/ares"]
    }
  }
}
```

## Tools

### `lookup_by_ico`

Use it to retrieve one company’s official ARES record from its 7- or 8-digit IČO, including its identity, address, legal form, DIČ, and trade activities. Do not use it when the IČO is unknown; search by name or address first.

```json
{"ico":"26168685"}
```

### `search_companies`

Use it to find companies by a name and/or city, street, PSČ, and CZ-NACE filters; supplied filters are combined with AND. Do not use it for a known IČO, where `lookup_by_ico` is more precise.

```json
{"query":"Seznam.cz","city":"Praha","pocet":10,"start":0}
```

### `search_by_address`

Use it to list entities registered at a Czech street address, for example when assessing a virtual office or building concentration. Do not use it for a single known company; use `lookup_by_ico` instead.

```json
{"street":"Radlická","city":"Praha","psc":15000,"pocet":20}
```

### `search_by_nace`

Use it for a sector search by CZ-NACE code, optionally within one city. Do not use it to determine a specific company’s business activities; retrieve that company with `lookup_by_ico`.

```json
{"nace":"62","city":"Praha","pocet":20}
```

### `get_bank_accounts`

Use it to retrieve transparent accounts published in ARES for a VAT-registered subject, such as when checking invoice payment details. Do not use it to decide whether a payer is reliable for VAT purposes; use ADIS for that check.

```json
{"ico":"26168685"}
```

### `get_statutaries`

Use it to identify current, active statutory-body members who can act for a company. Do not use it as a complete ownership or historical-officer investigation.

```json
{"ico":"26168685"}
```

### `validate_dic`

Use it for a Czech DIČ format and checksum validation. Do not use it as proof that a subject is VAT registered or a reliable payer; it validates the identifier only.

```json
{"dic":"CZ26168685"}
```

### `check_vat_payer`

Use it to check whether a company is registered as a VAT payer in ARES and retrieve its DIČ, tax office, and transparent accounts. Do not use it to assess the statutory “unreliable payer” flag; use ADIS for that.

```json
{"ico":"26168685"}
```

### `get_history`

Use it to retrieve available company-history data, including prior names, registered-address changes, and trade-licence history. Do not use it for the current company record alone; `lookup_by_ico` is the simpler choice.

```json
{"ico":"26168685"}
```

### `watch_entity`

Use it to begin onboarding for free monitoring of one company by IČO. It currently persists nothing and returns onboarding guidance; do not use it as evidence that monitoring is active or as a replacement for a current lookup.

```json
{"ico":"26168685"}
```

## Self-host

Source: https://github.com/martinhavel/cz-agents-mcp

```bash
git clone https://github.com/martinhavel/cz-agents-mcp
cd cz-agents-mcp
npm install
npm run build
node packages/ares/dist/index.js
```

## Free tier & pricing

ARES itself is a free public API. The hosted endpoint at `https://ares.cz-agents.dev/mcp` is rate-limited per IP. Higher limits and commercial use: https://cz-agents.dev/pricing.html

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
