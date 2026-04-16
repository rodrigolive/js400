/**
 * CCSID-aware text output stream for IFS files.
 *
 * Converts Unicode strings to the specified CCSID encoding
 * before writing them to the file.
 *
 * Upstream: IFSTextFileOutputStream.java
 * @module ifs/IFSTextFileOutputStream
 */

import { IFSFileOutputStream } from './IFSFileOutputStream.js';
import { CharConverter } from '../ccsid/CharConverter.js';

export class IFSTextFileOutputStream {
  #stream;
  #ccsid;
  #converter;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - Full IFS path
   * @param {object} [opts]
   * @param {number} [opts.ccsid=37] - CCSID for file encoding (default: EBCDIC 37)
   * @param {boolean} [opts.append=false]
   * @param {number} [opts.shareMode]
   */
  constructor(system, path, opts = {}) {
    this.#ccsid = opts.ccsid ?? 37;
    this.#stream = new IFSFileOutputStream(system, path, {
      ...opts,
      ccsid: this.#ccsid,
    });
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
   * Write a string to the file, converting from Unicode to the file's CCSID.
   * @param {string} text
   * @returns {Promise<void>}
   */
  async write(text) {
    const data = this.#converter.stringToByteArray(text);
    await this.#stream.write(data);
  }

  /**
   * Close the file handle.
   * @returns {Promise<void>}
   */
  async close() {
    await this.#stream.close();
  }
}
