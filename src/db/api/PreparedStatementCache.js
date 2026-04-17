/**
 * Bounded LRU prepared-statement cache keyed by normalized SQL.
 *
 * Lease semantics:
 *   - The cache holds ONLY idle (not-in-use) handles. When a caller
 *     prepares a SQL, the cache lease is removed via `acquire(sql)` —
 *     the cache forgets about it until the caller calls
 *     `release(sql, handle)` to hand it back, at which point it
 *     re-enters the idle set.
 *   - `release(sql, handle)` may displace an LRU entry if the cache is
 *     at capacity; the displaced handle is returned to the caller so
 *     it can be physically closed on the server.
 *   - `clear()` returns the list of still-idle handles so the caller
 *     (typically `Connection.close()`) can physically close them.
 *
 * This design eliminates the bug where `PreparedStatement.close()`
 * physically closed a handle that was still cached — the cache and
 * the active PreparedStatement are never both holding the same handle
 * simultaneously.
 *
 * Upstream: inspired by JTOpen's internal statement pooling
 * (AS400JDBCPreparedStatement handle reuse).
 * @module db/api/PreparedStatementCache
 */

/**
 * Normalize SQL for cache keying: collapse whitespace, upper-case,
 * trim. This is deliberately simple — it doesn't try to be a full
 * SQL normalizer, just enough to collapse trivial formatting
 * differences.
 */
function normalizeKey(sql) {
  return String(sql ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export class PreparedStatementCache {
  #capacity;
  #map;      // Map<string, { handle, sql, lastUsed }> — idle entries only
  #hits;
  #misses;

  /**
   * @param {number} [capacity=64]
   */
  constructor(capacity = 64) {
    this.#capacity = Math.max(1, capacity | 0);
    this.#map = new Map();
    this.#hits = 0;
    this.#misses = 0;
  }

  get capacity() { return this.#capacity; }
  get size()      { return this.#map.size; }
  get hits()      { return this.#hits; }
  get misses()    { return this.#misses; }

  /**
   * Back-compat peek. Returns the cached handle without removing it.
   * Prefer {@link acquire} in lifecycle-aware callers so the handle is
   * correctly leased out to exactly one PreparedStatement at a time.
   * @param {string} sql
   */
  get(sql) {
    const key = normalizeKey(sql);
    const entry = this.#map.get(key);
    if (!entry) {
      this.#misses++;
      return null;
    }
    this.#map.delete(key);
    entry.lastUsed = Date.now();
    this.#map.set(key, entry);
    this.#hits++;
    return entry.handle;
  }

  /**
   * Lease an idle handle out of the cache. Returns the handle (and
   * removes it from the idle set) so the caller has exclusive
   * ownership. Returns null on miss.
   *
   * The cache does not know whether the host still recognizes the
   * handle; it trusts the caller to only release handles that are
   * still valid. `Connection.close()` / `clear()` is the exit path.
   *
   * @param {string} sql
   * @returns {object|null}
   */
  acquire(sql) {
    const key = normalizeKey(sql);
    const entry = this.#map.get(key);
    if (!entry) {
      this.#misses++;
      return null;
    }
    this.#map.delete(key);
    this.#hits++;
    return entry.handle;
  }

  /**
   * Return a handle to the idle set. If the cache is over capacity,
   * evict the least-recently-used entry and return its handle so the
   * caller can physically close it. When `sql` is already cached with
   * a different handle (e.g. a second concurrent prepare completed
   * out-of-order), this method also returns the extra handle so it
   * can be physically closed.
   *
   * @param {string} sql
   * @param {object} handle
   * @returns {object|null} evicted handle that the caller MUST close,
   *   or null if nothing was displaced.
   */
  release(sql, handle) {
    if (!handle) return null;
    const key = normalizeKey(sql);

    // Duplicate entry for the same key — keep the incoming one (most
    // recent) and hand the old one back for physical close.
    if (this.#map.has(key)) {
      const existing = this.#map.get(key);
      this.#map.delete(key);
      this.#map.set(key, { handle, sql, lastUsed: Date.now() });
      return existing.handle;
    }

    // Evict LRU if at capacity.
    let evicted = null;
    if (this.#map.size >= this.#capacity) {
      const lruKey = this.#map.keys().next().value;
      const lruEntry = this.#map.get(lruKey);
      evicted = lruEntry?.handle ?? null;
      this.#map.delete(lruKey);
    }
    this.#map.set(key, { handle, sql, lastUsed: Date.now() });
    return evicted;
  }

  /**
   * Legacy alias for `release`. Returns nothing (the evictee is silently
   * dropped). Prefer `release` so the caller can physically close any
   * evicted handle.
   */
  put(sql, handle) { this.release(sql, handle); }

  /**
   * Remove a specific SQL from the idle set. The caller must physically
   * close the returned handle.
   * @param {string} sql
   * @returns {object|null} the removed handle, or null if absent
   */
  remove(sql) {
    const key = normalizeKey(sql);
    const entry = this.#map.get(key);
    if (!entry) return null;
    this.#map.delete(key);
    return entry.handle;
  }

  /** Back-compat boolean delete. */
  delete(sql) {
    return this.#map.delete(normalizeKey(sql));
  }

  /**
   * Remove all idle entries and return their handles so the caller
   * can physically close them. Typically called from
   * `Connection.close()`.
   * @returns {object[]}
   */
  drain() {
    const handles = [];
    for (const entry of this.#map.values()) {
      if (entry?.handle) handles.push(entry.handle);
    }
    this.#map.clear();
    return handles;
  }

  /** Back-compat: forget all entries (no physical close). */
  clear() {
    this.#map.clear();
  }

  /**
   * Return cache statistics.
   * @returns {{ size: number, capacity: number, hits: number, misses: number, hitRate: number }}
   */
  stats() {
    const total = this.#hits + this.#misses;
    return {
      size: this.#map.size,
      capacity: this.#capacity,
      hits: this.#hits,
      misses: this.#misses,
      hitRate: total > 0 ? this.#hits / total : 0,
    };
  }
}
