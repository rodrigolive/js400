/**
 * Public callable statement API for stored procedure calls.
 *
 * Extends PreparedStatement-like behavior with JDBC-parity OUT / INOUT
 * parameter registration, typed getters, named parameter support, and
 * multi result set iteration.
 *
 * Upstream: AS400JDBCCallableStatement.java
 * @module db/api/CallableStatement
 */

import { ParameterMode } from './ParameterMetaData.js';
import { SqlWarning } from './SqlWarning.js';
import { SqlArray } from './SqlArray.js';
import { RowId } from './RowId.js';
import { Blob } from '../lob/Blob.js';
import { Clob } from '../lob/Clob.js';
import { SQLXML } from '../lob/SQLXML.js';
import { ResultSet } from './ResultSet.js';
import { CLOSE_CURRENT_RESULT, KEEP_CURRENT_RESULT, CLOSE_ALL_RESULTS } from './Statement.js';

/**
 * Map a concise type descriptor used by `call()` to a SQL type string.
 * Supports both JTOpen-style tags ('integer', 'char', 'decimal', etc.)
 * and java.sql.Types-style numbers (passed via registerOutParameter).
 */
function sqlTypeString(desc) {
  const t = typeof desc === 'string' ? desc : desc?.type;
  switch (String(t ?? '').toLowerCase()) {
    case 'integer':   return 'INTEGER';
    case 'smallint':  return 'SMALLINT';
    case 'bigint':    return 'BIGINT';
    case 'decimal':
    case 'numeric': {
      const p = desc?.precision ?? 15;
      const s = desc?.scale ?? 2;
      return `DECIMAL(${p}, ${s})`;
    }
    case 'float':
    case 'double':    return 'DOUBLE';
    case 'real':      return 'REAL';
    case 'char':      return `CHAR(${desc?.length ?? 32})`;
    case 'varchar':   return `VARCHAR(${desc?.length ?? 256})`;
    case 'date':      return 'DATE';
    case 'time':      return 'TIME';
    case 'timestamp': return 'TIMESTAMP';
    case 'boolean':   return 'BOOLEAN';
    case 'blob':      return `BLOB(${desc?.length ?? 4096})`;
    case 'clob':      return `CLOB(${desc?.length ?? 4096})`;
    default:          return 'VARCHAR(256)';
  }
}

/**
 * Build the CALL SQL text from an ordered parameter plan.
 * @param {string} name - fully qualified procedure name.
 * @param {number} total - number of parameter markers to emit.
 */
function buildCallSql(name, total) {
  if (total <= 0) return `CALL ${name}()`;
  return `CALL ${name}(${Array(total).fill('?').join(', ')})`;
}

/**
 * Parse JDBC call syntax accepted by `Connection.prepareCall()`.
 * Recognized forms:
 *
 *   - bare procedure name:           `MYLIB.PROC`
 *   - bare CALL:                     `CALL MYLIB.PROC(?, ?)`
 *   - JDBC escape, procedure:        `{ call MYLIB.PROC(?, ?) }`
 *   - JDBC escape, function return:  `{ ? = call MYLIB.FUNC(?, ?) }`
 *
 * Parameter markers (`?`) inside string / identifier literals are not
 * counted. The leading `?` before `=` is treated as an implicit OUT
 * parameter at slot 1; the rest of the markers become slots 2..N.
 *
 * @param {string} text
 * @returns {{ procedureName: string|null, paramCount: number, hasReturn: boolean }|null}
 */
export function parseCallText(text) {
  if (text == null) return null;
  let s = String(text).trim();
  if (!s) return null;
  if (s.startsWith('{') && s.endsWith('}')) {
    s = s.slice(1, -1).trim();
  }
  let hasReturn = false;
  const retMatch = /^\?\s*=\s*/.exec(s);
  if (retMatch) {
    hasReturn = true;
    s = s.slice(retMatch[0].length).trim();
  }
  const callMatch = /^call\b\s*/i.exec(s);
  if (callMatch) s = s.slice(callMatch[0].length).trim();
  let procedureName = s;
  let argText = '';
  const openIdx = s.indexOf('(');
  if (openIdx >= 0) {
    procedureName = s.slice(0, openIdx).trim();
    const closeIdx = s.lastIndexOf(')');
    if (closeIdx > openIdx) argText = s.slice(openIdx + 1, closeIdx);
  }
  if (!procedureName) procedureName = null;
  let paramCount = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < argText.length; i++) {
    const ch = argText.charCodeAt(i);
    if (ch === 0x27 /* ' */ && !inDouble) inSingle = !inSingle;
    else if (ch === 0x22 /* " */ && !inSingle) inDouble = !inDouble;
    else if (ch === 0x3F /* ? */ && !inSingle && !inDouble) paramCount++;
  }
  return { procedureName, paramCount, hasReturn };
}

