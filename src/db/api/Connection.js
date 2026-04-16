/**
 * High-level SQL connection API.
 *
 * Wraps the engine-level DbConnection with an ergonomic JS interface
 * that provides query(), execute(), prepare(), call(), metadata(),
 * and transaction control methods.
 *
 * Upstream: AS400JDBCConnectionImpl.java
 * @module db/api/Connection
 */

import { Statement } from './Statement.js';
import { PreparedStatement } from './PreparedStatement.js';
import { CallableStatement } from './CallableStatement.js';
import { DatabaseMetaData } from './DatabaseMetaData.js';
import { ResultSet } from './ResultSet.js';

export class Connection {
  #dbConnection;
  #closed;

  /**
   * @param {import('../engine/DbConnection.js').DbConnection} dbConnection
   */
  constructor(dbConnection) {
    this.#dbConnection = dbConnection;
    this.#closed = false;
  }

  get connected() { return this.#dbConnection.connected && !this.#closed; }
  get closed() { return this.#closed; }

  /**
   * Execute a SELECT query and return rows as plain JS objects.
   * Supports optional parameter markers.
   *
   * @param {string} sql
   * @param {any[]} [params]
   * @returns {Promise<object[]>}
   */
  async query(sql, params) {
    this.#ensureOpen();

    if (params && params.length > 0) {
      const stmt = await this.prepare(sql);
      try {
        const result = await stmt.execute(params);
        return Array.isArray(result) ? result : [];
      } finally {
        await stmt.close();
      }
    }

    const statement = new Statement(this.#dbConnection);
    return statement.query(sql);
  }

  /**
   * Execute a DML statement (INSERT, UPDATE, DELETE, MERGE) or DDL.
   * Returns { affectedRows }.
   *
   * @param {string} sql
   * @param {any[]} [params]
   * @param {object} [opts]
   * @param {boolean} [opts.returnGeneratedKeys=false]
   * @returns {Promise<{ affectedRows: number, generatedKeys?: object[] }>}
   */
  async execute(sql, params, opts = {}) {
    this.#ensureOpen();

    if (params && params.length > 0) {
      const stmt = await this.prepare(sql);
      try {
        const result = await stmt.execute(params);
        if (Array.isArray(result)) {
          return { affectedRows: result.length };
        }
        return result;
      } finally {
        await stmt.close();
      }
    }

    return this.#dbConnection.executeImmediate(sql);
  }

  /**
   * Prepare a SQL statement for repeated execution.
   *
   * @param {string} sql
   * @returns {Promise<PreparedStatement>}
   */
  async prepare(sql) {
    this.#ensureOpen();
    const handle = await this.#dbConnection.prepareStatement(sql);
    return new PreparedStatement(this.#dbConnection, handle, sql);
  }

  /**
   * Call a stored procedure.
   *
   * @param {string} procedureName
   * @param {object} [opts]
   * @param {any[]} [opts.in]
   * @param {object[]} [opts.out]
   * @returns {Promise<{ out: any[], resultSets: object[][] }>}
   */
  async call(procedureName, opts = {}) {
    this.#ensureOpen();
    const callable = new CallableStatement(this);
    return callable.call(procedureName, opts);
  }

  /**
   * Get a DatabaseMetaData helper for schema discovery.
   * @returns {DatabaseMetaData}
   */
  metadata() {
    this.#ensureOpen();
    return new DatabaseMetaData(this);
  }

  // --- Transaction control ---

  /**
   * Begin an explicit transaction (disable auto-commit).
   */
  async begin() {
    this.#ensureOpen();
    this.#dbConnection.setAutoCommit(false);
  }

  /**
   * Commit the current transaction.
   */
  async commit() {
    this.#ensureOpen();
    await this.#dbConnection.commit();
  }

  /**
   * Rollback the current transaction or to a savepoint.
   * @param {import('../engine/TransactionManager.js').Savepoint} [savepoint]
   */
  async rollback(savepoint) {
    this.#ensureOpen();
    if (savepoint) {
      await this.#dbConnection.rollbackToSavepoint(savepoint);
    } else {
      await this.#dbConnection.rollback();
    }
  }

  /**
   * Create a named savepoint.
   * @param {string} [name]
   * @returns {Promise<import('../engine/TransactionManager.js').Savepoint>}
   */
  async savepoint(name) {
    this.#ensureOpen();
    return this.#dbConnection.setSavepoint(name);
  }

  /**
   * Set auto-commit mode.
   * @param {boolean} value
   */
  setAutoCommit(value) {
    this.#dbConnection.setAutoCommit(value);
  }

  /**
   * Get auto-commit mode.
   * @returns {boolean}
   */
  getAutoCommit() {
    return this.#dbConnection.getAutoCommit();
  }

  /**
   * Release a connection back to a pool (if pooled).
   */
  release() {
    if (this._pool) {
      this._pool.release(this);
    }
  }

  /**
   * Close the connection.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#dbConnection.close();
  }

  #ensureOpen() {
    if (this.#closed) {
      throw new Error('Connection is closed');
    }
  }
}
