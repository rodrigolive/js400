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
        fetchSize: result.blockingFactor ?? 2048,
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
      fetchSize: result.blockingFactor ?? 2048,
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
   *
   * N rows are packed into one EXECUTE request per chunk (up to 32000
   * rows per JTOpen's getMaximumBlockedInputRows cap), matching the
   * JTOpen behaviour. This is one round trip per chunk instead of one
   * round trip per row.
   *
   * The per-row updateCounts follow the JTOpen convention:
   * SUCCESS_NO_INFO (-2) for non-INSERT or when the host didn't tell
   * us the batch total matched the batch size; 1 per row when both
   * conditions hold.
   *
   * @param {any[][]} paramSets
   * @returns {Promise<{ updateCounts: number[], totalAffected: number }>}
   */
  async executeBatch(paramSets) {
    this.#ensureOpen();

    const batchSize = paramSets?.length ?? 0;
    if (batchSize === 0) {
      return { updateCounts: [], totalAffected: 0 };
    }

    const result = await this.#dbConnection.statementManager.executeBatch(
      this.#stmtHandle, paramSets,
    );

    // Per AS400JDBCPreparedStatementImpl.executeBatch (lines 1717-1723):
    // the host server returns a single total updateCount for the whole
    // batch, not per-row counts. If the total matches batchSize AND the
    // statement is INSERT, each updateCount is 1; otherwise -2.
    const perRow = (result.isInsert && result.affectedRows === batchSize) ? 1 : -2;
    const updateCounts = new Array(batchSize).fill(perRow);

    return {
      updateCounts,
      totalAffected: result.affectedRows,
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
