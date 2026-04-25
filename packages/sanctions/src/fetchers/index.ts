/**
 * Source registry. Each source = identifier + URL builder + parser.
 *
 * URLs read from env to keep the package config-light:
 *   SANCTIONS_EU_URL    — full URL to xmlFullSanctionsList_1_1 (token-bound)
 *   SANCTIONS_OFAC_URL  — defaults to public OFAC SDN.XML endpoint
 */
import { parseEu } from './eu.js';
import { parseOfac } from './ofac.js';
import type { SanctionedEntity, SanctionSource } from '../types.js';

export interface SourceDef {
  source: SanctionSource;
  url: () => string | null;
  parse: (xml: string) => SanctionedEntity[];
  /** True if URL is mandatory; false if source can be skipped silently. */
  required: boolean;
}

const DEFAULT_OFAC_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';

export const SOURCES: SourceDef[] = [
  {
    source: 'eu',
    url: () => process.env.SANCTIONS_EU_URL ?? null,
    parse: parseEu,
    required: false,
  },
  {
    source: 'ofac',
    url: () => process.env.SANCTIONS_OFAC_URL ?? DEFAULT_OFAC_URL,
    parse: parseOfac,
    required: false,
  },
];

export { parseEu, parseOfac };
