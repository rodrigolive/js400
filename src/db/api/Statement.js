/**
 * Public SQL statement API.
 *
 * Provides ad-hoc SQL execution: query(), execute(), addBatch(String),
 * executeBatch(), cancel(), getGeneratedKeys(), getMoreResults(), warnings.
 * For parameterized queries, use PreparedStatement instead.
 *
 * Upstream: AS400JDBCStatement.java
 * @module db/api/Statement
 */

import { ResultSet, ResultSetType, ResultSetConcurrency, ResultSetHoldability } from './ResultSet.js';
import { SqlWarning } from './SqlWarning.js';

/** JDBC Statement.SUCCESS_NO_INFO sentinel used in executeBatch updateCounts. */
export const SUCCESS_NO_INFO = -2;
/** JDBC Statement.EXECUTE_FAILED sentinel used in executeBatch updateCounts. */
export const EXECUTE_FAILED = -3;
/** JDBC Statement.RETURN_GENERATED_KEYS / NO_GENERATED_KEYS. */
export const RETURN_GENERATED_KEYS = 1;
export const NO_GENERATED_KEYS = 2;
/** JDBC Statement.CLOSE_CURRENT_RESULT / KEEP_CURRENT_RESULT / CLOSE_ALL_RESULTS. */
export const CLOSE_CURRENT_RESULT = 1;
export const KEEP_CURRENT_RESULT  = 2;
export const CLOSE_ALL_RESULTS    = 3;

function isInsertSql(sql) {
  const stripped = String(sql ?? '').trimStart()
    .replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s+)+/, '');
  return /^INSERT\b/i.test(stripped);
}

export class Statement {
  #dbConnection;
  #closed;
  #cursorName;
  #fetchSize;
  #fetchDirection;
  #maxRows;
  #maxFieldSize;
  #queryTimeout;
  #escapeProcessing;
  #poolable;
  #closeOnCompletion;
  #type;
  #concurrency;
  #holdability;
  #batch;                 // array<string> accumulated via addBatch(sql)
  #warnings;
  #lastResultSet;
  #lastUpdateCount;
  #pendingResults;        // queue of additional result sets for getMoreResults()
  #lastGeneratedKeys;     // { rows, columnDescriptors } | null
  #cancelled;
  #activeHandle;          // engine-level prepared handle owned by this Statement
  #activeHandleClosed;    // idempotent guard for the active handle's cleanup
  #owningConnection;      // high-level Connection wrapper (for JDBC getConnection)

  /**
   * @param {import('../engine/DbConnection.js').DbConnection} dbConnection
   * @param {object} [opts]
   * @param {number} [opts.type=ResultSetType.forwardOnly]
   * @param {number} [opts.concurrency=ResultSetConcurrency.readOnly]
   * @param {number} [opts.holdability=ResultSetHoldability.closeCursorsAtCommit]
   * @param {object} [opts.connection] - owning high-level Connection wrapper
   *   returned by `getConnection()`. Falls back to the engine DbConnection
   *   for legacy callers.
   */
  constructor(dbConnection, opts = {}) {
    this.#dbConnection = dbConnection;
    this.#owningConnection = opts.connection ?? null;
    this.#closed = false;
    this.#cursorName = null;
    this.#fetchSize = 0;
    this.#fetchDirection = 1000; // FetchDirection.forward
    this.#maxRows = 0;
    this.#maxFieldSize = 0;
    this.#queryTimeout = 0;
    this.#escapeProcessing = true;
    this.#poolable = false;
    this.#closeOnCompletion = false;
    this.#type = opts.type ?? ResultSetType.forwardOnly;
    this.#concurrency = opts.concurrency ?? ResultSetConcurrency.readOnly;
    this.#holdability = opts.holdability ?? ResultSetHoldability.closeCursorsAtCommit;
    this.#batch = [];
    this.#warnings = null;
    this.#lastResultSet = null;
    this.#lastUpdateCount = -1;
    this.#pendingResults = [];
    this.#lastGeneratedKeys = null;
    this.#cancelled = false;
    this.#activeHandle = null;
    this.#activeHandleClosed = false;
  }

