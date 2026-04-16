/**
 * Tiny in-memory LRU-ish TTL cache — protects upstream APIs (ARES) from
 * getting hammered with repeated identical queries.
 *
 * Not distributed — per-process. For multi-replica deploy, swap for Redis.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(opts: { ttlMs: number; maxSize?: number }) {
    this.ttlMs = opts.ttlMs;
    this.maxSize = opts.maxSize ?? 1000;
  }

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch: re-insert to move to end
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    if (this.map.size >= this.maxSize) {
      // Evict oldest (first iteration order)
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async memoize<T extends V>(key: K, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached as T;
    const value = await loader();
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
