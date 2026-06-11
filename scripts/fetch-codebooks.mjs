#!/usr/bin/env node
/**
 * Fetches the ARES PravniForma codebook and writes it to
 * packages/shared/src/codebooks/legal-forms.json.
 *
 * Usage: node scripts/fetch-codebooks.mjs
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../packages/shared/src/codebooks/legal-forms.json');

const res = await fetch(
  'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ciselniky-nazevniky/vyhledat',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kodCiselniku: 'PravniForma' }),
  },
);

if (!res.ok) {
  console.error(`ARES returned HTTP ${res.status}`);
  process.exit(1);
}

const data = await res.json();
const entries = {};
for (const c of data.ciselniky ?? []) {
  for (const item of c.polozkyCiselniku ?? []) {
    const cs = item.nazev.find((n) => n.kodJazyka === 'cs');
    if (cs) entries[item.kod] = cs.nazev;
  }
}

const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n');
console.log(`Written ${Object.keys(sorted).length} entries to ${OUT}`);
