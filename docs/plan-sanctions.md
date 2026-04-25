# `@czagents/sanctions` — implementation plan

Status: planning. Target MVP: 1–2 weekends, hosted at `sanctions.cz-agents.dev`.

## Goal

Multi-source sanctions screening MCP for KYC/AML in Czech & EU fintech.
Open-core: npm package free (BYO data), hosted endpoint metered via Stripe.

---

## Data sources (MVP = EU + OFAC)

| Source | Format | Update | URL pattern |
|---|---|---|---|
| EU Financial Sanctions (consolidated) | XML | daily | `webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=...` (free, login-bound token; alternativa raw `data.europa.eu`) |
| OFAC SDN | XML/CSV | daily | `sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML` |
| UN Consolidated | XML | irregular | `scsanctions.un.org/resources/xml/en/consolidated.xml` |
| OFSI (UK) | CSV | weekly | `assets.publishing.service.gov.uk/.../UK_Sanctions_List.ods` (ods, parse via xlsx lib) |
| FAÚ ČR | HTML scrape | rare | `financnianalytickyurad.cz/sankce.html` — scrape, ale stabilní formát, low risk |

**MVP scope:** jen **EU + OFAC**. Pokrývá 90 % use case pro CZ/EU fintech. UN/OFSI/FAÚ přidat v iteraci 2.

**Important:** Žádné scraping kromě FAÚ. Vše ostatní = oficiální structured exports.

---

## Schema (normalized)

Single unified record bez ohledu na zdroj:

```ts
type SanctionedEntity = {
  id: string;                      // `${source}:${list_id}`, e.g. "ofac:12345"
  source: 'eu' | 'ofac' | 'un' | 'ofsi' | 'fau';
  source_list_id: string;          // native ID v zdrojovém listingu
  type: 'person' | 'entity' | 'vessel' | 'aircraft';
  primary_name: string;
  aliases: string[];               // všechny varianty včetně transliterace
  dob?: string;                    // ISO date nebo just year
  nationality?: string[];          // ISO 3166-1 alpha-2
  addresses?: { street?: string; city?: string; country?: string }[];
  ids?: { type: string; value: string; country?: string }[];  // passport, IČO, tax_id
  programs: string[];              // ['EU.RUSSIA', 'OFAC.SDN', ...]
  listed_on?: string;              // ISO date
  remarks?: string;                // free-text z origin listingu
  raw: unknown;                    // celý raw record pro audit
};
```

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────┐
│  cron (daily)   │────────▶│  fetcher (Node script) │
│  on raspi5/VPS  │         │  - download XML/CSV    │
└─────────────────┘         │  - parse → normalize   │
                            │  - upsert to SQLite    │
                            └────────┬───────────────┘
                                     │
                                     ▼
                            ┌────────────────────┐
                            │ data/sanctions.db  │  (SQLite + FTS5)
                            └────────┬───────────┘
                                     │
                            ┌────────▼─────────────────────┐
                            │  @czagents/sanctions (MCP)   │
                            │  - stdio (npm)               │
                            │  - HTTP (sanctions.cz-...)   │
                            └──────────────────────────────┘
```

**Why SQLite, ne Postgres:**
- Single-file DB, snadný deploy, snadný backup, žádná správa
- FTS5 + trigram extension = dostatek pro fuzzy match při <1M záznamů (EU+OFAC ~30k entries)
- Když poroste mimo single-server, migrace na Postgres triviální

**Where to host:**
- Data file: `/var/lib/czagents-sanctions/sanctions.db` na VPS
- Cron fetcher: systemd timer (denně 04:00 UTC, po release většiny zdrojů)
- MCP HTTP server: Docker container, Caddy/Cloudflare před tím

---

## MCP tools (MVP = 5)

```ts
// 1. Search by person name (fuzzy)
search_person({
  name: string;
  dob?: string;        // YYYY or YYYY-MM-DD
  nationality?: string;
  threshold?: number;  // 0-100, default 80
}): {
  matches: Array<{
    entity: SanctionedEntity;
    confidence: number;  // 0-100
    matched_on: 'primary_name' | 'alias';
  }>;
}

// 2. Search by entity/company name
search_entity({
  name: string;
  country?: string;
  threshold?: number;
}): { matches: ... }

// 3. Direct IČO lookup (CZ entities)
check_ico({ ico: string }): {
  hit: boolean;
  matches: Array<{ entity: SanctionedEntity; confidence: number }>;
}

// 4. Get full record by ID
get_listing({ id: string }): SanctionedEntity | null

