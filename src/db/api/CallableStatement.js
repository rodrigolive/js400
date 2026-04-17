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
  #resultSets;            // array<object[]>
  #executed;

  /**
   * @param {object} connection - a Connection instance with prepare()
   * @param {string} [procedureName] - fully qualified procedure name
   */
  constructor(connection, procedureName) {
    this.#connection = connection;
    this.#procedureName = procedureName || null;
    this.#slots = [];
    this.#nameToIndex = new Map();
    this.#outValues = [];
    this.#wasNull = false;
    this.#warnings = null;
    this.#resultSets = [];
    this.#executed = false;
  }

  get procedureName() { return this.#procedureName; }
  get parameterCount() { return this.#slots.length; }
  get resultSets() { return this.#resultSets; }

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
    const total = this.#slots.filter(Boolean).length;
    const sql = buildCallSql(this.#procedureName, total);
    const params = [];
    for (let i = 1; i <= total; i++) {
      const s = this.#slots[i];
      if (!s) throw new Error(`Parameter ${i} not set`);
      // For OUT params, send null; the host server will populate them
      params.push(s.mode === ParameterMode.out ? null : (s.value ?? null));
    }

    const stmt = await this.#connection.prepare(sql);
    let resultSetHandle = null;
    try {
      // PARTIAL OUT/INOUT PARITY — NOT FULL PROTOCOL DECODE.
      //
      // JTOpen's AS400JDBCCallableStatement decodes OUT / INOUT values
      // from the CALL reply's parameter-row block (DBData parameterRow_,
      // sourced from the 0x3810-family reply code points). js400 does
      // not yet have that engine-layer decoder. Until it does, this
      // path uses a conservative, DETERMINISTIC fallback that only
      // populates OUT slots when the procedure also emits its outputs
      // as a result-set row (a common DB2 idiom).
      //
      // Fallback rules (applied in order, no object-order dependency):
      //   1. If exactly one result set is produced and it has exactly
      //      one row, attempt to project column values onto OUT/INOUT
      //      slots:
      //        a. Slots that have a registered parameter name
      //           (setParameterName / named getter) match columns with
      //           the same name (case-insensitive).
      //        b. Remaining unmatched OUT/INOUT slots fall back to
      //           the declared column-descriptor order from the result
      //           set's metadata (NOT Object.values order).
      //   2. If the shape can't be matched deterministically, every
      //      OUT slot is left as null.
      //
      // setOutValue() remains the explicit override path for protocol-
      // level populations once the engine grows a 0x3810 decoder.
      resultSetHandle = await stmt.executeForStream(params);
      const rows = await resultSetHandle.toArray();
      const columnDescriptors = resultSetHandle.columns || [];
      const resultSets = rows.length > 0 ? [rows] : [];
      this.#resultSets = resultSets;

      this.#outValues = new Array(total + 1).fill(null);
      const outSlotIdxs = [];
      for (let i = 1; i <= total; i++) {
        const s = this.#slots[i];
        if (s && (s.mode === ParameterMode.out || s.mode === ParameterMode.inOut)) {
          outSlotIdxs.push(i);
        }
      }

      if (rows.length === 1 && outSlotIdxs.length > 0 && columnDescriptors.length > 0) {
        const row = rows[0];
        // Build an (upper-case column name) → value map in descriptor
        // order so lookup is deterministic regardless of JS object
        // key order.
        const columnOrder = columnDescriptors.map(d => d.name || d.label || '');
        const colByName = new Map();
        for (const name of columnOrder) {
          if (name && !colByName.has(name.toUpperCase())) {
            colByName.set(name.toUpperCase(), row[name]);
          }
        }
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

        // Pass 2: fill remaining unmatched OUT slots from column
        // descriptors in declared order, skipping already-used columns.
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
      this.#executed = true;

      // Build legacy `out` array (just the OUT + INOUT slots in order)
      const outArr = [];
      for (let i = 1; i <= total; i++) {
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
