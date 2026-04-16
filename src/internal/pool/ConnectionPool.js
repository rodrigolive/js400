/**
 * Generic connection pool engine.
 *
 * Manages a pool of AS400 instances with configurable max connections
 * and idle timeout with automatic reaping.
 *
 * Upstream: ConnectionPool*.java
 * @module internal/pool/ConnectionPool
 */

import { Trace } from '../../core/Trace.js';

/**
 * @typedef {object} PoolEntry
 * @property {*} resource
 * @property {number} lastUsed
 * @property {boolean} inUse
 */

export class ConnectionPool {
  /** @type {number} */
  #max;
  /** @type {number} */
  #idleTimeout;
  /** @type {PoolEntry[]} */
  #entries;
  /** @type {boolean} */
  #closed;
  /** @type {ReturnType<typeof setInterval>|null} */
  #reaper;

  /**
   * @param {object} [opts]
   * @param {number} [opts.max=10]           - Max connections in the pool
   * @param {number} [opts.idleTimeout=60000] - Idle timeout in ms
   */
  constructor(opts = {}) {
    this.#max = opts.max ?? 10;
    this.#idleTimeout = opts.idleTimeout ?? 60000;
    this.#entries = [];
    this.#closed = false;
    this.#reaper = null;

    // Start idle reaper
    if (this.#idleTimeout > 0) {
      this.#reaper = setInterval(() => this.#reapIdle(), this.#idleTimeout);
      if (this.#reaper.unref) this.#reaper.unref();
    }
  }

  get size()      { return this.#entries.length; }
  get available() { return this.#entries.filter(e => !e.inUse).length; }
  get inUse()     { return this.#entries.filter(e => e.inUse).length; }
  get max()       { return this.#max; }
  get closed()    { return this.#closed; }

  /**
   * Acquire a resource from the pool.
   *
   * @param {Function} factory - async () => resource. Called if no idle resource exists.
   * @returns {Promise<*>} The acquired resource
   */
  async acquire(factory) {
    if (this.#closed) {
      throw new Error('Pool is closed');
    }

    // Try to find an idle entry
    for (const entry of this.#entries) {
      if (!entry.inUse) {
        entry.inUse = true;
        entry.lastUsed = Date.now();
        return entry.resource;
      }
    }

    // No idle entry -- create new if under max
    if (this.#entries.length < this.#max) {
      const resource = await factory();
      const entry = { resource, lastUsed: Date.now(), inUse: true };
      this.#entries.push(entry);
      return resource;
    }

    // Pool exhausted -- wait for a release
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.#closed) {
          reject(new Error('Pool closed while waiting'));
          return;
        }
        for (const entry of this.#entries) {
          if (!entry.inUse) {
            entry.inUse = true;
            entry.lastUsed = Date.now();
            resolve(entry.resource);
            return;
          }
        }
        // Still no idle -- try again shortly
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * Release a resource back to the pool.
   * @param {*} resource
   */
  release(resource) {
    for (const entry of this.#entries) {
      if (entry.resource === resource) {
        entry.inUse = false;
        entry.lastUsed = Date.now();
        return;
      }
    }
    // Resource not found in pool -- ignore
    if (Trace.isTraceOn() && Trace.isTraceWarningOn()) {
      Trace.log(Trace.WARNING, 'ConnectionPool.release: resource not found in pool');
    }
  }

  /**
   * Remove a resource from the pool entirely.
   * @param {*} resource
   */
  remove(resource) {
    const idx = this.#entries.findIndex(e => e.resource === resource);
    if (idx >= 0) {
      this.#entries.splice(idx, 1);
    }
  }

  /**
   * Close the pool and destroy all resources.
   * @param {Function} [destroyer] - Optional async (resource) => void to close each resource
   */
  async close(destroyer) {
    this.#closed = true;
    if (this.#reaper) {
      clearInterval(this.#reaper);
      this.#reaper = null;
    }

    for (const entry of this.#entries) {
      try {
        if (destroyer) {
          await destroyer(entry.resource);
        } else if (typeof entry.resource.close === 'function') {
          await entry.resource.close();
        }
      } catch (err) {
        if (Trace.isTraceOn() && Trace.isTraceErrorOn()) {
          Trace.log(Trace.ERROR, 'ConnectionPool.close: error closing resource', err);
        }
      }
    }
    this.#entries.length = 0;
  }

  /**
   * Reap idle connections.
   */
  #reapIdle() {
    const now = Date.now();
    const threshold = now - this.#idleTimeout;
    const toRemove = [];

    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i];
      if (!entry.inUse && entry.lastUsed < threshold) {
        toRemove.push(i);
      }
    }

    for (const idx of toRemove) {
      const entry = this.#entries[idx];
      this.#entries.splice(idx, 1);
      try {
        if (typeof entry.resource.close === 'function') {
          entry.resource.close();
        }
      } catch {
        // ignore
      }
    }

    if (toRemove.length > 0 && Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `ConnectionPool: reaped ${toRemove.length} idle connections`);
    }
  }
}