  get closed() { return this.#closed; }

  /**
   * Execute a query and return rows as plain JS objects.
   * @param {string} sql
   * @returns {Promise<object[]>}
   */
  async query(sql) {
    this.#ensureOpen();
    this.#resetStateForExecute();

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
          fetchSize: this.#fetchSize || result.blockingFactor || 2048,
          type: this.#type,
          concurrency: this.#concurrency,
          holdability: this.#holdability,
        });
        const rows = await rs.toArray();
        await rs.close();
        await this.#dbConnection.statementManager.closeStatement(stmtHandle);
        const capped = this.#maxRows > 0 ? rows.slice(0, this.#maxRows) : rows;
        this.#lastUpdateCount = -1;
        return capped;
      }

      await this.#dbConnection.statementManager.closeStatement(stmtHandle);
      this.#lastUpdateCount = result.affectedRows ?? 0;
      return [];
    } catch (err) {
      try { await this.#dbConnection.statementManager.closeStatement(stmtHandle); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Execute a DML statement (INSERT, UPDATE, DELETE, MERGE) or DDL.
   * @param {string} sql
   * @param {object|number} [opts]
   * @param {boolean|number} [opts.returnGeneratedKeys=false] - pass true or Statement.RETURN_GENERATED_KEYS
   * @returns {Promise<{ affectedRows: number, generatedKeys?: object[] }>}
   */
  async execute(sql, opts = {}) {
    this.#ensureOpen();
    this.#resetStateForExecute();

    const wantsKeys = typeof opts === 'number'
      ? opts === RETURN_GENERATED_KEYS
      : Boolean(opts?.returnGeneratedKeys);

    if (wantsKeys && isInsertSql(sql)) {
      const wrapped = `SELECT * FROM FINAL TABLE (${sql})`;
      const stmtHandle = await this.#dbConnection.prepareStatement(wrapped);
      try {
        const result = await this.#dbConnection.statementManager.execute(stmtHandle);
        const rows = result.hasResultSet ? result.rows : [];
        this.#lastGeneratedKeys = {
          rows: [...rows],
          columnDescriptors: result.columnDescriptors || [],
        };
        this.#lastUpdateCount = rows.length;
        return { affectedRows: rows.length, generatedKeys: rows };
      } finally {
        try { await this.#dbConnection.statementManager.closeStatement(stmtHandle); } catch { /* ignore */ }
      }
    }

    const result = await this.#dbConnection.executeImmediate(sql);
    this.#lastUpdateCount = result.affectedRows ?? 0;
    return { affectedRows: result.affectedRows };
  }

  /**
   * JDBC executeQuery.
   * @param {string} sql
   * @returns {Promise<ResultSet>}
   */
  async executeQuery(sql) {
    this.#ensureOpen();
    this.#resetStateForExecute();

    // A Statement only owns one active prepared handle at a time. If a
    // prior executeQuery left one open (because the caller discarded
    // the ResultSet without closing it), close it deterministically
    // before we prepare a new one.
    await this.#closeActiveHandle();

    const stmtHandle = await this.#dbConnection.prepareStatement(sql);
    this.#activeHandle = stmtHandle;
    this.#activeHandleClosed = false;

    let result;
    try {
      result = await this.#dbConnection.statementManager.execute(stmtHandle);
    } catch (err) {
      await this.#closeActiveHandle();
      throw err;
    }

    if (!result.hasResultSet) {
      await this.#closeActiveHandle();
      throw new Error('executeQuery called on a non-result-set statement');
    }

    const rs = new ResultSet({
      rows: result.rows,
      columnDescriptors: result.columnDescriptors,
      cursorManager: this.#dbConnection.cursorManager,
      rpbId: result.rpbId,
      endOfData: result.endOfData,
      fetchSize: this.#fetchSize || result.blockingFactor || 2048,
      type: this.#type,
      concurrency: this.#concurrency,
      holdability: this.#holdability,
      // Tie the engine-level prepared handle to the ResultSet's life.
      // When the caller closes the ResultSet (or the Statement closes
      // it on their behalf), the handle is closed exactly once via
      // StatementManager.closeStatement.
      onClose: () => this.#closeActiveHandle(),
    });
    this.#lastResultSet = rs;
    this.#lastUpdateCount = -1;
    return rs;
  }

  /**
   * JDBC executeUpdate.
   * @param {string} sql
   * @param {object|number} [opts]
   * @returns {Promise<number>} affected rows
   */
  async executeUpdate(sql, opts) {
    const r = await this.execute(sql, opts);
    return r.affectedRows ?? 0;
  }

  // --- Batch ---

  /** Add a SQL string to the batch. */
  addBatch(sql) {
    this.#batch.push(String(sql));
  }

  /** Clear the accumulated batch. */
  clearBatch() {
    this.#batch = [];
  }

  /**
   * Execute all SQL statements added via addBatch().
   * @returns {Promise<number[]>} per-statement update counts
   */
  async executeBatch() {
    this.#ensureOpen();
    const batch = this.#batch;
    this.#batch = [];
    const counts = new Array(batch.length);
    for (let i = 0; i < batch.length; i++) {
      try {
        const r = await this.#dbConnection.executeImmediate(batch[i]);
        counts[i] = r.affectedRows ?? SUCCESS_NO_INFO;
      } catch (err) {
        counts[i] = EXECUTE_FAILED;
        this.addWarning(`Batch element ${i} failed: ${err.message}`);
      }
    }
    return counts;
  }

  /**
   * Return the generated-keys ResultSet from the last execute() that
   * was run with `{ returnGeneratedKeys: true }`.
   * @returns {ResultSet}
   */
  getGeneratedKeys() {
    const captured = this.#lastGeneratedKeys || { rows: [], columnDescriptors: [] };
    return new ResultSet({
      rows: captured.rows,
      columnDescriptors: captured.columnDescriptors,
      endOfData: true,
    });
  }

  /**
   * JDBC Statement.getResultSet — returns the current result set or null
   * if the last execution was an update.
   */
  getResultSet() {
    return this.#lastResultSet;
  }

  /** @returns {number} last execute's affected rows (or -1 for SELECT). */
  getUpdateCount() {
    return this.#lastUpdateCount;
  }

  /**
   * Advance to the next result of a multi-result execution.
   * @param {number} [current=CLOSE_CURRENT_RESULT]
   * @returns {Promise<boolean>} true if the next result is a ResultSet.
   */
  async getMoreResults(current = CLOSE_CURRENT_RESULT) {
    if (current === CLOSE_CURRENT_RESULT && this.#lastResultSet) {
      try { await this.#lastResultSet.close(); } catch { /* ignore */ }
    } else if (current === CLOSE_ALL_RESULTS) {
      try { if (this.#lastResultSet) await this.#lastResultSet.close(); } catch { /* ignore */ }
      for (const rs of this.#pendingResults) {
        try { await rs.close(); } catch { /* ignore */ }
      }
      this.#pendingResults = [];
      this.#lastResultSet = null;
      this.#lastUpdateCount = -1;
      return false;
    }

    const next = this.#pendingResults.shift();
    if (next) {
      this.#lastResultSet = next;
      this.#lastUpdateCount = -1;
      return true;
    }
    this.#lastResultSet = null;
    this.#lastUpdateCount = -1;
    return false;
  }

  // --- Cursor / fetch / limits ---

  /**
   * Set the SQL cursor name used by positioned UPDATE / DELETE.
   * Stored on the statement; applied to the server at prepare time.
   */
  setCursorName(name) { this.#cursorName = String(name ?? ''); }
  getCursorName()     { return this.#cursorName; }

  setFetchSize(n)      { this.#fetchSize = Math.max(0, n | 0); }
  getFetchSize()       { return this.#fetchSize; }
  setFetchDirection(d) { this.#fetchDirection = d; }
  getFetchDirection()  { return this.#fetchDirection; }

  setMaxRows(n)        { this.#maxRows = Math.max(0, n | 0); }
  getMaxRows()         { return this.#maxRows; }
  setMaxFieldSize(n)   { this.#maxFieldSize = Math.max(0, n | 0); }
  getMaxFieldSize()    { return this.#maxFieldSize; }
  setQueryTimeout(n)   { this.#queryTimeout = Math.max(0, n | 0); }
  getQueryTimeout()    { return this.#queryTimeout; }
  setEscapeProcessing(v){ this.#escapeProcessing = Boolean(v); }
  getEscapeProcessing() { return this.#escapeProcessing; }
  setPoolable(v)       { this.#poolable = Boolean(v); }
  isPoolable()         { return this.#poolable; }
  closeOnCompletion()  { this.#closeOnCompletion = true; }
  isCloseOnCompletion() { return this.#closeOnCompletion; }

  getResultSetType()        { return this.#type; }
  getResultSetConcurrency() { return this.#concurrency; }
  getResultSetHoldability() { return this.#holdability; }

  /** Mark statement as cancelled. No-op on the server side for now. */
  cancel() { this.#cancelled = true; }
  /** @returns {boolean} */
  isCancelled() { return this.#cancelled; }

  /** @returns {SqlWarning|null} */
  getWarnings() { return this.#warnings; }
  clearWarnings() { this.#warnings = null; }
  addWarning(msg, opts = {}) {
    const w = msg instanceof SqlWarning ? msg : new SqlWarning(msg, opts);
    if (!this.#warnings) this.#warnings = w;
    else this.#warnings.setNextWarning(w);
  }

  /**
   * JDBC `Statement.getConnection()`: returns the high-level `Connection`
   * wrapper that produced this statement, not the engine-level
   * `DbConnection`. Falls back to the engine connection for callers that
   * constructed a Statement directly (legacy path).
   * @returns {object}
   */
  getConnection() {
    return this.#owningConnection ?? this.#dbConnection;
  }

  /**
   * Close this statement.
   */
  async close() {
    this.#closed = true;
    if (this.#lastResultSet) {
      // ResultSet.close() invokes our onClose hook, which closes
      // the active prepared handle. Do not close the handle again here.
      try { await this.#lastResultSet.close(); } catch { /* ignore */ }
      this.#lastResultSet = null;
    }
    for (const rs of this.#pendingResults) {
      try { await rs.close(); } catch { /* ignore */ }
    }
    this.#pendingResults = [];
    // Safety-net cleanup: if the caller never opened a ResultSet (or
    // dropped it) the onClose hook never ran. Close the handle now.
    await this.#closeActiveHandle();
  }

  #resetStateForExecute() {
    this.#lastResultSet = null;
    this.#lastUpdateCount = -1;
    this.#lastGeneratedKeys = null;
  }

  /**
   * Idempotent cleanup for the engine-level prepared handle owned by
   * this Statement. Guaranteed to call StatementManager.closeStatement
   * at most once per handle, whether triggered by ResultSet.close(),
   * Statement.close(), or an executeQuery() failure.
   */
  async #closeActiveHandle() {
    if (this.#activeHandleClosed) return;
    const handle = this.#activeHandle;
    this.#activeHandleClosed = true;
    this.#activeHandle = null;
    if (handle && this.#dbConnection?.statementManager) {
      try {
        await this.#dbConnection.statementManager.closeStatement(handle);
      } catch { /* ignore close errors */ }
    }
  }

  #ensureOpen() {
    if (this.#closed) {
      throw new Error('Statement is closed');
    }
  }
}
