/**
 * CCSID-aware text input stream for IFS files.
 *
 * Reads binary data from the file and converts it to Unicode strings
 * using the specified CCSID (or the file's stored CCSID).
 *
 * Upstream: IFSTextFileInputStream.java
 * @module ifs/IFSTextFileInputStream
 */

import { IFSFileInputStream } from './IFSFileInputStream.js';
import { CharConverter } from '../ccsid/CharConverter.js';

export class IFSTextFileInputStream {
  #stream;
  #ccsid;
  #converter;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - Full IFS path
   * @param {object} [opts]
   * @param {number} [opts.ccsid=37] - CCSID of the file (default: EBCDIC 37)
   * @param {number} [opts.shareMode]
   */
  constructor(system, path, opts = {}) {
    this.#ccsid = opts.ccsid ?? 37;
    this.#stream = new IFSFileInputStream(system, path, opts);
    this.#converter = new CharConverter(this.#ccsid);
  }

  get path() { return this.#stream.path; }
  get ccsid() { return this.#ccsid; }

  /**
   * Open the underlying stream.
   * @returns {Promise<void>}
   */
  async open() {
    await this.#stream.open();
  }

  /**
   * Read text from the file.
   * @param {number} [length=65536] - Number of bytes to read before conversion
   * @returns {Promise<string>}
   */
  async read(length = 65536) {
    const data = await this.#stream.read(length);
    if (data.length === 0) return '';
    return this.#converter.byteArrayToString(data, 0, data.length);
  }

  /**
   * Read the entire file as text.
   * @returns {Promise<string>}
   */
  async readAll() {
    const data = await this.#stream.readAll();
    if (data.length === 0) return '';
    return this.#converter.byteArrayToString(data, 0, data.length);
  }

  /**
   * Close the file handle.
   * @returns {Promise<void>}
   */
  async close() {
    await this.#stream.close();
  }
}
