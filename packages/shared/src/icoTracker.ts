import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidIco } from './ico.js';
import { TtlMap } from './cache.js';

interface IpContext {
  ip: string;
  sessionId?: string;
}

const ipStorage = new AsyncLocalStorage<IpContext>();
const RETENTION_MS = 3 * 24 * 60 * 60_000;
const MAX_DATES = 3;
const MAX_IPS_PER_DATE = 50_000;
const MAX_ICOS_PER_IP = 5_000;
const MAX_ICO_COUNTER_ENTRIES = 50_000;
const MAX_SEARCH_COUNTER_ENTRIES = 5_000;
const MAX_CTA_HINT_ENTRIES = 50_000;
const SESSION_IP_TTL_MS = 6 * 60 * 60_000;
const MAX_SESSION_IPS = 50_000;
const DEFAULT_CTA_ESCALATION_THRESHOLD = 3;
const CTA_ESCALATION_HINT =
  '💡 Tuhle firmu si u nás můžeš nechat hlídat — použij nástroj watch_entity.';

const seen = new TtlMap<string, TtlMap<string, Set<string>>>({
  ttlMs: RETENTION_MS,
  maxSize: MAX_DATES,
  sweepIntervalMs: 60 * 60_000,
});
// ico → recent call count (retained for at most three days)
const icoCounter = new TtlMap<string, number>({
  ttlMs: RETENTION_MS,
  maxSize: MAX_ICO_COUNTER_ENTRIES,
  sweepIntervalMs: 60 * 60_000,
});
// ico → company name (best-effort, from ARES lookups; for Grafana lead-list join)
const icoNameMap = new TtlMap<string, string>({
  ttlMs: RETENTION_MS,
  maxSize: MAX_ICO_COUNTER_ENTRIES,
  sweepIntervalMs: 60 * 60_000,
});
// "tool:query:city:street" → count
const searchCounter = new TtlMap<string, number>({
  ttlMs: RETENTION_MS,
  maxSize: MAX_SEARCH_COUNTER_ENTRIES,
  sweepIntervalMs: 60 * 60_000,
});
const sessionIpMap = new TtlMap<string, string>({
  ttlMs: SESSION_IP_TTL_MS,
  maxSize: MAX_SESSION_IPS,
  sweepIntervalMs: 60 * 60_000,
});

// TtlMap (not a plain Map) so per-(scope, ico) CTA state is bounded and self-evicts,
// matching the other counters above — a plain Map would grow unbounded over uptime.
const ctaHintCounter = new TtlMap<string, { count: number; escalationShown: boolean }>({
  ttlMs: RETENTION_MS,
  maxSize: MAX_CTA_HINT_ENTRIES,
  sweepIntervalMs: 60 * 60_000,
});

// Legacy fallback for non-MCP or older call paths. MCP HTTP tool handlers should
// resolve IP by session id via wrapServerTools(), then enter an ALS scope.
let _currentIp: string | undefined;

type ToolHandlerExtra = { sessionId?: string };
type ToolHandler = (args: unknown, extra?: ToolHandlerExtra) => unknown;
type ToolRegistrar = (...args: unknown[]) => unknown;
const wrappedServers = new WeakSet<object>();

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

export function getCurrentSessionId(): string | undefined {
  return ipStorage.getStore()?.sessionId;
}

export function registerSession(sessionId: string, ip: string): void {
  if (!sessionId.trim() || !ip.trim()) return;
  sessionIpMap.set(sessionId, ip);
}

export function resolveClientIp(sessionId?: string): string {
  if (sessionId) {
    const sessionIp = sessionIpMap.get(sessionId);
    if (sessionIp) return sessionIp;
  }
  return ipStorage.getStore()?.ip ?? _currentIp ?? 'unknown';
}

// Daily cap: distinct IČO per IP/day (anonymous free → konverzní zeď).
// 0 = vypnuto (default); ICO_DAILY_CAP=60 per server to zapne. Cap na unikátní
// firmy (ne requesty/tool-cally) — handshake/transport šum to nenafoukne.
const ICO_DAILY_CAP = Number(process.env.ICO_DAILY_CAP ?? 0);
const DAILY_CAP_CTA =
  `Denní free limit vyčerpán (${ICO_DAILY_CAP} firem/den). Pokračuj bez limitů přes Credit Packs ` +
  `(od €35 / 50 dotazů, bez závazku) nebo Pro (1 690 Kč/měs). → https://app.cz-agents.dev/cena`;

// True když aktuální IP už dosáhla denního capu unikátních IČO.
export function icoCapExceeded(sessionId?: string): boolean {
  if (ICO_DAILY_CAP <= 0) return false;
  const ip = resolveClientIp(sessionId);
  if (ip === 'unknown') return false;
  const icos = seen.get(today())?.get(ip);
  return (icos?.size ?? 0) >= ICO_DAILY_CAP;
}