/**
 * Parameter slot used internally to track IN/OUT/INOUT registrations.
 * @typedef {object} Slot
 * @property {string} [name]
 * @property {number} mode - ParameterMode.*
 * @property {any} value
 * @property {object} typeDesc
 * @property {number} [sqlType]
 */

export class CallableStatement {
  #connection;
  #procedureName;
  #slots;                 // 1-based array of Slot
  #nameToIndex;           // Map<UPPER name, 1-based index>
  #outValues;             // 1-based array of last-executed OUT values
  #wasNull;
  #warnings;
  #resultSets;            // array<object[]> — legacy plain-array projection
  #resultSetQueue;        // ResultSet[] — JDBC-style streaming queue
  #currentResultSet;      // ResultSet|null — head of the queue
  #executed;
  #hasReturn;             // true when constructed from `{ ? = call ... }`
  #declaredParamCount;    // total `?` markers seen at parse time (incl. return)

  /**
   * Accepts JDBC call syntax in addition to a bare procedure name:
   *   - `MYLIB.PROC`                          (legacy js400 form)
   *   - `CALL MYLIB.PROC(?, ?)`               (bare CALL)
   *   - `{ call MYLIB.PROC(?, ?) }`           (JDBC escape)
   *   - `{ ? = call MYLIB.FUNC(?, ?) }`       (function return value)
   *
   * When the input contains a function-return form, slot 1 is reserved
   * as an implicit OUT parameter for the return value.
   *
   * @param {object} connection - a Connection instance with prepare()
   * @param {string} [callTextOrName] - JDBC call text or bare proc name
   */
  constructor(connection, callTextOrName) {
    this.#connection = connection;
    this.#slots = [];
    this.#nameToIndex = new Map();
    this.#outValues = [];
    this.#wasNull = false;
    this.#warnings = null;
    this.#resultSets = [];
    this.#resultSetQueue = [];
    this.#currentResultSet = null;
    this.#executed = false;
    this.#hasReturn = false;
    this.#declaredParamCount = 0;

    const parsed = parseCallText(callTextOrName);
    this.#procedureName = parsed?.procedureName ?? null;
    this.#hasReturn = Boolean(parsed?.hasReturn);
    this.#declaredParamCount = parsed?.paramCount ?? 0;
    if (this.#hasReturn) {
      // Reserve slot 1 as the function return value (OUT, type unknown
      // until registerOutParameter() is called by the caller).
      this.#slots[1] = {
        mode: ParameterMode.out,
        value: null,
        typeDesc: null,
        name: 'RETURN_VALUE',
      };
      this.#nameToIndex.set('RETURN_VALUE', 1);
    }
  }

  get procedureName() { return this.#procedureName; }
  get parameterCount() { return this.#slots.length; }
  /**
   * Legacy plain-array projection of all decoded result sets from
   * the most recent `execute()`. New code should iterate via
   * `getResultSet()` + `getMoreResults()` to mirror JDBC.
   */
  get resultSets() { return this.#resultSets; }
  /** True when constructed from `{ ? = call FUNC(...) }` syntax. */
  get hasReturn() { return this.#hasReturn; }

  /**
   * JDBC `Statement.getResultSet()`: returns the current result set,
   * or `null` when the most recent execute returned only OUT
   * parameters.
   * @returns {ResultSet|null}
   */
  getResultSet() { return this.#currentResultSet; }

  /**
   * JDBC `Statement.getMoreResults(current)`: advances to the next
   * result set returned by the procedure. Returns `true` when the
   * advance landed on a fresh `ResultSet`, `false` when no more
   * result sets remain.
   *
   * Disposition codes (re-exported from `Statement.js`):
   *   - `CLOSE_CURRENT_RESULT` (default) — close the current set
   *     before moving on.
   *   - `KEEP_CURRENT_RESULT` — leave the current set open; the
   *     caller is responsible for closing it.
   *   - `CLOSE_ALL_RESULTS` — close the current set AND every queued
   *     pending set, then return `false`.
   *
   * @param {number} [current=CLOSE_CURRENT_RESULT]
   * @returns {Promise<boolean>}
   */
  async getMoreResults(current = CLOSE_CURRENT_RESULT) {
    if (current === CLOSE_ALL_RESULTS) {
      if (this.#currentResultSet) {
        try { await this.#currentResultSet.close(); } catch { /* ignore */ }
      }
      for (const rs of this.#resultSetQueue) {
        try { await rs.close(); } catch { /* ignore */ }
      }
      this.#resultSetQueue = [];
      this.#currentResultSet = null;
      return false;
    }
    if (current === CLOSE_CURRENT_RESULT && this.#currentResultSet) {
      try { await this.#currentResultSet.close(); } catch { /* ignore */ }
    }
    // KEEP_CURRENT_RESULT leaves the prior ResultSet open; the
    // caller now owns it.
    if (this.#resultSetQueue.length === 0) {
      this.#currentResultSet = null;
      return false;
    }
    this.#currentResultSet = this.#resultSetQueue.shift();
    return true;
  }

  /**
   * Register an OUT parameter at the given 1-based index.
   * @param {number|string} indexOrName
   * @param {number|string|object} sqlType - java.sql.Types code, string tag,
   *   or full { type, length, precision, scale } descriptor
   * @param {object} [opts] - extra type info (length, precision, scale)
   */
  registerOutParameter(indexOrName, sqlType, opts = {}) {
    const idx = this.#indexOf(indexOrName, /*create*/true);
    const typeDesc = typeof sqlType === 'object' && sqlType !== null
      ? sqlType
      : { type: sqlType, ...opts };
    const slot = this.#slots[idx] || {};
    slot.mode = slot.mode === ParameterMode.in ? ParameterMode.inOut : ParameterMode.out;
    slot.typeDesc = typeDesc;
    if (slot.mode === ParameterMode.out) slot.value = null;
    this.#slots[idx] = slot;
  }

  /**
   * Set an IN (or bind the IN side of an INOUT) parameter at the given
   * 1-based index or name.
   */
  setObject(indexOrName, value, sqlType) {
    const idx = this.#indexOf(indexOrName, /*create*/true);
    const slot = this.#slots[idx] || { mode: ParameterMode.in, typeDesc: null };
    if (slot.mode === ParameterMode.out) slot.mode = ParameterMode.inOut;
    else if (slot.mode == null) slot.mode = ParameterMode.in;
    slot.value = value;
    if (sqlType !== undefined) {
      slot.typeDesc = typeof sqlType === 'object' ? sqlType : { type: sqlType };
    }
    this.#slots[idx] = slot;
  }

  setNull(indexOrName, sqlType) { this.setObject(indexOrName, null, sqlType); }
  setBoolean(i, v)   { this.setObject(i, v == null ? null : Boolean(v)); }
  setByte(i, v)      { this.setObject(i, v); }
  setShort(i, v)     { this.setObject(i, v); }
  setInt(i, v)       { this.setObject(i, v); }
  setLong(i, v)      { this.setObject(i, typeof v === 'bigint' ? v : BigInt(v ?? 0)); }
  setFloat(i, v)     { this.setObject(i, v); }
  setDouble(i, v)    { this.setObject(i, v); }
  setBigDecimal(i, v){ this.setObject(i, v == null ? null : String(v)); }
  setString(i, v)    { this.setObject(i, v); }
  setBytes(i, v)     { this.setObject(i, v); }
  setDate(i, v)      { this.setObject(i, v instanceof Date ? v : (v == null ? null : new Date(String(v)))); }
  setTime(i, v)      { this.setDate(i, v); }
  setTimestamp(i, v) { this.setDate(i, v); }
  setBlob(i, v)      { this.setObject(i, v); }
  setClob(i, v)      { this.setObject(i, v); }
  setNClob(i, v)     { this.setObject(i, v); }
  setSQLXML(i, v)    { this.setObject(i, v); }
  setArray(i, v)     { this.setObject(i, v); }
  setRowId(i, v)     { this.setObject(i, v instanceof RowId ? v.bytes : v); }
  setURL(i, v)       { this.setObject(i, v == null ? null : String(v)); }

  /**
   * Associate a parameter name with a 1-based index. Needed for named
   * getters/setters: `cstmt.setInt('UserId', 42)` or `cstmt.getString('Result')`.
   */
  setParameterName(index, name) {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 1) {
      throw new RangeError(`Invalid parameter index: ${index}`);
    }
    const slot = this.#slots[idx] || { mode: ParameterMode.in, typeDesc: null };
    slot.name = String(name);
    this.#slots[idx] = slot;
    this.#nameToIndex.set(String(name).toUpperCase(), idx);
  }

  // --- Typed OUT getters ---

  getObject(indexOrName) {
    const idx = this.#indexOf(indexOrName, /*create*/false);
    const v = this.#outValues[idx];
    this.#wasNull = v == null;
    return v ?? null;
  }

  getString(k)     { const v = this.getObject(k); return v == null ? null : String(v); }
  getBoolean(k)    {
    const v = this.getObject(k);
    if (v == null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return /^(true|t|y|yes|1)$/i.test(String(v).trim());
  }
  getByte(k)       { return this.#num(k) & 0xFF; }
  getShort(k)      { return (this.#num(k) << 16) >> 16; }
  getInt(k)        { return this.#num(k) | 0; }
  getLong(k)       {
    const v = this.getObject(k);
    if (v == null) return 0n;
    if (typeof v === 'bigint') return v;
    return BigInt(Math.trunc(Number(v) || 0));
  }
  getFloat(k)      { return this.#num(k); }
  getDouble(k)     { return this.#num(k); }
  getBigDecimal(k) { const v = this.getObject(k); return v == null ? null : String(v); }
  getBytes(k)      {
    const v = this.getObject(k);
    if (v == null) return null;
    if (Buffer.isBuffer(v)) return v;
    return Buffer.from(String(v), 'utf8');
  }
  getDate(k)       {
    const v = this.getObject(k);
    if (v == null) return null;
    if (v instanceof Date) return v;
    return new Date(String(v));
  }
  getTime(k)       { return this.getDate(k); }
  getTimestamp(k)  { return this.getDate(k); }
  getBlob(k)       {
    const v = this.getObject(k);
    if (v == null) return null;
    if (v instanceof Blob) return v;
    const buf = Buffer.isBuffer(v)
      ? v
      : v instanceof Uint8Array
        ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
        : Buffer.from(String(v), 'utf8');
    return new Blob({ data: buf, length: buf.length });
  }
  getClob(k)       {
    const v = this.getObject(k);
    if (v == null) return null;
    if (v instanceof Clob) return v;
    const s = typeof v === 'string' ? v : String(v);
    return new Clob({ data: s, length: s.length });
  }
  getSQLXML(k)     {
    const v = this.getObject(k);
    if (v == null) return null;
    if (v instanceof SQLXML) return v;
    const s = typeof v === 'string' ? v : String(v);
    return new SQLXML({ data: s, length: s.length });
  }
  getArray(k)      {
    const v = this.getObject(k);
    if (v == null) return null;
    if (v instanceof SqlArray) return v;
    const elements = Array.isArray(v) ? v : [v];
    return new SqlArray({ baseTypeName: 'UNKNOWN', elements });
  }
  getRowId(k)      {
    const v = this.getObject(k);
    if (v == null) return null;
    if (v instanceof RowId) return v;
    const bytes = Buffer.isBuffer(v)
      ? v
      : v instanceof Uint8Array
        ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
        : Buffer.from(String(v), 'utf8');
    return new RowId(bytes);
  }

  /** @returns {boolean} whether the last getter observed SQL NULL. */
  wasNull() { return this.#wasNull; }

  /** @returns {SqlWarning|null} */
  getWarnings() { return this.#warnings; }
  clearWarnings() { this.#warnings = null; }

  // --- Execution ---

  /**
   * Execute the registered CALL.
   *
   * Two calling styles are supported:
   *
   *   (1) Ergonomic single-call:
   *       `await cstmt.call('LIB.PROC', { in: [...], out: [...], inout: [...] })`
   *
   *   (2) JDBC-like, after setX / registerOutParameter:
   *       `await cstmt.execute()`
   *
   * @param {string} [procedureName]
   * @param {object} [opts]
   * @returns {Promise<{ out: any[], resultSets: object[][] }>}
   */
  async call(procedureName, opts = {}) {
    if (procedureName) this.#procedureName = procedureName;
    this.#slots = [];
    this.#nameToIndex.clear();

    const inParams = opts.in || [];
    const outParams = opts.out || [];
    const inoutParams = opts.inout || [];

    // Allocate slots in order: IN, OUT, INOUT (matches original semantics)
    let n = 0;
    for (const v of inParams) {
      n++;
      this.#slots[n] = { mode: ParameterMode.in, value: v, typeDesc: null };
    }
    for (const d of outParams) {
      n++;
      this.#slots[n] = { mode: ParameterMode.out, value: null, typeDesc: d };
    }
    for (const d of inoutParams) {
      n++;
      this.#slots[n] = { mode: ParameterMode.inOut, value: d?.value, typeDesc: d };
    }

    return this.execute();
  }

  /**
   * Execute the already-configured CALL (via setX / registerOutParameter).
   * @returns {Promise<{ out: any[], resultSets: object[][] }>}
   */
  async execute() {
    if (!this.#procedureName) {
      throw new Error('CallableStatement: procedureName not set');
    }

    // JDBC parity: clear the callable's warning chain AND any
    // queued result sets at the start of every execute so
    // `getWarnings()` / `getResultSet()` / `getMoreResults()`
    // reflect only this call. The inner prepared statement's
    // warnings will be folded in after the reply.
    this.#warnings = null;
    if (this.#currentResultSet) {
      try { await this.#currentResultSet.close(); } catch { /* ignore */ }
    }
    for (const rs of this.#resultSetQueue) {
      try { await rs.close(); } catch { /* ignore */ }
    }
    this.#resultSetQueue = [];
    this.#currentResultSet = null;
    this.#resultSets = [];

    // Authoritative slot count:
    //   1. If the CallableStatement was constructed from parsed JDBC
    //      call text, the parse tree is the source of truth: the
    //      declared marker count plus (optionally) the return slot
    //      must all be set before execute().
    //   2. Otherwise we are in the legacy `call()` helper flow where
    //      the caller materialized slots dynamically; honor whatever
    //      they populated.
    const totalSlots = this.#declaredParamCount > 0
      ? (this.#hasReturn ? 1 + this.#declaredParamCount : this.#declaredParamCount)
      : this.#slots.filter(Boolean).length;

    // Enforce declared-count parity when the call text declared it.
    // This closes the old "CALL PROC(?,?) with only slot 1 touched
    // becomes CALL PROC(?)" trap.
    if (this.#declaredParamCount > 0) {
      for (let i = 1; i <= totalSlots; i++) {
        if (!this.#slots[i]) {
          throw new Error(
            `CallableStatement: parameter ${i} of ${totalSlots} `
            + `was not set (procedure ${this.#procedureName})`
          );
        }
      }
    }

    // Build the CALL SQL respecting the parsed shape:
    //   - `{ ? = call FUNC(?, ?) }` →  `? = CALL FUNC(?, ?)`
    //   - `CALL PROC(?, ?)`         →  `CALL PROC(?, ?)`
    //   - `MYLIB.PROC` legacy form  →  `CALL MYLIB.PROC(?, ?, ...)`
    // In the return-value form the leading `?` is the function's
    // return marker — it is bound as the first parameter value at
    // send time, and DB2 for i fills it on the reply (same decode
    // path as any OUT parameter).
    const argMarkerCount = this.#hasReturn ? totalSlots - 1 : totalSlots;
    const argMarkers = argMarkerCount > 0
      ? Array(argMarkerCount).fill('?').join(', ')
      : '';
    const sql = this.#hasReturn
      ? `? = CALL ${this.#procedureName}(${argMarkers})`
      : buildCallSql(this.#procedureName, argMarkerCount);

    const params = [];
    for (let i = 1; i <= totalSlots; i++) {
      const s = this.#slots[i];
      if (!s) throw new Error(`Parameter ${i} not set`);
      // For OUT params, send null; the host server will populate them
      params.push(s.mode === ParameterMode.out ? null : (s.value ?? null));
    }

    const stmt = await this.#connection.prepare(sql);
    let resultSetHandle = null;
    try {
      this.#outValues = new Array(totalSlots + 1).fill(null);
      const outSlotIdxs = [];
      for (let i = 1; i <= totalSlots; i++) {
        const s = this.#slots[i];
        if (s && (s.mode === ParameterMode.out || s.mode === ParameterMode.inOut)) {
          outSlotIdxs.push(i);
        }
      }

      // Primary path — protocol-level OUT / INOUT decode.
      //
      // JTOpen's AS400JDBCCallableStatement reads OUT values from the
      // CALL reply's parameter-row block (DBData parameterRow_, sourced
      // from the 0x380E RESULT_DATA code point; the request must set the
      // ORS RESULT_DATA bit). In js400 this work lives in
      // `StatementManager.execute()` for CALL statements and surfaces as
      // `{ parameterRow, parameterDescriptors }` on the execute result.
      // When that row is present we decode OUT slots from it directly —
      // no result-set materialization, no toArray() fan-out.
      //
      // Fallback path — DETERMINISTIC result-set heuristic.
      //
      // Some procedure idioms emit their outputs as a one-row result
      // set via `VALUES (...)` rather than through real OUT markers.
      // When the protocol path returns no parameter row, we fall back
      // to matching that one row onto OUT slots by registered parameter
      // name first, then declared column-descriptor order. If the shape
      // can't be matched, OUT slots stay null.
      const callResult = typeof stmt.executeCall === 'function'
        ? await stmt.executeCall(params)
        : null;

      let resultSets = [];

      if (callResult?.parameterRow) {
        const descs = callResult.parameterDescriptors || [];
        const row = callResult.parameterRow;
        for (const idx of outSlotIdxs) {
          const desc = descs[idx - 1];
          // Parameter descriptors parsed from code point 0x3808 often
          // carry empty name strings — decodeResultData keys those
          // columns as `col${desc.index}`. Prefer an explicit name
          // when the host gave us one, otherwise use the positional
          // fallback so the mapping is 1:1 with slot order.
          const key = desc?.name && desc.name.length > 0
            ? desc.name
            : `col${idx - 1}`;
          if (Object.prototype.hasOwnProperty.call(row, key)) {
            this.#outValues[idx] = row[key];
          }
        }
        // Procedures that return OUT params AND one or more result
        // sets (DECLARE CURSOR + OPEN pattern). The engine surfaces
        // each secondary 0x380E block as its own group; we wrap each
        // decoded group in a real `ResultSet` and queue them so
        // `getMoreResults()` can advance through them in order.
        // Groups whose descriptor was missing keep their raw buffer
        // surface as a `__raw` placeholder ResultSet (the consumer
        // can detect it via `getMetaData().getColumnCount() === 0`).
        const groups = Array.isArray(callResult.resultSetGroups)
          ? callResult.resultSetGroups : [];
        for (const g of groups) {
          if (g.rows) {
            resultSets.push(g.rows);
            this.#resultSetQueue.push(new ResultSet({
              rows: g.rows,
              columnDescriptors: g.descriptors || [],
              endOfData: true,
            }));
          } else if (g.__raw) {
            // Raw fallback: descriptor unknown, no decoded rows.
            // Surface as an empty ResultSet so the consumer can
            // count it but not iterate.
            resultSets.push({ __raw: g.__raw });
            this.#resultSetQueue.push(new ResultSet({
              rows: [],
              columnDescriptors: [],
              endOfData: true,
            }));
          }
        }
        // Pre-2026-04-18 compatibility: when no `resultSetGroups`
        // came through (older engine path), fall back to the
        // legacy single-group surface. `extraResultBuffers` is the
        // legacy raw fallback when no descriptor was sent.
        if (groups.length === 0
            && Array.isArray(callResult.resultSetRows)
            && callResult.resultSetRows.length > 0) {
          resultSets = [callResult.resultSetRows];
          this.#resultSetQueue.push(new ResultSet({
            rows: callResult.resultSetRows,
            columnDescriptors: callResult.resultSetDescriptors || [],
            endOfData: true,
          }));
        } else if (groups.length === 0 && callResult.extraResultBuffers?.length) {
          // No descriptor, no decoded groups, but raw 0x380E
          // blocks remain. Preserve the legacy `__raw + note`
          // surface so older callers / mocks still work.
          resultSets = [{
            __raw: callResult.extraResultBuffers,
            note: 'CALL returned a result set alongside OUT parameters '
              + 'but no descriptor arrived on the CALL reply. The raw '
              + 'data buffers are preserved for a higher layer that '
              + 'knows the shape out-of-band.',
          }];
        }
        if (this.#resultSetQueue.length > 0) {
          this.#currentResultSet = this.#resultSetQueue.shift();
        }
      } else {
        resultSetHandle = await stmt.executeForStream(params);
        const rows = await resultSetHandle.toArray();
        const columnDescriptors = resultSetHandle.columns || [];
        resultSets = rows.length > 0 ? [rows] : [];

        if (rows.length === 1 && outSlotIdxs.length > 0 && columnDescriptors.length > 0) {
          const row = rows[0];
          const columnOrder = columnDescriptors.map(d => d.name || d.label || '');
          const usedColumnIdx = new Set();

          // Pass 1: match by registered slot name.
          for (const idx of outSlotIdxs) {
            const slot = this.#slots[idx];
            const slotName = slot?.name ? String(slot.name).toUpperCase() : null;
            if (!slotName) continue;
            const colIdx = columnOrder.findIndex(n => n && n.toUpperCase() === slotName);
            if (colIdx >= 0 && !usedColumnIdx.has(colIdx)) {
              this.#outValues[idx] = row[columnOrder[colIdx]];
              usedColumnIdx.add(colIdx);
            }
          }

          // Pass 2: fill remaining OUT slots from column descriptors in
          // declared order, skipping already-used columns.
          const remainingSlots = outSlotIdxs.filter(idx => {
            const slot = this.#slots[idx];
            return !slot?.name || this.#outValues[idx] === null;
          });
          let nextCol = 0;
          for (const idx of remainingSlots) {
            if (this.#outValues[idx] !== null) continue;
            while (nextCol < columnOrder.length && usedColumnIdx.has(nextCol)) nextCol++;
            if (nextCol >= columnOrder.length) break;
            this.#outValues[idx] = row[columnOrder[nextCol]];
            usedColumnIdx.add(nextCol);
            nextCol++;
          }
        }
      }

      // Absorb any SQLCA-derived warnings the inner PreparedStatement
      // folded onto its own chain. The inner statement is about to
      // close and would drop them otherwise. Graft the entire inner
      // chain onto our tail in one step — each node already links to
      // its successor, so iterating would double-link them.
      const innerWarnings = typeof stmt.getWarnings === 'function'
        ? stmt.getWarnings()
        : null;
      if (innerWarnings) {
        if (!this.#warnings) this.#warnings = innerWarnings;
        else this.#warnings.setNextWarning(innerWarnings);
      }

      this.#resultSets = resultSets;
      this.#executed = true;

      // Build legacy `out` array (just the OUT + INOUT slots in order)
      const outArr = [];
      for (let i = 1; i <= totalSlots; i++) {
        const s = this.#slots[i];
        if (s.mode === ParameterMode.out || s.mode === ParameterMode.inOut) {
          outArr.push(this.#outValues[i]);
        }
      }

      return { out: outArr, resultSets };
    } finally {
      if (resultSetHandle) {
        try { await resultSetHandle.close(); } catch { /* ignore */ }
      }
      await stmt.close();
    }
  }

  /**
   * Push an OUT value directly — used by test harnesses and by a future
   * engine-layer path that decodes 0x3809 OUT payloads.
   *
   * @param {number|string} indexOrName
   * @param {any} value
   */
  setOutValue(indexOrName, value) {
    const idx = this.#indexOf(indexOrName, /*create*/false);
    if (this.#outValues.length <= idx) {
      this.#outValues.length = idx + 1;
    }
    this.#outValues[idx] = value;
  }

  // --- Internal helpers ---

  #indexOf(indexOrName, create) {
    if (typeof indexOrName === 'number') {
      if (!Number.isInteger(indexOrName) || indexOrName < 1) {
        throw new RangeError(`Invalid parameter index: ${indexOrName}`);
      }
      return indexOrName;
    }
    const key = String(indexOrName).toUpperCase();
    const existing = this.#nameToIndex.get(key);
    if (existing) return existing;
    if (!create) {
      throw new Error(`Parameter not found: ${indexOrName}`);
    }
    // Find the next free 1-based slot position
    let idx = 1;
    while (this.#slots[idx]) idx++;
    this.#nameToIndex.set(key, idx);
    return idx;
  }

  #num(k) {
    const v = this.getObject(k);
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
}

/** Export helper for downstream callers that want to synthesize CALL SQL. */
export { sqlTypeString, buildCallSql };
