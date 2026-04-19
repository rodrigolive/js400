/**
 * Public prepared statement API.
 *
 * Wraps the engine-level prepared statement handle with typed parameter
 * binding, execution, streaming (async iterable), batch support, and
 * JDBC-parity metadata accessors.
 *
 * Upstream: AS400JDBCPreparedStatement*.java
 * @module db/api/PreparedStatement
 */

import { ResultSet } from './ResultSet.js';
import { ResultSetMetaData } from './ResultSetMetaData.js';
import { ParameterMetaData } from './ParameterMetaData.js';
import { SqlWarning, warningFromSqlca } from './SqlWarning.js';
import { SqlError } from '../../core/errors.js';
import { SqlArray } from './SqlArray.js';
import { RowId } from './RowId.js';
import { Blob } from '../lob/Blob.js';
import { Clob } from '../lob/Clob.js';
import { SQLXML } from '../lob/SQLXML.js';

/** Sentinel used by `setNull` to mark a bound parameter as SQL NULL. */
export const SQL_NULL = Symbol.for('js400.sql.null');

/**
 * Default *row count* for cursor FETCH requests when the caller did not
 * call `setFetchSize()`. Distinct from the engine's OPEN blocking factor
 * (which is in *bytes*): the FETCH protocol's BLOCKING_FACTOR is a row
 * count, so feeding the byte-level open default in here would silently
 * blow up the per-fetch row count.
 */
const DEFAULT_FETCH_ROWS = 2048;

export class PreparedStatement {
  #dbConnection;
  #stmtHandle;
  #sql;
  #closed;
  #params;             // 1-based array of bound values
  #paramMdCache;
  #resultMdCache;
  #warnings;
  #fetchSize;
  #maxRows;
  #queryTimeout;
  #cancelled;          // set by cancel() or by the queryTimeout watchdog
  #batchRows;
  #lastGeneratedKeys;  // { rows, columnDescriptors } | null
  #onClose;            // async cleanup hook: releases handle to cache or closes it

