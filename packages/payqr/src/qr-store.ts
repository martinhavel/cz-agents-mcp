import { randomUUID } from 'node:crypto';

// Ephemeral in-memory QR store. Holds generated PNGs just long enough for a client
// to fetch them via GET /i/<id>.png. NEVER written to disk: lives only in the running
// process's memory and is gone on restart. Random UUID ids (unguessable), short TTL.
interface Entry {
  png: Buffer;
  expires: number;
}

const store = new Map<string, Entry>();
const TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ENTRIES = 1000;

export function putQr(png: Buffer): string {
  const now = Date.now();
  // Opportunistic cleanup of expired entries (and a hard cap as a backstop).
  if (store.size >= MAX_ENTRIES) {
    for (const [k, v] of store) if (v.expires <= now) store.delete(k);
    if (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest) store.delete(oldest);
    }
  }
  const id = randomUUID();
  store.set(id, { png, expires: now + TTL_MS });
  return id;
}

export function getQr(id: string): Buffer | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    store.delete(id);
    return null;
  }
  return entry.png;
}
