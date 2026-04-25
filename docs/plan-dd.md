# `@czagents/dd` — implementation plan

Status: planning. Depends on `@czagents/sanctions` MVP. Target: 1 weekend after sanctions ships.

## Goal

Single tool that takes IČO and returns a structured due-diligence report aggregating ARES + sanctions + ISIR + statutory chain. Killer aggregator for KYC, accounting, legal.

---

## Architecture

```
              ┌──────────────────────────┐
              │  @czagents/dd (MCP)      │
              │  - get_dd_report()       │
              │  - get_risk_score()      │
              │  - get_statutory_chain() │
              └────────────┬─────────────┘
                           │
       ┌───────────────────┼─────────────────────┐
       ▼                   ▼                     ▼
┌──────────────┐    ┌──────────────┐     ┌──────────────┐
│ @czagents/   │    │ @czagents/   │     │ @czagents/   │
│ ares (MCP)   │    │ sanctions    │     │ isir (later) │
└──────────────┘    └──────────────┘     └──────────────┘
       │                   │                     │
       ▼                   ▼                     ▼
   ARES API         sanctions.db            ISIR API
```

**No own data.** Pure orchestration over existing `@czagents/*` packages.
For local stdio: directly imports their TypeScript clients (workspace dep).
For hosted HTTP: HTTP-calls the hosted siblings (or runs in same process).

---

## MCP tools (MVP = 3)

```ts
// 1. Full report
get_dd_report({
  ico: string;
  depth?: 'basic' | 'full';   // basic = ARES + sanctions; full = + ISIR + chain
}): {
  ico: string;
  retrieved_at: string;
  company: {
    name: string;
    legal_form: string;
    address: string;
    registered_on: string;
    employees_range?: string;
    nace_codes: string[];
  };
  vat: {
    is_payer: boolean;
    dic?: string;
    bank_accounts: string[];
    unreliable_payer?: boolean;     // "nespolehlivý plátce" flag z DPH
  };
  statutory_body: Array<{
    name: string;
    role: string;
    since: string;
    sanctions_match?: { source: string; confidence: number };
  }>;
  insolvency?: {
    has_active_proceeding: boolean;
    spisova_znacka?: string;
    started_on?: string;
  };
  sanctions: {
    company_match?: { source: string; confidence: number };
  };
  red_flags: RedFlag[];
  risk_score: { value: number; level: 'low' | 'medium' | 'high' };
}

// 2. Just the score, fast
get_risk_score({ ico: string }): {
  ico: string;
  value: number;             // 0-100
  level: 'low' | 'medium' | 'high';
  top_flags: RedFlag[];      // top 5
}

// 3. Statutory chain (UBO discovery)
get_statutory_chain({
  ico: string;
  max_depth?: number;        // default 3
}): {
  root_ico: string;
  tree: ChainNode[];         // recursive: each statutory's other companies
  total_companies: number;
}
```

```ts
type RedFlag = {
  code: string;              // 'INSOLVENCY_ACTIVE', 'STATUTORY_SANCTIONED', ...
  severity: 'critical' | 'high' | 'medium' | 'low';
  weight: number;            // contribution to score
  description: string;
  source: string;            // 'isir', 'sanctions:ofac', 'ares', ...
  evidence?: unknown;        // raw data point that triggered it
};
```

---

## Risk score (transparent rules)

Score 0–100, kategorie low (0–20) / medium (21–50) / high (51+).

| Code | Severity | Weight | Trigger |
|---|---|---|---|
| `INSOLVENCY_ACTIVE` | critical | 50 | ISIR active proceeding |
| `STATUTORY_SANCTIONED` | critical | 50 | Any statutory on EU/OFAC list (confidence ≥85) |
| `COMPANY_SANCTIONED` | critical | 50 | Company itself on sanctions list |
| `STATUTORY_PRIOR_INSOLVENCY` | high | 20 | Statutory was statutory in another insolvent company |
| `UNRELIABLE_VAT_PAYER` | high | 15 | DPH "nespolehlivý plátce" |
| `RECENT_STATUTORY_CHANGE` | medium | 10 | Statutory changed < 30 days ago |
| `VIRTUAL_ADDRESS` | medium | 10 | Address in known virtual office building (heuristic: 50+ companies same address) |
| `NO_VAT_DESPITE_SCALE` | low | 5 | Not VAT payer + employees > 100 |
| `NO_DPH_BANK_ACCOUNT` | low | 5 | VAT payer ale nemá zveřejnený účet (povinnost) |
| `NEW_COMPANY` | low | 5 | Registered < 6 months ago |

Score = sum of triggered weights, capped at 100.

**Important:** All flags surfaced in report with evidence — žádný black-box score. User vidí proč a může se rozhodnout.

---

## Statutory chain algorithm

```
1. Get statutory body for root_ico via ARES (get_statutaries)
2. For each statutory person:
   - search_companies({ name }) in ARES → list of IČOs where they are/were statutory
   - dedupe, exclude root_ico
3. For each found IČO:
   - if depth < max_depth, recurse from step 1
4. Build tree, return with total count
```

