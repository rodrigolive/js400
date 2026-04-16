/**
 * JS connection pool for database connections.
 *
 * Manages a pool of database connections with min/max sizing,
 * idle timeout, and validation on checkout.
 *
 * Upstream: AS400JDBCConnectionPool*.java, AS400JDBCDataSource*.java
 * @module db/pool/ConnectionPool
 */

export class ConnectionPool {
  #connectFn;
  #options;
  #pool;
  #active;
  #closed;
  #idleTimer;
  #totalCreated;

  /**
   * @param {object} options
   * @param {Function} options.connect - async function that returns a Connection
   * @param {number} [options.min=0] - minimum pool size
   * @param {number} [options.max=10] - maximum pool size
   * @param {number} [options.idleTimeout=60000] - idle connection timeout in ms
   * @param {boolean} [options.validateOnCheckout=false] - validate before returning
   * @param {string} [options.validationQuery='VALUES 1'] - SQL to validate connection
   */
  constructor(options = {}) {
    this.#connectFn = options.connect || null;
    this.#options = {
      min: options.min ?? 0,
      max: options.max ?? 10,
      idleTimeout: options.idleTimeout ?? 60_000,
      validateOnCheckout: options.validateOnCheckout ?? false,
      validationQuery: options.validationQuery ?? 'VALUES 1',
    };
    this.#pool = [];
    this.#active = new Set();
    this.#closed = false;
    this.#totalCreated = 0;
    this.#idleTimer = null;

    if (this.#options.idleTimeout > 0) {
      this.#startIdleSweep();
    }
  }

  get size() { return this.#pool.length + this.#active.size; }
  get available() { return this.#pool.length; }
  get activeCount() { return this.#active.size; }
  get closed() { return this.#closed; }

  /**
   * Get a connection from the pool.
   * @returns {Promise<PooledConnection>}
   */
  async getConnection() {
    if (this.#closed) {
      throw new Error('Connection pool is closed');
    }

    // Try to reuse an idle connection
    while (this.#pool.length > 0) {
      const entry = this.#pool.pop();
      const conn = entry.connection;

      if (this.#options.validateOnCheckout) {
        try {
          await conn.query(this.#options.validationQuery);
        } catch {
          try { await conn.close(); } catch { /* ignore */ }
          continue;
        }
      }

      this.#active.add(conn);
      entry.lastUsed = Date.now();
      conn._poolEntry = entry;
      conn._pool = this;
      return conn;
    }

    // Create a new connection if under max
    if (this.size < this.#options.max) {
      return this.#createConnection();
    }

    // Wait for a connection to be released (simple spin with yield)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection pool exhausted'));
      }, 30_000);

      const check = () => {
        if (this.#closed) {
          clearTimeout(timeout);
          reject(new Error('Connection pool is closed'));
          return;
        }
        if (this.#pool.length > 0) {
          clearTimeout(timeout);
          this.getConnection().then(resolve, reject);
          return;
        }
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });
  }

  /**
   * Release a connection back to the pool.
   * @param {object} conn
   */
  release(conn) {
    if (this.#closed) {
      try { conn.close(); } catch { /* ignore */ }
      return;
    }

    this.#active.delete(conn);

    const entry = conn._poolEntry || { connection: conn, created: Date.now() };
    entry.lastUsed = Date.now();

    this.#pool.push(entry);
  }

  /**
   * Shorthand: get a connection, run a query, release the connection.
   * @param {string} sql
   * @param {any[]} [params]
   * @returns {Promise<object[]>}
   */
  async query(sql, params) {
    const conn = await this.getConnection();
    try {
      return await conn.query(sql, params);
    } finally {
      this.release(conn);
    }
  }

  /**
   * Shorthand: get a connection, execute DML, release.
   * @param {string} sql
   * @param {any[]} [params]
   * @returns {Promise<object>}
   */
  async execute(sql, params) {
    const conn = await this.getConnection();
    try {
      return await conn.execute(sql, params);
    } finally {
      this.release(conn);
    }
  }

  /**
   * Fill the pool to the minimum size.
   */
  async warmup() {
    const needed = this.#options.min - this.size;
    for (let i = 0; i < needed; i++) {
      try {
        const conn = await this.#createConnectionRaw();
        const entry = {
          connection: conn,
          created: Date.now(),
          lastUsed: Date.now(),
        };
        this.#pool.push(entry);
      } catch {
        break;
      }
    }
  }

  /**
   * Close all connections and shut down the pool.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = null;
    }

    const closePromises = [];

    for (const entry of this.#pool) {
      closePromises.push(
        entry.connection.close().catch(() => {}),
      );
    }
    this.#pool.length = 0;

    for (const conn of this.#active) {
      closePromises.push(
        conn.close().catch(() => {}),
      );
    }
    this.#active.clear();

    await Promise.all(closePromises);
  }

  async #createConnection() {
    const conn = await this.#createConnectionRaw();
    const entry = {
      connection: conn,
      created: Date.now(),
      lastUsed: Date.now(),
    };
    conn._poolEntry = entry;
    conn._pool = this;
    this.#active.add(conn);
    return conn;
  }

  async #createConnectionRaw() {
    if (!this.#connectFn) {
      throw new Error('No connect function provided to pool');
    }
    this.#totalCreated++;
    return this.#connectFn();
  }

  #startIdleSweep() {
    this.#idleTimer = setInterval(() => {
      const now = Date.now();
      const timeout = this.#options.idleTimeout;
      const minKeep = this.#options.min;

      let i = this.#pool.length - 1;
      while (i >= 0 && this.#pool.length > minKeep) {
        const entry = this.#pool[i];
        if (now - entry.lastUsed > timeout) {
          this.#pool.splice(i, 1);
          entry.connection.close().catch(() => {});
        }
        i--;
      }
    }, Math.min(this.#options.idleTimeout, 30_000));

    // Allow the process to exit without waiting for the timer
    if (this.#idleTimer.unref) {
      this.#idleTimer.unref();
    }
  }
}