export function wrapServerTools(server: { tool: unknown }): void {
  if (wrappedServers.has(server)) return;
  wrappedServers.add(server);

  const toolHost = server as { tool: ToolRegistrar };
  const originalTool = toolHost.tool.bind(server);
  toolHost.tool = (...args: unknown[]) => {
    const handler = args.at(-1);
    if (typeof handler !== 'function') return originalTool(...args);

    const wrappedHandler = (toolArgs: unknown, extra?: ToolHandlerExtra) =>
      ipStorage.run({ ip: resolveClientIp(extra?.sessionId), sessionId: extra?.sessionId }, () => {
        if (icoCapExceeded(extra?.sessionId)) {
          return { content: [{ type: 'text', text: DAILY_CAP_CTA }], isError: true };
        }
        return (handler as ToolHandler)(toolArgs, extra);
      });

    return originalTool(...args.slice(0, -1), wrappedHandler);
  };
}

export function trackIco(ico: string): void {
  if (!isValidIco(ico)) return;

  const ip = resolveClientIp();
  if (ip === 'unknown') return;

  const date = today();
  let byIp = seen.get(date);
  if (!byIp) {
    byIp = new TtlMap({
      ttlMs: RETENTION_MS,
      maxSize: MAX_IPS_PER_DATE,
      // Parent `seen` cleanup sweeps retained days; avoid a timer retaining
      // nested maps after their day has been evicted.
      sweepIntervalMs: false,
    });
    seen.set(date, byIp);
  }

  let icos = byIp.get(ip);
  if (!icos) {
    icos = new Set();
    byIp.set(ip, icos);
  }

  if (icos.size >= MAX_ICOS_PER_IP && !icos.has(ico)) {
    const oldest = icos.values().next();
    if (!oldest.done) icos.delete(oldest.value);
  }
  icos.add(ico);
  byIp.set(ip, icos);
  icoCounter.set(ico, (icoCounter.get(ico) ?? 0) + 1);
}

// Best-effort company name for an IČO (no count) — emitted as ico_company_info
// so Grafana can join names onto ico_lookup_total (readable lead-list).
export function trackIcoName(ico: string, name: string): void {
  if (!isValidIco(ico) || !name) return;
  icoNameMap.set(ico, name);
}

export function getCTAHint(ico: string, scopeId?: string): string {
  // Prefer a stable, race-free per-client scope (MCP sessionId, passed explicitly
  // by the SDK `extra`). Fall back to anonymized IP prefix only when there is no
  // session (e.g. stdio). The IP fallback is unreliable under concurrent HTTP
  // traffic (module-level _currentIp races), which is why session scope is primary.
  const scope = scopeId ?? ipPrefix(getCurrentIp() ?? 'unknown');
  const key = `${scope}\t${ico}`;
  const state = ctaHintCounter.get(key) ?? { count: 0, escalationShown: false };
  state.count += 1;

  const threshold = getCTAEscalationThreshold();
  if (state.count >= threshold && !state.escalationShown) {
    state.escalationShown = true;
    ctaHintCounter.set(key, state);
    return CTA_ESCALATION_HINT;
  }

  ctaHintCounter.set(key, state);
  // Silent on casual / one-off lookups — nudge only on genuine repeated interest.
  return '';
}

// Tool-response helper: returns 0 or 1 text blocks. The watch_entity nudge fires
// at most once per (IP, IČO), only when the same IP repeatedly looks up the same
// company (= a real monitoring candidate). Never on casual one-off lookups — keeps
// responses clean and avoids an aggressive pricing funnel on free users.
export function getCTAHintBlocks(
  ico: string,
  scopeId?: string,
): Array<{ type: 'text'; text: string }> {
  const hint = getCTAHint(ico, scopeId);
  return hint ? [{ type: 'text', text: hint }] : [];
}

export function resetCTAHintState(): void {
  ctaHintCounter.clear();
}

const toolCallCounter = new Map<string, number>();

