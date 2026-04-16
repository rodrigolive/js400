/**
 * Row ID wrapper.
 *
 * Wraps a DB2 ROWID value as a Buffer with hex string representation.
 *
 * Upstream: AS400JDBCRowId.java
 * @module db/api/RowId
 */

export class RowId {
  #bytes;

  /**
   * @param {Buffer|Uint8Array} bytes - raw ROWID bytes
   */
  constructor(bytes) {
    this.#bytes = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes || []);
  }

  get bytes() {
    return this.#bytes;
  }

  get length() {
    return this.#bytes.length;
  }

  toString() {
    return this.#bytes.toString('hex').toUpperCase();
  }

  equals(other) {
    if (!(other instanceof RowId)) return false;
    return this.#bytes.equals(other.#bytes);
  }

  toJSON() {
    return this.toString();
  }
}
