/**
 * Thin wrapper over the internal connection pool.
 *
 * Provides a JTOpen-compatible API for connection pooling.
 *
 * Upstream: AS400ConnectionPool.java
 * @module compat/AS400ConnectionPool
 */

import { ConnectionPool } from '../internal/pool/ConnectionPool.js';
import { AS400 } from '../core/AS400.js';

export class AS400ConnectionPool {
  /** @type {ConnectionPool} */
  #pool;
  /** @type {object} */
  #defaultOpts;

  /**
   * @param {object} [opts]
   * @param {number} [opts.max=10]
   * @param {number} [opts.idleTimeout=60000]
   * @param {boolean} [opts.secure=false]
   * @param {object} [opts.tlsOptions]
   */
  constructor(opts = {}) {
    this.#pool = new ConnectionPool({
      max: opts.max ?? 10,
      idleTimeout: opts.idleTimeout ?? 60000,
    });
    this.#defaultOpts = {
      secure: opts.secure ?? false,
      tlsOptions: opts.tlsOptions ?? {},
    };
  }

  get size()      { return this.#pool.size; }
  get available() { return this.#pool.available; }
  get inUse()     { return this.#pool.inUse; }

  /**
   * Get a pooled AS400 connection.
   *
   * @param {object} opts
   * @param {string} opts.host
   * @param {string} opts.user
   * @param {string} opts.password
   * @param {boolean} [opts.secure]
   * @returns {Promise<AS400>}
   */
  async getConnection(opts) {
    return this.#pool.acquire(() => {
      return new AS400({
        host: opts.host,
        user: opts.user,
        password: opts.password,
        secure: opts.secure ?? this.#defaultOpts.secure,
        tlsOptions: this.#defaultOpts.tlsOptions,
      });
    });
  }

  /**
   * Return a connection to the pool.
   * @param {AS400} system
   */
  returnConnection(system) {
    this.#pool.release(system);
  }

  /**
   * Close the pool and all connections.
   */
  async close() {
    await this.#pool.close(async (system) => {
      if (typeof system.close === 'function') {
        await system.close();
      }
    });
  }
}