export function logToolCall(service: string, tool: string, args: Record<string, unknown> = {}): void {
  // Real tool usage counter (a tools/call actually ran) — distinct from /mcp request
  // count, which is inflated by transport/handshake (initialize, tools/list, ping).
  const tcKey = `${service}\t${tool}`;
  toolCallCounter.set(tcKey, (toolCallCounter.get(tcKey) ?? 0) + 1);
  const ip = getCurrentIp() ?? 'unknown';
  const sessionId = getCurrentSessionId();
  const parts = [`service=${service}`, `tool=${tool}`];
  const paramKeys: string[] = [];
  const safeFields: Record<string, string> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    paramKeys.push(key);

    if (isSafeLogValue(key, value)) {
      const formatted = formatLogValue(value);
      safeFields[key] = formatted;
      parts.push(`${key}=${formatted}`);
    }
  }

  if (paramKeys.length > 0) {
    parts.push(`param_keys=${paramKeys.sort().join(',')}`);
  }
  parts.push(`ip=${ip}`);

  console.error(`[tool] ${parts.join(' ')}`);
  writeToolEventJsonl({
    ts: new Date().toISOString(),
    service,
    tool,
    status: 'ok',
    ip_prefix: process.env.TOOL_EVENTS_FULL_IP === '1' ? ip : ipPrefix(ip),
    ...(sessionId ? { session: sessionId } : {}),
    param_keys: paramKeys,
    ...safeFields,
  });

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
  lines.push('# HELP ico_lookup_total Recent tool calls per IČO retained for up to three days.');
  lines.push('# TYPE ico_lookup_total counter');
  for (const [ico, count] of icoCounter) {
    lines.push(`ico_lookup_total{ico="${escapeLabel(ico)}"} ${count}`);
  }

  // Company name lookup table (info metric) — Grafana join via group_left(name).
  lines.push('');
  lines.push('# HELP ico_company_info Company name per IČO (best-effort from ARES). Value always 1.');
  lines.push('# TYPE ico_company_info gauge');
  for (const [ico, name] of icoNameMap) {
    lines.push(`ico_company_info{ico="${escapeLabel(ico)}",name="${escapeLabel(name)}"} 1`);
  }

  // Search query counters
  lines.push('');
  lines.push('# HELP search_query_total Recent search calls per query+city+street retained for up to three days.');
  lines.push('# TYPE search_query_total counter');
  for (const [key, count] of searchCounter) {
    const [tool, query, city, street] = key.split('\t') as [string, string, string, string];
    lines.push(`search_query_total{tool="${escapeLabel(tool)}",query="${escapeLabel(query)}",city="${escapeLabel(city)}",street="${escapeLabel(street)}"} ${count}`);
  }

  // Per-tool call counter — real tools/call usage (not transport/handshake requests).
  lines.push('');
  lines.push('# HELP mcp_tool_calls_total Tool invocations per server and tool (actual tools/call).');
  lines.push('# TYPE mcp_tool_calls_total counter');
  for (const [key, count] of toolCallCounter) {
    const [server, tool] = key.split('\t') as [string, string];
    lines.push(`mcp_tool_calls_total{server="${escapeLabel(server)}",tool="${escapeLabel(tool)}"} ${count}`);
  }

  return `${lines.join('\n')}\n`;
}

export function cleanup(): void {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 2);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  for (const [date, byIp] of seen) {
    if (date < cutoffDate) seen.delete(date);
    else byIp.sweep();
  }

  icoCounter.sweep();
  icoNameMap.sweep();
  searchCounter.sweep();
  ctaHintCounter.sweep();
  pruneToolEventFiles();
}

const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
cleanupTimer.unref();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeToolEventJsonl(record: Record<string, unknown>): void {
  const dir = process.env.TOOL_EVENTS_DIR?.trim();
  if (!dir) return;

  const file = join(dir, `tool-events-${today()}.jsonl`);
  void appendFile(file, `${JSON.stringify(record)}\n`, 'utf8').catch(() => {});
}

function pruneToolEventFiles(): void {
  const dir = process.env.TOOL_EVENTS_DIR?.trim();
  if (!dir) return;

  const retentionDays = getToolEventsRetentionDays();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  void readdir(dir).then((entries) => {
    for (const entry of entries) {
      const match = /^tool-events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry);
      const fileDate = match?.[1];
      if (!fileDate || fileDate >= cutoffDate) continue;
      void unlink(join(dir, entry)).catch(() => {});
    }
  }).catch(() => {});
}

function ipPrefix(ip: string): string {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const octets = normalized.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    return octets.slice(0, 3).join('.');
  }
  return normalized.split(':').filter(Boolean).slice(0, 3).join(':') || 'unknown';
}

function getCTAEscalationThreshold(): number {
  const parsed = Number.parseInt(process.env.CTA_ESCALATION_THRESHOLD ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CTA_ESCALATION_THRESHOLD;
}

function getToolEventsRetentionDays(): number {
  const parsed = Number.parseInt(process.env.TOOL_EVENTS_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function isSafeLogValue(key: string, value: unknown): boolean {
  if (key === 'ico' || key === 'dic') return true;
  if (key === 'icos' || key === 'dics') return Array.isArray(value);
  // `depth` is a string enum (z.enum(['basic','full'])), not a number — keep it logged.
  if (key === 'depth') return value === 'basic' || value === 'full';
  if (['max_depth', 'since_id', 'limit', 'threshold'].includes(key)) {
    return typeof value === 'number';
  }
  if (key === 'nace') return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,32}$/.test(value);
  if (key === 'only_active') return typeof value === 'boolean';
  return false;
}

function formatLogValue(value: unknown): string {
  if (Array.isArray(value)) return `count:${value.length}`;
  return String(value).replace(/\s+/g, '_');
}
