/**
 * Clob wrapper for character LOB data.
 *
 * Provides JS-friendly access to CLOB, NCLOB, and DBCLOB values
 * with string and Readable stream support. Backed by a LobHandle
 * for locator-based lazy reading or by a pre-fetched string.
 *
 * Upstream: AS400JDBCClob*.java, AS400JDBCNClob*.java, AS400JDBCDBClob*.java
 * @module db/lob/Clob
 */

import { Readable } from 'node:stream';

export class Clob {
  #data;
  #lobHandle;
  #length;
  #encoding;

  /**
   * @param {object} opts
   * @param {string} [opts.data] - pre-fetched string content
   * @param {import('../protocol/DBLobData.js').LobHandle} [opts.lobHandle] - server locator
   * @param {number} [opts.length]
   * @param {string} [opts.encoding='utf8'] - encoding for LOB data conversion
   */
  constructor(opts = {}) {
    this.#data = opts.data ?? null;
    this.#lobHandle = opts.lobHandle || null;
    this.#length = opts.length ?? (this.#data ? this.#data.length : 0);
    this.#encoding = opts.encoding ?? 'utf8';
  }

  get length() { return this.#length; }

  /**
   * Get the entire CLOB as a string.
   * @returns {Promise<string>}
   */
  async text() {
    if (this.#data != null) return this.#data;

    if (this.#lobHandle) {
      const buf = await this.#lobHandle.readAll();
      this.#data = buf.toString(this.#encoding);
      return this.#data;
    }

    return '';
  }

  /**
   * Alias for text().
   * @returns {Promise<string>}
   */
  async toString() {
    return this.text();
  }

  /**
   * Read a substring of the CLOB.
   * @param {number} [start=0]
   * @param {number} [length]
   * @returns {Promise<string>}
   */
  async substring(start = 0, length) {
    const full = await this.text();
    if (length != null) {
      return full.slice(start, start + length);
    }
    return full.slice(start);
  }

  /**
   * Get the raw bytes of the CLOB.
   * @returns {Promise<Buffer>}
   */
  async toBuffer() {
    if (this.#data != null) {
      return Buffer.from(this.#data, this.#encoding);
    }

    if (this.#lobHandle) {
      return this.#lobHandle.readAll();
    }

    return Buffer.alloc(0);
  }

  /**
   * Get a Readable stream of the CLOB content (string mode).
   * @param {object} [opts]
   * @param {number} [opts.chunkSize=65536]
   * @returns {Readable}
   */
  getReadableStream(opts = {}) {
    const chunkSize = opts.chunkSize ?? 65536;
    const clob = this;
    let offset = 0;

    return new Readable({
      encoding: 'utf8',
      async read() {
        try {
          const full = await clob.text();
          if (offset >= full.length) {
            this.push(null);
            return;
          }
          const end = Math.min(offset + chunkSize, full.length);
          this.push(full.slice(offset, end));
          offset = end;
          if (offset >= full.length) {
            this.push(null);
          }
        } catch (err) {
          this.destroy(err);
        }
      },
    });
  }

  /**
   * Free the underlying LOB locator on the server.
   */
  async free() {
    if (this.#lobHandle && !this.#lobHandle.isFreed) {
      await this.#lobHandle.free();
    }
  }

  /**
   * Create a Clob from a string.
   * @param {string} str
   * @returns {Clob}
   */
  static from(str) {
    return new Clob({ data: String(str), length: str.length });
  }
}
