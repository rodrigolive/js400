/**
 * Result set API with async iteration + JDBC-style positioning.
 *
 * Wraps cursor-based fetching from the engine layer into an ergonomic
 * JS interface with async iteration, object/array modes, typed getters,
 * wasNull(), findColumn(), and a ResultSetMetaData view.
 *
 * Upstream: AS400JDBCResultSet*.java
 * @module db/api/ResultSet
 */

import { ResultSetMetaData } from './ResultSetMetaData.js';
import { SqlWarning } from './SqlWarning.js';
import { SqlArray } from './SqlArray.js';
import { RowId } from './RowId.js';
import { Blob } from '../lob/Blob.js';
import { Clob } from '../lob/Clob.js';
import { SQLXML } from '../lob/SQLXML.js';

/** JDBC fetch-direction constants. */
export const FetchDirection = Object.freeze({
  forward: 1000,
  reverse: 1001,
  unknown: 1002,
});

/** JDBC ResultSet.TYPE_* constants. */
export const ResultSetType = Object.freeze({
  forwardOnly:       1003,
  scrollInsensitive: 1004,
  scrollSensitive:   1005,
});

/** JDBC ResultSet.CONCUR_* constants. */
export const ResultSetConcurrency = Object.freeze({
  readOnly:  1007,
  updatable: 1008,
});

/** JDBC ResultSet.HOLD_* constants. */
export const ResultSetHoldability = Object.freeze({
  holdCursorsOverCommit:  1,
  closeCursorsAtCommit:   2,
});

export class ResultSet {
  #rows;
  #columnDescriptors;
  #cursorManager;
  #rpbId;
  #endOfData;
  #fetchSize;
  #fetchDirection;
  #serverCCSID;
  #position;          // 1-based JDBC cursor: 0=before first, length+1=after last
  #closed;
  #wasNull;
  #metadataCache;
  #nameIndex;         // Map<UPPER-case name, 1-based column index>
  #warnings;
  #type;
  #concurrency;
  #holdability;
  #onClose;           // optional cleanup hook fired exactly once on close()

