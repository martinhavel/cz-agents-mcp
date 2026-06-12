# @czagents/realestate

**Free tier package only.** Czech distressed real estate intelligence — anonymized district-level aggregates (insolvency and forced-sale counts, price trends; low-volume districts flagged `low_activity` at k<3). No PII exposed.

**Paid features** (full property search, owner data, per-property details) are at the hosted endpoint:
**[realestate-pro.cz-agents.dev](https://realestate-pro.cz-agents.dev/mcp)** — see [https://cz-agents.dev/pricing.html](https://cz-agents.dev/pricing.html).

## Install

```bash
npm install -g @czagents/realestate
```

## Usage with Claude Desktop

```json
{
  "mcpServers": {
    "realestate": {
      "command": "npx",
      "args": ["-y", "@czagents/realestate"]
    }
  }
}
```

## Tools (free tier)

- `get_district_aggregate` — distress real-estate statistics for a Czech okres (district): counts by category (insolvency / auction) and average market data. Districts with fewer than 3 distress leads are flagged `low_activity` (k<3) to signal that low-volume figures should be read with caution; counts themselves are returned, not suppressed. Free tier — no PII exposed.

## Paid tools (hosted realestate-pro only)

The following tools are **not** included in this package. They are available exclusively through the hosted paid endpoint at `https://realestate-pro.cz-agents.dev/mcp`:

- `search_distress_properties` — full property search with addresses and owner names (Reality Profesional / Agency tier)
- `get_property_detail` — per-property full details including RUIAN parcel, appraisal link, AI risk score (Reality Profesional tier+)

See [cz-agents.dev/pricing.html](https://cz-agents.dev/pricing.html) for subscription details.

## Tiers

| Tier | Price | What you get |
|---|---|---|
| **Free** (this package) | 0 Kč | District aggregates with `low_activity` flag at k<3, no PII. |
| **Reality Profesional** | 1 990 Kč/měs | Full property search + details, owner names, addresses, RUIAN parcel, appraisal links. Via hosted endpoint. |
| **Reality Agency** | 5 990 Kč/měs | Multi-seat, REST API + webhooks, higher rate limits, batch search. Via hosted endpoint. |

## GDPR / opt-out

Owners listed in distress sales are processed under GDPR Art. 6(1)(f) (legitimate interest, public-register data). The hosted server honours an opt-out registry: subjects who have requested removal are filtered out of all responses.

## Self-host (free tier only)

Source: https://github.com/martinhavel/cz-agents-mcp

```bash
git clone https://github.com/martinhavel/cz-agents-mcp
cd cz-agents-mcp
npm install
npm run build
node packages/realestate/dist/index.js
```

Self-hosting requires read access to a `cz-agents-webapp`-compatible SQLite database with `RealEstateLead` and `OptOutEntry` tables populated by the daily crawlers in the upstream project. The free-tier aggregate tools are the only tools available in this open-source package.

## BREAKING CHANGES

### 0.2.0

`search_distress_properties` and `get_property_detail` have been **removed** from this package. They are now available exclusively via the hosted paid endpoint `realestate-pro.cz-agents.dev`. Free tier aggregate tools (`get_district_aggregate`) are unaffected.

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
