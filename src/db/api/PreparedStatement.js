/**
 * Public prepared statement API.
 *
 * Wraps the engine-level prepared statement handle with parameter
 * binding, execution, streaming (async iterable), and batch support.
 *
 * Upstream: AS400JDBCPreparedStatement*.java
 * @module db/api/PreparedStatement
 */

import { ResultSet } from './ResultSet.js';

export class PreparedStatement {
  #dbConnection;
  #stmtHandle;
  #sql;
  #closed;

  /**
   * @param {import('../engine/DbConnection.js').DbConnection} dbConnection
   * @param {object} stmtHandle - engine-level prepared statement handle
   * @param {string} sql - the SQL text
   */
  constructor(dbConnection, stmtHandle, sql) {
    this.#dbConnection = dbConnection;
    this.#stmtHandle = stmtHandle;
    this.#sql = sql;
    this.#closed = false;
  }

  get closed() { return this.#closed; }
  get sql() { return this.#sql; }
  get parameterCount() { return this.#stmtHandle.paramCount; }
  get columnCount() { return this.#stmtHandle.columnCount; }

  /**
   * Get parameter metadata.
   * @returns {object[]}
   */
  get parameterMetadata() {
    return this.#stmtHandle.paramDescriptors.map(desc => ({
      sqlType: desc.sqlType,
      typeName: desc.typeName,
      precision: desc.precision,
      scale: desc.scale,
      nullable: desc.nullable,
    }));
  }

  /**
   * Execute the prepared statement with optional parameters.
   * Returns rows for SELECT or { affectedRows } for DML.
   *
   * @param {any[]} [params=[]]
   * @param {object} [opts={}]
   * @param {boolean} [opts.returnGeneratedKeys=false]
   * @returns {Promise<object[]|{ affectedRows: number, generatedKeys?: object[] }>}
   */
  async execute(params = [], opts = {}) {
    this.#ensureOpen();
    const result = await this.#dbConnection.statementManager.execute(
      this.#stmtHandle, params, opts,
    );

    if (result.hasResultSet) {
      const rs = new ResultSet({
        rows: result.rows,
        columnDescriptors: result.columnDescriptors,
        cursorManager: this.#dbConnection.cursorManager,
        rpbId: result.rpbId,
        endOfData: result.endOfData,
      });
      return rs.toArray();
    }

    return {
      affectedRows: result.affectedRows,
    };
  }

  /**
   * Execute and return a ResultSet for cursor-based access.
   * @param {any[]} [params=[]]
   * @returns {Promise<ResultSet>}
   */
  async executeForStream(params = []) {
    this.#ensureOpen();
    const result = await this.#dbConnection.statementManager.execute(
      this.#stmtHandle, params,
    );

    return new ResultSet({
      rows: result.rows,
      columnDescriptors: result.columnDescriptors,
      cursorManager: this.#dbConnection.cursorManager,
      rpbId: result.rpbId,
      endOfData: result.endOfData,
    });
  }

  /**
   * Execute and return an async iterable that yields rows one at a time.
   * @param {any[]} [params=[]]
   * @returns {AsyncIterable<object>}
   */
  stream(params = []) {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        let rs = null;
        let iter = null;

        return {
          async next() {
            if (!rs) {
              rs = await self.executeForStream(params);
              iter = rs[Symbol.asyncIterator]();
            }
            return iter.next();
          },
          async return() {
            if (rs) await rs.close();
            return { done: true };
          },
        };
      },
    };
  }

  /**
   * Execute a batch of parameter sets.
   * @param {any[][]} paramSets
   * @returns {Promise<{ updateCounts: number[], totalAffected: number }>}
   */
  async executeBatch(paramSets) {
    this.#ensureOpen();
    const updateCounts = [];

    for (const params of paramSets) {
      const result = await this.#dbConnection.statementManager.execute(
        this.#stmtHandle, params,
      );
      updateCounts.push(result.affectedRows);
    }

    return {
      updateCounts,
      totalAffected: updateCounts.reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Close the prepared statement and release server resources.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#dbConnection.statementManager.closeStatement(this.#stmtHandle);
    } catch { /* ignore close errors */ }
  }

  #ensureOpen() {
    if (this.#closed) {
      throw new Error('PreparedStatement is closed');
    }
  }
}