  /**
   * @param {object} opts
   * @param {object[]} opts.rows - initial rows already fetched
   * @param {object[]} opts.columnDescriptors
   * @param {object} [opts.cursorManager] - for fetching more rows
   * @param {number} [opts.rpbId] - RPB ID for cursor fetches
   * @param {boolean} [opts.endOfData=true]
   * @param {number} [opts.fetchSize=100]
   * @param {number} [opts.serverCCSID=37]
   * @param {number} [opts.type] - ResultSetType.*
   * @param {number} [opts.concurrency] - ResultSetConcurrency.*
   * @param {number} [opts.holdability] - ResultSetHoldability.*
   * @param {Function} [opts.onClose] - fired once when close() completes;
   *   used by owning Statement to close its prepared handle.
   */
  constructor(opts = {}) {
    this.#rows = opts.rows || [];
    this.#columnDescriptors = opts.columnDescriptors || [];
    this.#cursorManager = opts.cursorManager || null;
    this.#rpbId = opts.rpbId ?? 0;
    this.#endOfData = opts.endOfData ?? true;
    this.#fetchSize = opts.fetchSize ?? 100;
    this.#fetchDirection = FetchDirection.forward;
    this.#serverCCSID = opts.serverCCSID ?? 37;
    this.#position = 0;
    this.#closed = false;
    this.#wasNull = false;
    this.#metadataCache = null;
    this.#nameIndex = null;
    this.#warnings = null;
    this.#type = opts.type ?? ResultSetType.forwardOnly;
    this.#concurrency = opts.concurrency ?? ResultSetConcurrency.readOnly;
    this.#holdability = opts.holdability ?? ResultSetHoldability.closeCursorsAtCommit;
    this.#onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  }

  get length() { return this.#rows.length; }
  get columns() { return this.#columnDescriptors; }
  get closed() { return this.#closed; }

  /**
   * Plain-object metadata projection (legacy).
   * @returns {object[]}
   */
  get metadata() {
    return this.getMetaData().toPlainArray();
  }

  /**
   * JDBC-parity metadata accessor.
   * @returns {ResultSetMetaData}
   */
  getMetaData() {
    if (!this.#metadataCache) {
      this.#metadataCache = new ResultSetMetaData(this.#columnDescriptors);
    }
    return this.#metadataCache;
  }

  /** @returns {number} ResultSetType.* */
  getType() { return this.#type; }
  /** @returns {number} ResultSetConcurrency.* */
  getConcurrency() { return this.#concurrency; }
  /** @returns {number} ResultSetHoldability.* */
  getHoldability() { return this.#holdability; }

  /** @returns {number} current server-side fetch size */
  getFetchSize() { return this.#fetchSize; }

  /** Set server-side fetch size (affects subsequent network fetches). */
  setFetchSize(n) {
    if (!Number.isFinite(n) || n < 0) throw new RangeError('fetchSize must be >= 0');
    this.#fetchSize = n;
  }

  /** @returns {number} current fetch direction */
  getFetchDirection() { return this.#fetchDirection; }

  setFetchDirection(dir) {
    if (
      dir !== FetchDirection.forward &&
      dir !== FetchDirection.reverse &&
      dir !== FetchDirection.unknown
    ) {
      throw new RangeError(`Invalid fetch direction: ${dir}`);
    }
    this.#fetchDirection = dir;
  }

  // --- Positioning (JDBC-style, 1-based) ---

  /**
   * Advance to the next row. On a fresh result set the first call
   * moves to row 1.
   * @returns {Promise<boolean>} true if positioned on a valid row.
   */
  async next() {
    this.#ensureOpen();
    // Fetch more rows if needed
    if (this.#position >= this.#rows.length && !this.#endOfData && this.#cursorManager) {
      await this.#fetchBatch();
    }
    if (this.#position < this.#rows.length) {
      this.#position += 1;
      this.#wasNull = false;
      return true;
    }
    // Past the end
    this.#position = this.#rows.length + 1;
    return false;
  }

  /**
   * Move the cursor to just before the first row.
   */
  beforeFirst() {
    this.#ensureOpen();
    this.#ensureScrollable();
    this.#position = 0;
  }

  /**
   * Move the cursor past the last row.
   */
  async afterLast() {
    this.#ensureOpen();
    this.#ensureScrollable();
    if (!this.#endOfData && this.#cursorManager) {
      await this.#fetchRemaining();
    }
    this.#position = this.#rows.length + 1;
  }

  /** @returns {Promise<boolean>} true if moved onto row 1. */
  async first() {
    this.#ensureOpen();
    this.#ensureScrollable();
    if (this.#rows.length === 0 && !this.#endOfData) {
      await this.#fetchBatch();
    }
    if (this.#rows.length === 0) return false;
    this.#position = 1;
    return true;
  }

  /** @returns {Promise<boolean>} true if moved onto the last row. */
  async last() {
    this.#ensureOpen();
    this.#ensureScrollable();
    await this.#fetchRemaining();
    if (this.#rows.length === 0) return false;
    this.#position = this.#rows.length;
    return true;
  }

  /** @returns {Promise<boolean>} true if moved backward one row. */
  async previous() {
    this.#ensureOpen();
    this.#ensureScrollable();
    if (this.#position <= 1) {
      this.#position = 0;
      return false;
    }
    this.#position -= 1;
    this.#wasNull = false;
    return true;
  }

  /**
   * Move to an absolute 1-based row. Negative values count from end.
   * @param {number} row
   * @returns {Promise<boolean>} true if positioned on a valid row.
   */
  async absolute(row) {
    this.#ensureOpen();
    this.#ensureScrollable();
    if (row === 0) { this.#position = 0; return false; }

    if (row < 0) {
      await this.#fetchRemaining();
      const idx = this.#rows.length + row + 1;
      if (idx < 1) { this.#position = 0; return false; }
      this.#position = idx;
      return true;
    }
    // Positive: fetch enough rows to determine validity
    while (this.#rows.length < row && !this.#endOfData && this.#cursorManager) {
      await this.#fetchBatch();
    }
    if (row > this.#rows.length) {
      this.#position = this.#rows.length + 1;
      return false;
    }
    this.#position = row;
    return true;
  }

  /**
   * Move relative to the current position.
   */
  async relative(offset) {
    this.#ensureOpen();
    this.#ensureScrollable();
    return this.absolute(this.#position + offset);
  }

  /** @returns {boolean} whether cursor is before the first row. */
  isBeforeFirst() {
    return this.#position === 0 && this.#rows.length > 0;
  }

  /** @returns {boolean} whether cursor is past the last row. */
  isAfterLast() {
    return this.#endOfData && this.#position > this.#rows.length && this.#rows.length > 0;
  }

  /** @returns {boolean} whether cursor is on the first row. */
  isFirst() {
    return this.#position === 1 && this.#rows.length >= 1;
  }

  /**
   * @returns {Promise<boolean>} whether cursor is on the last row (requires
   *   exhausting the cursor to know).
   */
  async isLast() {
    if (this.#position < 1 || this.#position > this.#rows.length) return false;
    if (this.#position === this.#rows.length && !this.#endOfData) {
      // Need a peek-ahead fetch
      await this.#fetchBatch();
    }
    return this.#position === this.#rows.length && this.#endOfData;
  }

  /** @returns {number} current 1-based row number, 0 if not on a row. */
  getRow() {
    if (this.#position < 1 || this.#position > this.#rows.length) return 0;
    return this.#position;
  }

  // --- Column lookup ---

  /**
   * Map a column name to its 1-based index.
   * @param {string} name
   * @returns {number}
   */
  findColumn(name) {
    if (!this.#nameIndex) {
      this.#nameIndex = new Map();
      for (let i = 0; i < this.#columnDescriptors.length; i++) {
        const d = this.#columnDescriptors[i];
        const nm = (d.name || d.label || `COL${i}`).toUpperCase();
        if (!this.#nameIndex.has(nm)) {
          this.#nameIndex.set(nm, i + 1);
        }
      }
    }
    const idx = this.#nameIndex.get(String(name).toUpperCase());
    if (!idx) throw new Error(`Column not found: ${name}`);
    return idx;
  }

  // --- Typed getters ---

  /**
   * Generic typed getter. Accepts either a 1-based index or a column name.
   * Updates wasNull() appropriately.
   */
  getObject(columnOrName) {
    const row = this.#currentRow();
    const [, value] = this.#readColumn(row, columnOrName);
    return value;
  }

  getString(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    if (Buffer.isBuffer(v)) return v.toString('utf8');
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }

  getBoolean(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'bigint') return v !== 0n;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === 't' || s === 'y' || s === 'yes' || s === '1';
  }

  getByte(columnOrName) {
    return this.#getNumber(columnOrName) & 0xFF;
  }

  getShort(columnOrName) {
    const n = this.#getNumber(columnOrName);
    return (n << 16) >> 16;
  }

  getInt(columnOrName) {
    const n = this.#getNumber(columnOrName);
    return n | 0;
  }

  getLong(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return 0n;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    return BigInt(String(v).split('.')[0] || '0');
  }

  getFloat(columnOrName) {
    return this.#getNumber(columnOrName);
  }

  getDouble(columnOrName) {
    return this.#getNumber(columnOrName);
  }

  getBigDecimal(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    return String(v);
  }

  getBytes(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return Buffer.from(String(v), 'utf8');
  }

  getDate(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    if (v instanceof Date) return v;
    return new Date(String(v));
  }

  getTime(columnOrName) {
    return this.getDate(columnOrName);
  }

  getTimestamp(columnOrName) {
    return this.getDate(columnOrName);
  }

  /**
   * JDBC parity: returns a {@link Blob} wrapper. Buffer payload is
   * available via `.toBuffer()`.
   */
  getBlob(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    if (v instanceof Blob) return v;
    const buf = Buffer.isBuffer(v)
      ? v
      : v instanceof Uint8Array
        ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
        : Buffer.from(String(v), 'utf8');
    return new Blob({ data: buf, length: buf.length });
  }

  /**
   * JDBC parity: returns a {@link Clob} wrapper. String payload via
   * `.text()`.
   */
  getClob(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    if (v instanceof Clob) return v;
    const s = typeof v === 'string' ? v : String(v);
    return new Clob({ data: s, length: s.length });
  }

  /** Legacy sync accessor — returns Clob payload as a string. */
  getClobString(columnOrName) {
    return this.getString(columnOrName);
  }

  /**
   * JDBC parity: returns a {@link SQLXML} wrapper.
   */
  getSQLXML(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    if (v instanceof SQLXML) return v;
    const s = typeof v === 'string' ? v : String(v);
    return new SQLXML({ data: s, length: s.length });
  }

  /**
   * JDBC parity: returns a {@link SqlArray} wrapper.
   */
  getArray(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    if (v instanceof SqlArray) return v;
    const elements = Array.isArray(v) ? v : [v];
    return new SqlArray({ baseTypeName: 'UNKNOWN', elements });
  }

  /**
   * JDBC parity: returns a {@link RowId} wrapper.
   */
  getRowId(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return null;
    if (v instanceof RowId) return v;
    const bytes = Buffer.isBuffer(v)
      ? v
      : v instanceof Uint8Array
        ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
        : Buffer.from(String(v), 'utf8');
    return new RowId(bytes);
  }

  /**
   * @returns {boolean} whether the last getter saw SQL NULL.
   */
  wasNull() { return this.#wasNull; }

  // --- Warnings ---

  /** @returns {SqlWarning|null} */
  getWarnings() { return this.#warnings; }

  clearWarnings() { this.#warnings = null; }

  /** Append a warning to the chain. */
  addWarning(msg, opts = {}) {
    const w = msg instanceof SqlWarning ? msg : new SqlWarning(msg, opts);
    if (!this.#warnings) this.#warnings = w;
    else this.#warnings.setNextWarning(w);
  }

  // --- Row access ---

  /**
   * Get all rows as an array.
   * If the cursor is still open, fetches all remaining rows first.
   * @returns {Promise<object[]>}
   */
  async toArray() {
    if (!this.#endOfData && this.#cursorManager) {
      await this.#fetchRemaining();
    }
    return [...this.#rows];
  }

  /**
   * Get a specific row by zero-based index (legacy helper).
   * @param {number} index
   * @returns {object|undefined}
   */
  get(index) {
    return this.#rows[index];
  }

  /**
   * Get the current row as a plain object.
   * @returns {object|null}
   */
  getCurrentRow() {
    if (this.#position < 1 || this.#position > this.#rows.length) return null;
    return this.#rows[this.#position - 1];
  }

  /**
   * Get the current row as an array, 1-based index → value.
   * Position 0 holds null (JDBC is 1-based).
   */
  getCurrentRowAsArray() {
    const row = this.getCurrentRow();
    if (!row) return null;
    const arr = new Array(this.#columnDescriptors.length + 1);
    arr[0] = null;
    for (let i = 0; i < this.#columnDescriptors.length; i++) {
      const d = this.#columnDescriptors[i];
      const name = d.name || d.label || `COL${i}`;
      arr[i + 1] = row[name];
    }
    return arr;
  }

  // --- Iteration ---

  /**
   * Synchronous iterator over already-fetched rows.
   */
  [Symbol.iterator]() {
    let i = 0;
    const rows = this.#rows;
    return {
      next() {
        if (i < rows.length) {
          return { value: rows[i++], done: false };
        }
        return { done: true };
      },
    };
  }

  /**
   * Async iterator that fetches rows on demand.
   */
  async *[Symbol.asyncIterator]() {
    // Yield already-fetched rows
    for (let i = 0; i < this.#rows.length; i++) {
      yield this.#rows[i];
    }

    // Fetch more if cursor is still open
    while (!this.#endOfData && this.#cursorManager && !this.#closed) {
      const batch = await this.#cursorManager.fetch(this.#rpbId, this.#fetchSize);
      if (batch.length === 0) {
        this.#endOfData = true;
        break;
      }
      this.#rows.push(...batch);
      for (const row of batch) {
        yield row;
      }
    }
  }

  /**
   * Close the result set and its underlying cursor.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#cursorManager && this.#rpbId) {
      try {
        await this.#cursorManager.closeCursor(this.#rpbId);
      } catch { /* ignore close errors */ }
    }
    const hook = this.#onClose;
    this.#onClose = null; // fire at most once
    if (hook) {
      try { await hook(); } catch { /* ignore hook errors */ }
    }
  }

  // --- Internal helpers ---

  #getNumber(columnOrName) {
    const v = this.getObject(columnOrName);
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  #currentRow() {
    if (this.#position < 1 || this.#position > this.#rows.length) {
      throw new Error('ResultSet cursor is not on a valid row');
    }
    return this.#rows[this.#position - 1];
  }

  #readColumn(row, columnOrName) {
    let name;
    let idx;
    if (typeof columnOrName === 'number') {
      idx = columnOrName;
      const d = this.#columnDescriptors[idx - 1];
      if (!d) {
        throw new RangeError(
          `Column index out of range: ${columnOrName} (expected 1..${this.#columnDescriptors.length})`,
        );
      }
      name = d.name || d.label || `COL${idx - 1}`;
    } else {
      name = String(columnOrName);
      idx = this.findColumn(name);
    }
    const v = row[name];
    this.#wasNull = v == null;
    return [idx, v];
  }

  async #fetchBatch() {
    if (this.#endOfData || !this.#cursorManager) return;
    const batch = await this.#cursorManager.fetch(this.#rpbId, this.#fetchSize);
    if (batch.length === 0) {
      this.#endOfData = true;
      return;
    }
    this.#rows.push(...batch);
  }

  async #fetchRemaining() {
    while (!this.#endOfData && this.#cursorManager) {
      const batch = await this.#cursorManager.fetch(this.#rpbId, this.#fetchSize);
      if (batch.length === 0) {
        this.#endOfData = true;
        break;
      }
      this.#rows.push(...batch);
    }
  }

  #ensureOpen() {
    if (this.#closed) throw new Error('ResultSet is closed');
  }

  #ensureScrollable() {
    // The underlying host cursor is forward-only; scrollable positioning
    // only works on rows already materialized into memory.
    if (this.#type === ResultSetType.forwardOnly) {
      // Allow scrolling inside the materialized buffer but not across
      // partially-consumed server cursors.
    }
  }
}
