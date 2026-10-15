# Report template (compliance)

Fill only with data returned by tools. Omit a row rather than guess. Write in the user's
language; the Czech labels in brackets are for Czech output.

```markdown
# Due-diligence screening: <Company name> (IČO <ico>)
[Prověrka společnosti]

**Query time:** <ISO 8601 with timezone, e.g. 2026-10-14T19:12:32Z>   ·   **Tier used:** free
**Sources queried:** <e.g. dd (ARES, VR, EU+OFAC, ADIS), isir>

## 1. Risk summary [Shrnutí rizika]
- **Tool risk score:** <risk_score.value>/100 – <level>  (source: dd.get_dd_report, <retrieved_at>)
- **Coverage:** <"all queried sources checked" | "PARTIAL – not verified: ARES, ADIS …">
- **Top red flags (as returned):**
  1. <code> – <description> (severity <severity>, source <source>)
  2. …
- **One-sentence summary:** <neutral restatement of the above; no new conclusions>

> If any source is unavailable, write: "Score reflects only the sources that were checked;
> it must not be read as low risk."

## 2. Company facts [Základní údaje]
| Item | Value | Source · time |
|---|---|---|
| Name | | ARES via dd · <t> |
| Legal form | | |
| Registered address | | |
| Founded / dissolved | | |
| NACE | | |
| DIČ / VAT payer | | |

## 3. Findings [Nálezy]
| Check | Result | Source · time |
|---|---|---|
| Insolvency (ISIR) – company | <"No active proceeding at query time" / spisová značka, phase, since / NOT VERIFIED> | isir.check_ico_insolvency · <t> |
| VAT reliability (ADIS) | <NE = reliable / ANO = UNRELIABLE since … / NENALEZEN> | dd / adis · <t> |
| Published bank accounts | <list or "none published"> | |
| Sanctions – company | <no match / possible match / confirmed> | |
| Sanctions – statutory body | <per member: no match / possible match (review) / confirmed> | |
| Ownership (VR, indicated) | <owners as published / not published> | dd.get_owners · <t> |
| Other | | |

### Statutory body [Statutární orgán]
| Name | Role | Since | Sanctions screen |
|---|---|---|---|
| | | | <no match / possible match – review / confirmed> |

(Birth year only, unless the full date is needed to explain a match.)

### Sanctions matches requiring review (if any)
| Subject | Listing id | Confidence | match_strength / dob_status | Programs | Status |
|---|---|---|---|---|---|
| | | | | | Possible match – human review required |

## 4. Not verified [Neověřeno]
- <check> – <reason: requires Compliance tier (tier_required, upgrade_url …) | source unavailable | daily limit reached | not requested>
- Beneficial owner (ESM) – not public; obtain via esm.justice.cz (datová schránka).

## 5. Recommended next steps [Doporučené další kroky]
- <e.g. Manually review possible sanctions match <id> against the official list>
- <e.g. Obtain UBO extract from ESM>
- <e.g. Re-run the check before payment; data is valid only at query time>
- <optional: monitoring via watch_entity onboarding link – user completes it>

---
*Screening tool output, not an audit or legal opinion; no warranty. Data reflects public
registries at the query time shown above. Decision remains with a human.*
[Nástroj, ne audit ani právní posouzení, bez záruky. Podklad pro rozhodnutí člověka.]
```

## Short answer variant

For single-question requests ("je spolehlivý plátce DPH?"), answer in 2–4 lines:
result, source + query time, anything not verified, and the one-line disclaimer.
