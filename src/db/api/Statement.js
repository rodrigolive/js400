/**
 * Public SQL statement API.
 *
 * Provides simple query() and execute() methods for ad-hoc SQL execution.
 * For parameterized queries, use PreparedStatement instead.
 *
 * Upstream: AS400JDBCStatement.java
 * @module db/api/Statement
 */

import { ResultSet } from './ResultSet.js';

export class Statement {
  #dbConnection;
  #closed;

  /**
   * @param {import('../engine/DbConnection.js').DbConnection} dbConnection
   */
  constructor(dbConnection) {
    this.#dbConnection = dbConnection;
    this.#closed = false;
  }

  get closed() { return this.#closed; }

  /**
   * Execute a query and return rows as plain JS objects.
   * @param {string} sql
   * @returns {Promise<object[]>}
   */
  async query(sql) {
    this.#ensureOpen();
    const stmtHandle = await this.#dbConnection.prepareStatement(sql);
    try {
      const result = await this.#dbConnection.statementManager.execute(stmtHandle);

      if (result.hasResultSet) {
        const rs = new ResultSet({
          rows: result.rows,
          columnDescriptors: result.columnDescriptors,
          cursorManager: this.#dbConnection.cursorManager,
          rpbId: result.rpbId,
          endOfData: result.endOfData,
        });
        const rows = await rs.toArray();
        await rs.close();
        await this.#dbConnection.statementManager.closeStatement(stmtHandle);
        return rows;
      }

      await this.#dbConnection.statementManager.closeStatement(stmtHandle);
      return [];
    } catch (err) {
      try { await this.#dbConnection.statementManager.closeStatement(stmtHandle); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Execute a DML statement (INSERT, UPDATE, DELETE, MERGE) or DDL.
   * @param {string} sql
   * @param {object} [opts]
   * @param {boolean} [opts.returnGeneratedKeys=false]
   * @returns {Promise<{ affectedRows: number, generatedKeys?: object[] }>}
   */
  async execute(sql, opts = {}) {
    this.#ensureOpen();
    const result = await this.#dbConnection.executeImmediate(sql);
    return {
      affectedRows: result.affectedRows,
    };
  }

  /**
   * Close this statement.
   */
  async close() {
    this.#closed = true;
  }

  #ensureOpen() {
    if (this.#closed) {
      throw new Error('Statement is closed');
    }
  }
}
