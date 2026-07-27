/**
 * Čítače x402 fáze 1 pro `/metrics`. Jen paměťové Mapy — žádná nová SQLite,
 * `tokens.db` má už dva zapisovatele napříč repy a přidávat třetí by bylo
 * přesně to, co zadání zakazuje. Styl kopíruje `getMetrics()` v `icoTracker.ts`
 * (stejný `escapeLabel`) a konkatenace do `/metrics` je stejná jako
 * `packages/dd/src/http.ts` kolem řádku 196–204: `${getX402Metrics()}${dalšíText}`.
 *
 * Čtyři série ze zadání:
 *   cz_agents_x402_offers_total{service,tool}
 *   cz_agents_x402_settlements_total{service,tool,result}
 *   cz_agents_x402_facilitator_errors_total{service,phase}
 *   cz_agents_x402_check_rejections_total{service,check}
 *
 * Hodnoty labelů (`tool`, `result`, `phase`, `check`, `service`) volí volající
 * fáze 2/3 — tenhle modul jen počítá a vykresluje, nezná význam žádné hodnoty.
 */

type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelKey(labelNames: readonly string[], labels: Labels): string {
  return labelNames.map((name) => `${name}=${labels[name] ?? ''}`).join('\t');
}

class Counter {
  private readonly values = new Map<string, { labels: Labels; count: number }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly labelNames: readonly string[],
  ) {}

  inc(labels: Labels, by = 1): void {
    for (const name of this.labelNames) {
      if (labels[name] === undefined) {
        throw new Error(`${this.name}: chybí label '${name}'`);
      }
    }
    const key = labelKey(this.labelNames, labels);
    const existing = this.values.get(key);
    if (existing) existing.count += by;
    else this.values.set(key, { labels, count: by });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, count } of this.values.values()) {
      const labelStr = this.labelNames
        .map((name) => `${name}="${escapeLabel(labels[name] ?? '')}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${count}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.values.clear();
  }
}

export const x402OffersTotal = new Counter(
  'cz_agents_x402_offers_total',
  'Kolikrát byl vydán 402 payment-required požadavek pro nástroj.',
  ['service', 'tool'],
);

export const x402SettlementsTotal = new Counter(
  'cz_agents_x402_settlements_total',
  'Výsledky vypořádání platby podle nástroje.',
  ['service', 'tool', 'result'],
);

export const x402FacilitatorErrorsTotal = new Counter(
  'cz_agents_x402_facilitator_errors_total',
  'Chyby volání facilitátoru podle fáze (supported/verify/settle).',
  ['service', 'phase'],
);

export const x402CheckRejectionsTotal = new Counter(
  'cz_agents_x402_check_rejections_total',
  'Zamítnutí resource-server kontrol (checks.ts) podle typu kontroly.',
  ['service', 'check'],
);

const ALL_COUNTERS = [
  x402OffersTotal,
  x402SettlementsTotal,
  x402FacilitatorErrorsTotal,
  x402CheckRejectionsTotal,
];

/** Prometheus text pro všechny čtyři série, ke konkatenaci do existujícího `/metrics`. */
export function getX402Metrics(): string {
  return `${ALL_COUNTERS.map((c) => c.render()).join('\n')}\n`;
}

/** Jen pro testy — čítače jsou modulový singleton, mezi testy je potřeba vynulovat. */
export function resetX402Metrics(): void {
  for (const counter of ALL_COUNTERS) counter.reset();
}
