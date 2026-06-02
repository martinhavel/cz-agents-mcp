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

- `lookup_by_ico` — full ARES record for one Czech company by IČO (name, address, legal form, DIČ, founding date, trade activities).
- `search_companies` — combined search by name, city, street, PSČ, and/or CZ-NACE codes.
- `search_by_address` — every company registered at a given Czech address (useful for virtual-office / shell-company checks).
- `search_by_nace` — companies by CZ-NACE activity code, optionally narrowed by city.
- `get_bank_accounts` — transparent bank accounts published for a VAT-registered subject.
- `get_statutaries` — current statutory body (jednatelé, představenstvo) — active members only.
- `validate_dic` — Czech DIČ format check + MOD11 checksum on the embedded IČO tail.
- `check_vat_payer` — VAT-payer status, DIČ, finanční úřad, transparent accounts.
- `get_history` — historical record (previous names, address changes, trade-license history).

Example prompts:

> Look up Czech company with IČO 12345678.

> Find all companies with CZ-NACE 62 in Praha.

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

ARES itself is a free public API. The hosted endpoint at `https://ares.cz-agents.dev/mcp` is rate-limited per IP. Higher limits and commercial use: https://cz-agents.dev/pricing

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
