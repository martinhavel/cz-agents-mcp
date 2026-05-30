import { AsyncLocalStorage } from 'node:async_hooks';
import { isValidIco } from './ico.js';

interface IpContext {
  ip: string;
}

const ipStorage = new AsyncLocalStorage<IpContext>();
const seen = new Map<string, Map<string, Set<string>>>();
// ico → total call count (cumulative, resets on process restart)
const icoCounter = new Map<string, number>();
// "tool:query:city:street" → count
const searchCounter = new Map<string, number>();

// Fallback for MCP SDK transports that break AsyncLocalStorage chain.
// Known limitation: module-level state has a race condition under concurrent requests
// (request B can overwrite before request A's tool handler reads it). Acceptable for
// analytics-only use at current traffic scale; proper fix requires per-session Map
// keyed on transport.sessionId when SDK exposes it to tool handlers.
let _currentIp: string | undefined;

export function setRequestIp(ip: string): void {
  _currentIp = ip;
}

export function clearRequestIp(): void {
  _currentIp = undefined;
}

export function runWithIp(ip: string, fn: () => Promise<void>): Promise<void> {
  return ipStorage.run({ ip }, fn);
}

export function getCurrentIp(): string | undefined {
  return ipStorage.getStore()?.ip ?? _currentIp;
}

export function trackIco(ico: string): void {
  if (!isValidIco(ico)) return;

  const ip = ipStorage.getStore()?.ip ?? _currentIp;
  if (!ip) return;

  const date = today();
  let byIp = seen.get(date);
  if (!byIp) {
    byIp = new Map();
    seen.set(date, byIp);
  }

  let icos = byIp.get(ip);
  if (!icos) {
    icos = new Set();
    byIp.set(ip, icos);
  }

  icos.add(ico);
  icoCounter.set(ico, (icoCounter.get(ico) ?? 0) + 1);
}

export function logToolCall(service: string, tool: string, args: Record<string, unknown> = {}): void {
  const ip = getCurrentIp() ?? 'unknown';
  const parts = [`service=${service}`, `tool=${tool}`];
  const paramKeys: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    paramKeys.push(key);

    if (isSafeLogValue(key, value)) {
      parts.push(`${key}=${formatLogValue(value)}`);
    }
  }

  if (paramKeys.length > 0) {
    parts.push(`param_keys=${paramKeys.sort().join(',')}`);
  }
  parts.push(`ip=${ip}`);

  console.error(`[tool] ${parts.join(' ')}`);

  if (tool === 'search_companies' || tool === 'search_by_address') {
    const q = String(args['query'] ?? '').slice(0, 60).replace(/\s+/g, '_') || '-';
    const city = String(args['city'] ?? '').slice(0, 40).replace(/\s+/g, '_') || '-';
    const street = String(args['street'] ?? '').slice(0, 40).replace(/\s+/g, '_') || '-';
    const key = `${tool}\t${q}\t${city}\t${street}`;
    searchCounter.set(key, (searchCounter.get(key) ?? 0) + 1);
  }
}

export function getMetrics(): string {
  const lines = [
    '# HELP unique_ico_per_ip_per_day Unique valid IČOs seen per anonymized IP prefix per day.',
    '# TYPE unique_ico_per_ip_per_day gauge',
  ];

  const totals = new Map<string, number>();
  for (const [date, byIp] of seen) {
    for (const [ip, icos] of byIp) {
      const key = `${ipPrefix(ip)}\t${date}`;
      totals.set(key, (totals.get(key) ?? 0) + icos.size);
    }
  }

  for (const [key, value] of totals) {
    const [prefix, date] = key.split('\t') as [string, string];
    lines.push(
      `unique_ico_per_ip_per_day{ip_prefix="${escapeLabel(prefix)}",date="${escapeLabel(date)}"} ${value}`,
    );
  }

  // Top IČO lookup frequency counter
  lines.push('');
  lines.push('# HELP ico_lookup_total Total tool calls per IČO since process start.');
  lines.push('# TYPE ico_lookup_total counter');
  for (const [ico, count] of icoCounter) {
    lines.push(`ico_lookup_total{ico="${escapeLabel(ico)}"} ${count}`);
  }

  // Search query counters
  lines.push('');
  lines.push('# HELP search_query_total Total search_companies/search_by_address calls per query+city+street since process start.');
  lines.push('# TYPE search_query_total counter');
  for (const [key, count] of searchCounter) {
    const [tool, query, city, street] = key.split('\t') as [string, string, string, string];
    lines.push(`search_query_total{tool="${escapeLabel(tool)}",query="${escapeLabel(query)}",city="${escapeLabel(city)}",street="${escapeLabel(street)}"} ${count}`);
  }

  return `${lines.join('\n')}\n`;
}

const MAX_ICO_COUNTER_ENTRIES = 50_000;
const MAX_SEARCH_COUNTER_ENTRIES = 5_000;

export function cleanup(): void {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 2);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  for (const date of seen.keys()) {
    if (date < cutoffDate) seen.delete(date);
  }

  if (icoCounter.size > MAX_ICO_COUNTER_ENTRIES) {
    const sorted = [...icoCounter.entries()].sort((a, b) => a[1] - b[1]);
    for (const [ico] of sorted.slice(0, icoCounter.size - MAX_ICO_COUNTER_ENTRIES)) {
      icoCounter.delete(ico);
    }
  }

  if (searchCounter.size > MAX_SEARCH_COUNTER_ENTRIES) {
    const sorted = [...searchCounter.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of sorted.slice(0, searchCounter.size - MAX_SEARCH_COUNTER_ENTRIES)) {
      searchCounter.delete(key);
    }
  }
}

const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
cleanupTimer.unref();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ipPrefix(ip: string): string {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const octets = normalized.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    return octets.slice(0, 3).join('.');
  }
  return normalized.split(':').filter(Boolean).slice(0, 3).join(':') || 'unknown';
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function isSafeLogValue(key: string, value: unknown): boolean {
  if (key === 'ico' || key === 'dic') return true;
  if (key === 'icos' || key === 'dics') return Array.isArray(value);
  if (['depth', 'max_depth', 'since_id', 'limit', 'threshold', 'only_active'].includes(key)) return true;
  if (['query', 'city', 'street', 'nace', 'psc'].includes(key)) return typeof value === 'string' || typeof value === 'number';
  return false;
}

function formatLogValue(value: unknown): string {
  if (Array.isArray(value)) return `count:${value.length}`;
  return String(value).replace(/\s+/g, '_');
}