**Limits:**
- max_depth default 3 (avoid exponential explosion)
- Cache per (ico, depth) for 24h
- Rate limit: 1 chain query = up to ~30 ARES calls; charge as 5 reports

---

## Code layout

```
packages/dd/
  ├── package.json
  ├── tsconfig.json
  ├── vitest.config.ts
  ├── Dockerfile
  ├── src/
  │   ├── index.ts            # stdio entry
  │   ├── server.ts           # MCP server
  │   ├── http.ts
  │   ├── report.ts           # main orchestrator: build full report
  │   ├── score.ts            # scoring rules + flag detection
  │   ├── chain.ts            # statutory chain BFS
  │   ├── clients.ts          # wires up @czagents/ares, /sanctions, /isir clients
  │   ├── types.ts
  │   └── __tests__/
  │       ├── report.test.ts  # mock ares + sanctions, assert report shape
  │       ├── score.test.ts   # rule tests, edge cases
  │       └── chain.test.ts
```

---

## Caching

Reports cached 24h per IČO+depth. ARES údaje se mění málokdy, sankce 1×denně, ISIR víckrát denně ale není to flash trading.

Cache key: `${ico}:${depth}` → JSON report + retrieved_at.
Backend: SQLite (own file `dd-cache.db`) nebo memory (LRU 1000 entries).

`get_risk_score` může vracet z cached `get_dd_report` pokud je < 24h.

---

## Monetization

**Tiers (highest revenue potential of any product in this monorepo):**

| Tier | Price | Quota | Features |
|---|---|---|---|
| Free | €0 | 5/day | basic depth only, no chain |
| Pay-per-report | €0.50 | unlimited single-shot | full depth, no subscription |
| Pro | €49/mo | 200/mo | + chain, + monitoring (1× IČO daily refresh) |
| Agency | €199/mo | 1500/mo | + bulk endpoint (CSV in/out), + webhook on IČO change |
| Enterprise | custom | unlimited | white-label, on-prem, custom flags |

**Killer monetization angle:** Stripe metered with **prepay credits** option — user předplatí 100 reportů za €40 (sleva), spotřebovává postupně. Lower friction než subscription.

**Cross-sell from sanctions:** sanctions Pro (€99) zákazník dostane 50 reportů/mo dd v ceně. dd Pro (€49) uživatel dostane 5000 sanctions lookups v ceně. Klasický bundle uplift.

---

## Implementation milestones

### M1: Wiring + report (1 day)
- [ ] Setup package, workspace deps na `@czagents/ares`, `/sanctions`, `/shared`
- [ ] `clients.ts` — instantiate sub-clients (env: stdio nebo HTTP)
- [ ] `report.ts` — call ARES (get_by_ico, get_statutaries, check_vat_payer, get_bank_accounts), call sanctions (check_ico for company + search_person for each statutory)
- [ ] Assemble report shape, basic depth only

### M2: Scoring + flags (0.5 day)
- [ ] `score.ts` — rule engine, all flag codes
- [ ] Tests covering each rule trigger
- [ ] `get_risk_score` tool

### M3: Statutory chain (0.5 day)
- [ ] `chain.ts` — BFS traversal with depth limit
- [ ] Cache + dedupe
- [ ] `get_statutory_chain` tool

### M4: Hosted + billing (1 day)
- [ ] HTTP transport, token validation
- [ ] Stripe metered billing for per-report
- [ ] Stripe subscription handling for Pro/Agency
- [ ] Quota enforcement

### M5: Distribution (0.5 day)
- [ ] npm publish `@czagents/dd`
- [ ] README with examples (KYC use case, lawyer DD use case)
- [ ] Landing page subsection
- [ ] Demo: live IČO lookup on cz-agents.dev (rate-limited public)

**Total:** ~3.5 days. 1 weekend if focused.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Statutory chain causes ARES rate-limit issues | Cache aggressive, 24h TTL, count chain query as 5+ reports against quota |
| Risk score falsely high → user dispute | Show all triggered flags with evidence; user can self-explain. Add `disputed_flags` parameter for power users to exclude rules. |
| Liability (someone makes business decision based on score) | T&C: informational only, not financial advice. Standard disclaimer. Show disclaimer in every report response. |
| ISIR not yet built → only basic depth available at launch | Ship with `basic` depth only initially, mark `full` as "coming soon"; MVP can launch with ARES+sanctions only |
| Public demo abused | Public demo limited to 5 reports/IP/day, only basic depth, common known IČO whitelist for "try without signup" |

---

## Out of scope for MVP

- Smlouvy/CEDR integration (premium add-on later)
- ESG / financial health scoring (needs paid datasets)
- PDF export of report
- Bulk async jobs (CSV in → CSV out)
- API for "monitor list of 100 IČOs" — comes with Agency tier later
- Multi-language report (English/CZ only)
- Historical timeline (when did flag appear) — needs persistent snapshots