// 5. List recent updates (for monitoring)
list_recent_updates({
  source?: string;
  since: string;        // ISO date
  limit?: number;
}): {
  added: SanctionedEntity[];
  removed: SanctionedEntity[];
  modified: Array<{ before: SanctionedEntity; after: SanctionedEntity }>;
}
```

---

## Fuzzy matching strategy

**Library:** `fastest-levenshtein` + `transliteration` (cyrilice→latin) nebo full `rapidfuzz-js`.

**Algorithm:**
1. Normalize input: lowercase, strip diacritics, transliterate non-Latin
2. Token-set match (split by whitespace, compare tokens regardless of order)
3. Score = max(levenshtein_normalized(input, primary_name), max over aliases)
4. Threshold default 80 — under = no match, 80–95 = "review needed", 95+ = "high confidence"

**Edge cases:**
- DOB partial matching: pokud listing má jen rok (`1965`), input s plným datem (`1965-03-12`) match na rok = pass
- Multiple aliases: vždy report nejvyšší score napříč všemi aliasy
- ID match (passport, tax_id) bypassuje fuzzy — exact match na ID = 100 confidence

---

## Code layout

```
packages/sanctions/
  ├── package.json
  ├── tsconfig.json
  ├── vitest.config.ts
  ├── Dockerfile
  ├── src/
  │   ├── index.ts            # stdio entry point
  │   ├── server.ts           # MCP server definition
  │   ├── http.ts             # HTTP / Streamable transport
  │   ├── db.ts               # SQLite client + queries
  │   ├── fetchers/
  │   │   ├── eu.ts           # parse EU XML → SanctionedEntity[]
  │   │   ├── ofac.ts         # parse OFAC XML
  │   │   └── index.ts        # orchestrator: fetch all, upsert
  │   ├── search.ts           # fuzzy match logic
  │   ├── types.ts
  │   └── __tests__/
  │       ├── fixtures/       # sample XML files for tests
  │       ├── eu-parser.test.ts
  │       ├── ofac-parser.test.ts
  │       └── search.test.ts
  └── scripts/
      └── refresh.ts          # CLI entry: `npx @czagents/sanctions-refresh`
```

---

## Monetization

**Auth:** API token in MCP `Authorization: Bearer <token>` header (HTTP transport) or env var (stdio + npm).

**Tiers:**

| Tier | Price | Quota | Features |
|---|---|---|---|
| Free | €0 | 100/day per token | 2 sources (EU+OFAC), stdio only |
| Starter | €19/mo | 5 000/mo | + hosted HTTP, all sources, `list_recent_updates` |
| Pro | €99/mo | 50 000/mo | + webhook alerts on IČO change, batch endpoint |
| Enterprise | custom | unlimited | white-label, on-prem, SLA, custom datasets |

**Payment:** Stripe Billing (metered), webhook → token quota update. Existing Stripe MCP integration ready.

**Token issuance:** sanctions.cz-agents.dev landing page → email + Stripe Checkout → token via email. KISS, žádný full account systém v MVP.

---

## Implementation milestones

### M1: Data layer (1 day)
- [ ] SQLite schema + migrations
- [ ] EU XML fetcher + parser (with fixtures from real export)
- [ ] OFAC XML fetcher + parser
- [ ] Unit tests for parsers
- [ ] CLI refresh script (`npm run refresh -w @czagents/sanctions`)

### M2: Search + MCP tools (1 day)
- [ ] Fuzzy match implementation (rapidfuzz or hand-rolled)
- [ ] 5 MCP tools wired to DB
- [ ] stdio transport (`bin/sanctions`)
- [ ] Tests for search + tools

### M3: Hosted version (0.5 day)
- [ ] HTTP transport mirroring ARES/CNB pattern
- [ ] Token validation middleware
- [ ] Rate limiting (existing `@czagents/shared/rateLimit`)
- [ ] Docker image
- [ ] Deploy to VPS or raspi5, Caddy/CF in front
- [ ] Subdomain `sanctions.cz-agents.dev`

### M4: Billing (0.5 day)
- [ ] Stripe product + price (metered)
- [ ] Webhook handler (token issuance)
- [ ] Quota tracking in SQLite (per token, daily/monthly counters)
- [ ] Landing page section on cz-agents.dev for sanctions

### M5: Distribution (0.5 day)
- [ ] npm publish `@czagents/sanctions`
- [ ] README with setup, schema, examples
- [ ] Add to root README + landing page
- [ ] PR awesome-mcp-servers entry

**Total:** ~3.5 days of focused work. Realistically 2 weekends.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| EU/OFAC export format changes | Snapshot fixtures, parser tests will fail loudly; refresh script keeps last known-good DB until parse succeeds |
| Fuzzy match false positives → user complaints | Conservative default threshold (80), expose threshold param, return `confidence` so caller can decide |
| GDPR — sankční data jsou public records | EU public records exception (Art. 6.1.f legitimate interest), nicméně Privacy Policy musí explicitně uvést zdroje |
| Liability — false negative ("nesankcoval jsem podle vás a teď je problém") | T&C: tool is informational, not authoritative; user must verify with original source. Standard disclaimer. |
| Niche — málo zákazníků | Start free (npm) for adoption, monetize jen power users; if no traction in 3 mo, pivot to `dd` aggregator (sanctions becomes free dependency) |

---

## Out of scope for MVP (parking lot)

- PEP screening (no clean free EU dataset)
- Adverse media (negative news scanning) — separate product
- UBO discovery — patří do `@czagents/dd`
- Sanctioned vessel/aircraft tracking — niche
- Real-time alerts via Slack/Teams — paid feature, ale po MVP
- ML-based name matching (vs Levenshtein) — overengineering pro MVP
