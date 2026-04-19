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
import { SqlWarning, warningFromSqlca } from './SqlWarning.js';
import { SqlError } from '../../core/errors.js';

/**
 * Default *row count* for cursor FETCH requests when the caller did not
 * call `setFetchSize()`. The engine's OPEN blocking factor is in bytes;
 * the FETCH BLOCKING_FACTOR is a row count, so the two cannot share a
 * default — feeding the byte-level open default in here would silently
 * blow up the per-fetch row count on large scans.
 */
const DEFAULT_FETCH_ROWS = 2048;

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

    const stmtHandle = await this.#dbConnection.prepareStatement(
      sql, this.#prepareOpts(),
    );
    try {
      const result = await this.#runWithCancellation(
        () => this.#dbConnection.statementManager.execute(stmtHandle),
      );
      this.#propagateSqlcaWarning(result.sqlca);

      if (result.hasResultSet) {
        const rs = new ResultSet({
          rows: result.rows,
          columnDescriptors: result.columnDescriptors,
          cursorManager: this.#dbConnection.cursorManager,
          rpbId: result.rpbId,
          endOfData: result.endOfData,
          fetchSize: this.#fetchSize || result.defaultFetchRows || DEFAULT_FETCH_ROWS,
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
      // No cursor-name flow for the FINAL TABLE wrap — it opens a
      // synthetic cursor for the generated keys, not the user's
      // statement cursor. Default auto-generated name keeps the
      // engine fast path.
      const stmtHandle = await this.#dbConnection.prepareStatement(wrapped);
      try {
        const result = await this.#runWithCancellation(
          () => this.#dbConnection.statementManager.execute(stmtHandle),
        );
        this.#propagateSqlcaWarning(result.sqlca);
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

    const result = await this.#runWithCancellation(
      () => this.#dbConnection.executeImmediate(sql),
    );
    this.#propagateSqlcaWarning(result.sqlca);
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

    const stmtHandle = await this.#dbConnection.prepareStatement(
      sql, this.#prepareOpts(),
    );
    this.#activeHandle = stmtHandle;
    this.#activeHandleClosed = false;

    let result;
    try {
      result = await this.#runWithCancellation(
        () => this.#dbConnection.statementManager.execute(stmtHandle),
      );
    } catch (err) {
      await this.#closeActiveHandle();
      throw err;
    }
    this.#propagateSqlcaWarning(result.sqlca);

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
      fetchSize: this.#fetchSize || result.defaultFetchRows || DEFAULT_FETCH_ROWS,
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
    // JTOpen parity: clear the warning chain before running a batch
    // so per-element SQLCA warnings reflect only this batch.
    this.#warnings = null;
    const batch = this.#batch;
    this.#batch = [];
    const counts = new Array(batch.length);
    for (let i = 0; i < batch.length; i++) {
      try {
        const r = await this.#runWithCancellation(
          () => this.#dbConnection.executeImmediate(batch[i]),
        );
        // A successful element can still carry SQLCA warning bits
        // (e.g. +1 string truncation on UPDATE). Fold those into the
        // batch-level chain so callers see them after the loop.
        this.#propagateSqlcaWarning(r.sqlca);
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
  // queryTimeout is honored by `#runWithCancellation()`: positive
  // values arm a per-execute `setTimeout(n*1000)` that flips
  // `#cancelled` AND fires `DbConnection.cancel()` on the side
  // channel (JTOpen `AS400JDBCConnectionImpl.cancel` pattern —
  // FUNCTIONID_CANCEL 0x1818 on a second DATABASE connection
  // targeting the server job identifier). The wrapper throws
  // `SqlError(HY008)` after the in-flight RTT returns; when the
  // side channel succeeds the RTT returns early with an interrupted
  // SQLCA, so the throw is near-simultaneous rather than pinned to
  // the natural RTT finish time. Fast path (n = 0) takes a single
  // boolean check and does not allocate.
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

  /**
   * Mark the statement as cancelled.
   *
   * Fires `DbConnection.cancel()` on the side-channel to attempt a
   * real wire-level `FUNCTIONID_CANCEL` against the target job. The
   * local `#cancelled` flag is ALSO set so the `#runWithCancellation`
   * post-check still throws `HY008` even if the side channel isn't
   * reachable (graceful degradation to the prior client-side-only
   * behavior). Calling `cancel()` while no execute is in flight
   * still arms the flag, so the NEXT execute will throw.
   *
   * Mirrors JTOpen `AS400JDBCStatement.cancel` which calls
   * `connection_.cancel(id_)` on a separate connection.
   */
  cancel() {
    this.#cancelled = true;
    // Fire-and-forget the wire cancel. We intentionally don't await
    // — the primary execute is blocked on its own sendAndReceive,
    // and the side channel has its own socket. Any failure bumps
    // `cancelMetrics.cancelFallbacks`; the post-RTT HY008 path
    // still fires regardless.
    const db = this.#dbConnection;
    if (db && typeof db.cancel === 'function') {
      db.cancel().catch(() => { /* fallback covered by flag */ });
    }
  }
  /** @returns {boolean} */
  isCancelled() { return this.#cancelled; }

  /**
   * Cancel-and-timeout wrapper. Fast path is a single boolean check
   * when `queryTimeout === 0` and no cancel is pending.
   *
   *   - `queryTimeout = 0` and not cancelled → fast path: 1 boolean
   *     check + the wrapped invocation. No timer, no side-channel
   *     chatter, no allocation.
   *   - cancelled before invocation → throw HY008 immediately, clear.
   *   - `queryTimeout > 0` → arm a `setTimeout` that, on expiry,
   *     fires `DbConnection.cancel()` to try a mid-RTT wire cancel
   *     AND sets `#cancelled`. If the side channel succeeds the
   *     server returns an interrupted SQLCA early; either way the
   *     post-check throws `HY008`.
   *
   * @template T
   * @param {() => Promise<T>} invoke
   * @returns {Promise<T>}
   */
  async #runWithCancellation(invoke) {
    if (this.#cancelled) {
      this.#cancelled = false;
      throw new SqlError('Statement was cancelled', {
        messageId: 'HY008', returnCode: -952,
      });
    }
    if (this.#queryTimeout <= 0) {
      return invoke();
    }
    let timer = null;
    let invokeError = null;
    let result;
    try {
      timer = setTimeout(() => {
        this.#cancelled = true;
        // Best-effort side-channel cancel. If it succeeds the
        // in-flight RTT returns earlier; if it fails the post-check
        // below still throws HY008.
        const db = this.#dbConnection;
        if (db && typeof db.cancel === 'function') {
          db.cancel().catch(() => { /* fallback covered by flag */ });
        }
      }, this.#queryTimeout * 1000);
      result = await invoke();
    } catch (e) {
      invokeError = e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.#cancelled) {
      this.#cancelled = false;
      throw new SqlError('Query timeout exceeded', {
        messageId: 'HY008', returnCode: -952,
      });
    }
    if (invokeError) throw invokeError;
    return result;
  }

  /** @returns {SqlWarning|null} */
  getWarnings() { return this.#warnings; }
  clearWarnings() { this.#warnings = null; }
  addWarning(msg, opts = {}) {
    const w = msg instanceof SqlWarning ? msg : new SqlWarning(msg, opts);
    if (!this.#warnings) this.#warnings = w;
    else this.#warnings.setNextWarning(w);
  }

  /** Fold SQLCA warning bits from a reply into the statement chain. */
  #propagateSqlcaWarning(sqlca) {
    const w = warningFromSqlca(sqlca);
    if (w) this.addWarning(w);
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

  /**
   * Build the per-prepare options bag passed to
   * `dbConnection.prepareStatement()`. Returns `undefined` (NOT an
   * empty object) when no cursor name is set, so the engine sees
   * the same call shape as before for the common case — no extra
   * allocation on the hot path. Only positioned-UPDATE/DELETE
   * callers (who set a cursor name) pay any cost.
   */
  #prepareOpts() {
    if (this.#cursorName && this.#cursorName.length > 0) {
      return { cursorName: this.#cursorName };
    }
    return undefined;
  }

  #resetStateForExecute() {
    this.#lastResultSet = null;
    this.#lastUpdateCount = -1;
    this.#lastGeneratedKeys = null;
    // JDBC/JTOpen parity (AS400JDBCStatement.commonExecuteBefore at
    // line ~1398): clear the warning chain at the start of every
    // execute so `getWarnings()` reflects only THIS call.
    this.#warnings = null;
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