  /**
   * @param {import('../engine/DbConnection.js').DbConnection} dbConnection
   * @param {object} stmtHandle - engine-level prepared statement handle
   * @param {string} sql - the SQL text
   * @param {object} [opts]
   * @param {Function} [opts.onClose] - invoked on close() with the
   *   handle; owns the physical-close-or-return-to-cache decision.
   *   When omitted, close() physically closes the handle directly
   *   (preserves legacy callers constructing PreparedStatement by hand).
   */
  constructor(dbConnection, stmtHandle, sql, opts = {}) {
    this.#dbConnection = dbConnection;
    this.#stmtHandle = stmtHandle;
    this.#sql = sql;
    this.#closed = false;
    this.#params = [];
    this.#paramMdCache = null;
    this.#resultMdCache = null;
    this.#warnings = null;
    this.#fetchSize = 0;
    this.#maxRows = 0;
    this.#queryTimeout = 0;
    this.#cancelled = false;
    this.#batchRows = null;
    this.#lastGeneratedKeys = null;
    this.#onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  }

  get closed() { return this.#closed; }
  get sql() { return this.#sql; }
  get parameterCount() { return this.#stmtHandle.paramCount; }
  get columnCount() { return this.#stmtHandle.columnCount; }

  /**
   * Legacy plain-object parameter metadata projection.
   * @returns {object[]}
   */
  get parameterMetadata() {
    return this.getParameterMetaData().toPlainArray();
  }

  /**
   * JDBC-parity ParameterMetaData accessor.
   * @returns {ParameterMetaData}
   */
  getParameterMetaData() {
    if (!this.#paramMdCache) {
      this.#paramMdCache = new ParameterMetaData(this.#stmtHandle.paramDescriptors);
    }
    return this.#paramMdCache;
  }

  /**
   * JDBC-parity ResultSetMetaData accessor (columns the SELECT will return).
   * Returns null when the statement does not produce a result set.
   * @returns {ResultSetMetaData|null}
   */
  getMetaData() {
    const cols = this.#stmtHandle.columnDescriptors;
    if (!cols || cols.length === 0) return null;
    if (!this.#resultMdCache) this.#resultMdCache = new ResultSetMetaData(cols);
    return this.#resultMdCache;
  }

  // --- Typed setters (1-based index, per JDBC) ---

  /** Clear all currently bound parameters. */
  clearParameters() { this.#params = []; }

  /** @param {number} i @param {any} v */
  setObject(i, v) { this.#setAt(i, v); return this; }

  setNull(i, _sqlType) { this.#setAt(i, SQL_NULL); return this; }
  setBoolean(i, v) { this.#setAt(i, v === null || v === undefined ? SQL_NULL : (v ? 1 : 0)); return this; }
  setByte(i, v)    { this.#setAt(i, v); return this; }
  setShort(i, v)   { this.#setAt(i, v); return this; }
  setInt(i, v)     { this.#setAt(i, v); return this; }
  setLong(i, v)    { this.#setAt(i, typeof v === 'bigint' ? v : BigInt(v ?? 0)); return this; }
  setFloat(i, v)   { this.#setAt(i, v); return this; }
  setDouble(i, v)  { this.#setAt(i, v); return this; }
  setBigDecimal(i, v) { this.#setAt(i, v == null ? SQL_NULL : String(v)); return this; }
  setString(i, v)  { this.#setAt(i, v); return this; }
  setBytes(i, v)   { this.#setAt(i, v); return this; }

  setDate(i, v) {
    this.#setAt(i, v instanceof Date ? v : (v == null ? SQL_NULL : new Date(String(v))));
    return this;
  }
  setTime(i, v)      { return this.setDate(i, v); }
  setTimestamp(i, v) { return this.setDate(i, v); }

  setBlob(i, v)   {
    if (v == null) { this.#setAt(i, SQL_NULL); return this; }
    if (v instanceof Blob) { this.#setAt(i, v); return this; }
    this.#setAt(i, v);
    return this;
  }
  setClob(i, v)   {
    if (v == null) { this.#setAt(i, SQL_NULL); return this; }
    if (v instanceof Clob) { this.#setAt(i, v); return this; }
    this.#setAt(i, String(v));
    return this;
  }
  setNClob(i, v)  { return this.setClob(i, v); }
  setSQLXML(i, v) {
    if (v == null) { this.#setAt(i, SQL_NULL); return this; }
    if (v instanceof SQLXML) { this.#setAt(i, v); return this; }
    this.#setAt(i, String(v));
    return this;
  }
  setArray(i, v)  {
    if (v == null) { this.#setAt(i, SQL_NULL); return this; }
    this.#setAt(i, v);
    return this;
  }
  setRowId(i, v)  {
    if (v == null) { this.#setAt(i, SQL_NULL); return this; }
    if (v instanceof RowId) { this.#setAt(i, v.bytes); return this; }
    this.#setAt(i, v);
    return this;
  }
  setURL(i, v)    { this.#setAt(i, v == null ? SQL_NULL : String(v)); return this; }

  setBinaryStream(i, v)    { this.#setAt(i, v); return this; }
  setCharacterStream(i, v) { this.#setAt(i, v == null ? SQL_NULL : String(v)); return this; }
  setAsciiStream(i, v)     { return this.setCharacterStream(i, v); }
  setNString(i, v)         { return this.setString(i, v); }
  setNCharacterStream(i, v){ return this.setCharacterStream(i, v); }

  // --- Query resource control ---

  /**
   * JDBC `Statement.getCursorName()` analogue. Returns the cursor
   * name the underlying RPB was prepared with — either the
   * caller-supplied name (passed to `Connection.prepare(sql, {
   * cursorName })`) or the engine's auto-generated `CRSR<rpbId>`.
   * Useful for building positioned `UPDATE / DELETE WHERE CURRENT
   * OF <name>` statements against the same connection.
   */
  getCursorName() { return this.#stmtHandle?.cursorName ?? null; }

  setFetchSize(n)    { this.#fetchSize = Math.max(0, n | 0); return this; }
  getFetchSize()     { return this.#fetchSize; }
  setMaxRows(n)      { this.#maxRows = Math.max(0, n | 0); return this; }
  getMaxRows()       { return this.#maxRows; }
  // queryTimeout is honored by `#runWithCancellation()` on every
  // execute path. n=0 takes the fast path (no timer, no allocation).
  // n>0 arms a per-execute `setTimeout(n*1000)` that flips
  // `#cancelled`; after the in-flight RTT returns, the wrapper
  // throws `SqlError(HY008)` "Query timeout exceeded". No mid-RTT
  // preemption (would need a side connection à la JTOpen
  // `AS400JDBCConnectionImpl.cancel`).
  setQueryTimeout(n) { this.#queryTimeout = Math.max(0, n | 0); return this; }
  getQueryTimeout()  { return this.#queryTimeout; }

  // --- Warnings ---

  getWarnings() { return this.#warnings; }
  clearWarnings() { this.#warnings = null; }
  addWarning(msg, opts = {}) {
    const w = msg instanceof SqlWarning ? msg : new SqlWarning(msg, opts);
    if (!this.#warnings) this.#warnings = w;
    else this.#warnings.setNextWarning(w);
  }

  /**
   * Fast-path SQLCA → warning adapter. Folds any warning bits on the
   * reply's SQLCA into this statement's warning chain without
   * allocating or branching on the success path: the entire body
   * short-circuits when `warningFromSqlca()` returns null.
   */
  #propagateSqlcaWarning(sqlca) {
    const w = warningFromSqlca(sqlca);
    if (w) this.addWarning(w);
  }

  /**
   * Cancel-and-timeout wrapper for the engine call. Three states:
   *
   *   - `queryTimeout = 0` and not cancelled: the fast path. One
   *     boolean check, then the wrapped invocation runs untouched.
   *     No timer, no allocation.
   *   - `cancelled` is set BEFORE invocation: throw HY008 immediately
   *     and clear the flag.
   *   - `queryTimeout > 0`: arm a `setTimeout` that flips `#cancelled`
   *     after `queryTimeout` seconds. After the engine call returns
   *     (or throws), if the flag is set, throw HY008. The watchdog
   *     does NOT preempt an in-flight RTT — single-connection
   *     architecture has no side channel to inject `FUNCTIONID_CANCEL`
   *     mid-flight; that would need a separate connection (JTOpen
   *     pattern at `AS400JDBCConnectionImpl.cancel`). The next
   *     operation after a slow RTT sees the cancel.
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
      // Fast path: no watchdog, no extra allocation.
      return invoke();
    }
    let timer = null;
    let invokeError = null;
    let result;
    try {
      timer = setTimeout(
        () => { this.#cancelled = true; },
        this.#queryTimeout * 1000,
      );
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

  /**
   * Mark the statement as cancelled. The next operation throws
   * `SqlError(HY008)`. Currently client-side only — a real wire-level
   * cancel requires a side connection (JTOpen
   * `AS400JDBCConnectionImpl.cancel`) which this driver does not yet
   * open. Calling `cancel()` while no execute is in flight still
   * affects the next execute.
   */
  cancel() { this.#cancelled = true; }
  /** @returns {boolean} */
  isCancelled() { return this.#cancelled; }

  // --- Execution ---

  /**
   * Execute the prepared statement with optional parameters.
   * Returns rows for SELECT or { affectedRows } for DML.
   *
   * If `params` is omitted, uses previously bound values via set* methods.
   *
   * @param {any[]} [params]
   * @param {object} [opts={}]
   * @param {boolean} [opts.returnGeneratedKeys=false]
   * @returns {Promise<object[]|{ affectedRows: number, generatedKeys?: object[] }>}
   */
  async execute(params, opts = {}) {
    this.#ensureOpen();
    // Per JDBC (AS400JDBCStatement.commonExecuteBefore): clear both
    // the generated-keys cache AND the warning chain at the top so
    // subsequent `getWarnings()` / `getGeneratedKeys()` reflect only
    // this execute, not a prior one.
    this.#lastGeneratedKeys = null;
    this.#warnings = null;
    const effective = await this.#resolveWrappers(this.#effectiveParams(params));

    // Generated-keys path: wrap the INSERT in SELECT * FROM FINAL TABLE (...)
    // and execute that ad-hoc statement. Per DB2 for i, this returns the
    // newly-inserted rows' columns (including auto-generated IDENTITY / GENERATED
    // ALWAYS values) as a result set.
    if (opts?.returnGeneratedKeys && canWrapForGeneratedKeys(this.#sql)) {
      const wrappedSql = `SELECT * FROM FINAL TABLE (${this.#sql})`;
      const wrappedHandle = await this.#dbConnection.prepareStatement(wrappedSql);
      try {
        const wrappedResult = await this.#runWithCancellation(
          () => this.#dbConnection.statementManager.execute(wrappedHandle, effective),
        );
        this.#propagateSqlcaWarning(wrappedResult.sqlca);
        const rows = wrappedResult.hasResultSet ? wrappedResult.rows : [];
        this.#lastGeneratedKeys = {
          rows: [...rows],
          columnDescriptors: wrappedResult.columnDescriptors || [],
        };
        return {
          affectedRows: rows.length,
          generatedKeys: rows,
        };
      } finally {
        try { await this.#dbConnection.statementManager.closeStatement(wrappedHandle); } catch { /* ignore */ }
      }
    }

    const result = await this.#runWithCancellation(
      () => this.#dbConnection.statementManager.execute(
        this.#stmtHandle, effective, opts,
      ),
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
      });
      try {
        const all = await rs.toArray();
        return this.#maxRows > 0 ? all.slice(0, this.#maxRows) : all;
      } finally {
        // Close the server-side cursor before returning. Without this
        // step, a prepared-SELECT handle that later gets returned to
        // the statement cache carries an open cursor on the host, and
        // the next reuse fails with SQLCODE -502 ("cursor already
        // open"). The close is idempotent; the engine handle lives on.
        try { await rs.close(); } catch { /* ignore close errors */ }
      }
    }

    return {
      affectedRows: result.affectedRows,
    };
  }

  /**
   * Retrieve the generated keys ResultSet from the last execute() that
   * was called with `{ returnGeneratedKeys: true }`. Returns an empty
   * ResultSet when no generated-keys execute has happened yet.
   *
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
   * Execute and return a SELECT's rows plus metadata.
   * @param {any[]} [params]
   */
  async executeQuery(params) {
    this.#ensureOpen();
    return this.executeForStream(params);
  }

  /**
   * Execute DML and return affected count.
   * @param {any[]} [params]
   * @returns {Promise<number>}
   */
  async executeUpdate(params) {
    this.#ensureOpen();
    const result = await this.execute(params);
    if (Array.isArray(result)) return result.length;
    return result.affectedRows ?? 0;
  }

  /**
   * Execute and return a ResultSet for cursor-based access.
   * @param {any[]} [params]
   * @returns {Promise<ResultSet>}
   */
  async executeForStream(params) {
    this.#ensureOpen();
    // Stream path is a second execute on the same prepared handle.
    // Clear per-execute state (generated keys + warning chain) so
    // `getWarnings()` / `getGeneratedKeys()` reflect only this call.
    this.#lastGeneratedKeys = null;
    this.#warnings = null;
    const effective = await this.#resolveWrappers(this.#effectiveParams(params));
    const result = await this.#runWithCancellation(
      () => this.#dbConnection.statementManager.execute(
        this.#stmtHandle, effective,
      ),
    );
    this.#propagateSqlcaWarning(result.sqlca);

    return new ResultSet({
      rows: result.rows,
      columnDescriptors: result.columnDescriptors,
      cursorManager: this.#dbConnection.cursorManager,
      rpbId: result.rpbId,
      endOfData: result.endOfData,
      fetchSize: this.#fetchSize || result.defaultFetchRows || DEFAULT_FETCH_ROWS,
    });
  }

  /**
   * Callable-only execute path that surfaces the protocol-level
   * OUT/INOUT parameter row returned by a CALL reply.
   *
   * Returns the raw engine-layer result. The engine detects CALL
   * statements internally and, when the host server returns code point
   * 0x380E with parameter values, decodes those values using the
   * prepared statement's parameter descriptors. The caller (a
   * `CallableStatement`) is responsible for mapping the decoded values
   * onto registered OUT/INOUT slots.
   *
   * This is an internal seam: no public shape on `PreparedStatement` —
   * we just forward the raw execute result. Use `execute()` for normal
   * DML/SELECT flow.
   *
   * @param {any[]} [params]
   * @returns {Promise<object>} raw StatementManager.execute result
   */
  async executeCall(params) {
    this.#ensureOpen();
    // Clear per-execute state so callable warnings reflect only
    // this call when CallableStatement pulls them out of this handle
    // after the CALL reply.
    this.#warnings = null;
    const effective = await this.#resolveWrappers(this.#effectiveParams(params));
    const result = await this.#runWithCancellation(
      () => this.#dbConnection.statementManager.execute(this.#stmtHandle, effective),
    );
    this.#propagateSqlcaWarning(result.sqlca);
    return result;
  }

  /**
   * Execute and return an async iterable that yields rows one at a time.
   * @param {any[]} [params]
   * @returns {AsyncIterable<object>}
   */
  stream(params) {
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
   * Execute a batch of parameter sets. Returns per-row updateCounts
   * matching JTOpen: SUCCESS_NO_INFO (-2) except for INSERT statements
   * where the total matches the batch size (then 1 per row).
   *
   * @param {any[][]} paramSets
   * @returns {Promise<{ updateCounts: number[], totalAffected: number }>}
   */
  async executeBatch(paramSets) {
    this.#ensureOpen();
    // Batch executes do not return generated keys, but JDBC contract
    // requires getGeneratedKeys() and getWarnings() after any execute
    // to reflect THIS execute only — never a stale capture from an
    // earlier call.
    this.#lastGeneratedKeys = null;
    this.#warnings = null;
    const batchSize = paramSets?.length ?? 0;
    if (batchSize === 0) {
      return { updateCounts: [], totalAffected: 0 };
    }

    // Fast path: the hot bulk-insert case passes only primitives. Avoid
    // allocating a parallel array and queuing N microtasks when no row
    // carries a LOB / XML / ARRAY / RowId wrapper. This preserves the
    // original executeBatch throughput for JTOpen-like bulk loads.
    const effectiveSets = batchHasWrappers(paramSets)
      ? await this.#resolveWrapperSets(paramSets)
      : paramSets;

    const result = await this.#runWithCancellation(
      () => this.#dbConnection.statementManager.executeBatch(
        this.#stmtHandle, effectiveSets,
      ),
    );
    this.#propagateSqlcaWarning(result.sqlca);

    const perRow = (result.isInsert && result.affectedRows === batchSize) ? 1 : -2;
    const updateCounts = new Array(batchSize).fill(perRow);

    return {
      updateCounts,
      totalAffected: result.affectedRows,
    };
  }

  /**
   * Add the current set* parameter values as a new row in an internal
   * batch buffer. Must call executeBatchAccumulated() to flush.
   */
  addBatch() {
    if (!this.#batchRows) this.#batchRows = [];
    const row = [];
    for (let i = 1; i <= this.parameterCount; i++) row.push(this.#params[i]);
    this.#batchRows.push(row);
    this.clearParameters();
  }

  clearBatch() {
    this.#batchRows = [];
  }

  /** Execute the accumulated batch rows added via addBatch(). */
  async executeBatchAccumulated() {
    const batch = this.#batchRows || [];
    this.#batchRows = [];
    return this.executeBatch(batch);
  }

  /**
   * Close the prepared statement. If the owning Connection installed
   * an `onClose` hook (lease-semantics cache), the hook decides whether
   * to return the handle to the cache or physically close it. Without
   * a hook, the handle is physically closed via StatementManager.
   *
   * Idempotent: repeated close() calls are no-ops.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const handle = this.#stmtHandle;
    const hook = this.#onClose;
    this.#onClose = null; // ensure exactly one cleanup pass

    if (hook) {
      try { await hook(handle); } catch { /* ignore close errors */ }
      return;
    }
    try {
      await this.#dbConnection.statementManager.closeStatement(handle);
    } catch { /* ignore close errors */ }
  }

  // --- Internal helpers ---

  #setAt(index, value) {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 1 || idx > this.parameterCount) {
      throw new RangeError(
        `Parameter index out of range: ${index} (expected 1..${this.parameterCount})`,
      );
    }
    this.#params[idx] = value;
  }

  /**
   * Normalize the effective parameter vector: prefer the caller-provided
   * `params` array if given, otherwise project the internal #params
   * (1-based) to a 0-based array mapping SQL_NULL → null.
   */
  #effectiveParams(params) {
    if (Array.isArray(params)) return params;
    const out = new Array(this.parameterCount);
    for (let i = 1; i <= this.parameterCount; i++) {
      const v = this.#params[i];
      out[i - 1] = v === SQL_NULL ? null : (v === undefined ? null : v);
    }
    return out;
  }

  #ensureOpen() {
    if (this.#closed) {
      throw new Error('PreparedStatement is closed');
    }
  }

  /**
   * Resolve LOB / XML / ARRAY / RowId wrapper objects to their underlying
   * primitive representation before encoding. A wrapper may be backed by
   * an async-only LOB handle, so resolution is async.
   */
  async #resolveWrappers(params) {
    if (!Array.isArray(params) || params.length === 0) return params;
    if (!rowHasWrappers(params)) return params;
    const out = new Array(params.length);
    for (let i = 0; i < params.length; i++) {
      out[i] = await unwrapBindValue(params[i]);
    }
    return out;
  }

  async #resolveWrapperSets(paramSets) {
    const out = new Array(paramSets.length);
    for (let i = 0; i < paramSets.length; i++) {
      out[i] = await this.#resolveWrappers(paramSets[i]);
    }
    return out;
  }
}

/**
 * Cheap primitive-vs-wrapper detection. Returns true if the row contains
 * any value that might need async unwrapping. `null`, primitives, plain
 * numbers/strings, Buffer, Uint8Array, and Date all return false.
 */
function isWrapperValue(v) {
  if (v == null) return false;
  if (typeof v !== 'object') return false;
  if (Buffer.isBuffer(v)) return false;
  if (v instanceof Uint8Array) return false;
  if (v instanceof Date) return false;
  return (
    v instanceof SQLXML ||
    v instanceof Blob ||
    v instanceof Clob ||
    v instanceof SqlArray ||
    v instanceof RowId
  );
}

function rowHasWrappers(row) {
  if (!Array.isArray(row)) return false;
  for (let i = 0; i < row.length; i++) {
    if (isWrapperValue(row[i])) return true;
  }
  return false;
}

function batchHasWrappers(rows) {
  if (!Array.isArray(rows)) return false;
  for (let i = 0; i < rows.length; i++) {
    if (rowHasWrappers(rows[i])) return true;
  }
  return false;
}

async function unwrapBindValue(v) {
  if (v == null) return v;
  if (v instanceof SQLXML) return v.getString();
  if (v instanceof Blob) return v.toBuffer();
  if (v instanceof Clob) return v.text();
  if (v instanceof SqlArray) return v.getArray();
  if (v instanceof RowId) return v.bytes;
  return v;
}

/**
 * Detect statements that can be wrapped in `SELECT * FROM FINAL TABLE (...)`
 * to retrieve generated keys. DB2 for i supports FINAL TABLE for INSERT,
 * UPDATE, DELETE, and MERGE but the JDBC spec returns auto-generated keys
 * only from INSERT.
 */
function canWrapForGeneratedKeys(sql) {
  const stripped = String(sql ?? '').trimStart()
    .replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s+)+/, '');
  return /^INSERT\b/i.test(stripped);
}
