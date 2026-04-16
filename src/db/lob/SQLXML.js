/**
 * SQLXML wrapper for XML LOB data.
 *
 * Provides access to DB2 XML column values as strings,
 * backed by a Clob or pre-fetched string data.
 *
 * Upstream: AS400JDBCSQLXML*.java
 * @module db/lob/SQLXML
 */

import { Clob } from './Clob.js';

export class SQLXML {
  #clob;

  /**
   * @param {object} opts
   * @param {string} [opts.data] - pre-fetched XML string
   * @param {import('../protocol/DBLobData.js').LobHandle} [opts.lobHandle]
   * @param {number} [opts.length]
   */
  constructor(opts = {}) {
    this.#clob = new Clob(opts);
  }

  get length() { return this.#clob.length; }

  /**
   * Get the XML content as a string.
   * @returns {Promise<string>}
   */
  async text() {
    return this.#clob.text();
  }

  /**
   * Alias for text().
   * @returns {Promise<string>}
   */
  async getString() {
    return this.#clob.text();
  }

  /**
   * Get the XML content as a Buffer.
   * @returns {Promise<Buffer>}
   */
  async toBuffer() {
    return this.#clob.toBuffer();
  }

  /**
   * Get a Readable stream of the XML content.
   * @param {object} [opts]
   * @returns {import('node:stream').Readable}
   */
  getReadableStream(opts) {
    return this.#clob.getReadableStream(opts);
  }

  /**
   * Free the underlying LOB locator.
   */
  async free() {
    await this.#clob.free();
  }

  /**
   * Create an SQLXML from a string.
   * @param {string} xml
   * @returns {SQLXML}
   */
  static from(xml) {
    return new SQLXML({ data: String(xml), length: xml.length });
  }
}
