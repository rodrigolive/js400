/**
 * Blob wrapper for binary LOB data.
 *
 * Provides JS-friendly access to BLOB values with Buffer, Uint8Array,
 * and Readable stream support. Backed by a LobHandle for locator-based
 * lazy reading or by a pre-fetched Buffer for inline data.
 *
 * Upstream: AS400JDBCBlob*.java
 * @module db/lob/Blob
 */

import { Readable } from 'node:stream';

export class Blob {
  #data;
  #lobHandle;
  #length;

  /**
   * @param {object} opts
   * @param {Buffer} [opts.data] - pre-fetched blob data
   * @param {import('../protocol/DBLobData.js').LobHandle} [opts.lobHandle] - server locator
   * @param {number} [opts.length]
   */
  constructor(opts = {}) {
    this.#data = opts.data || null;
    this.#lobHandle = opts.lobHandle || null;
    this.#length = opts.length ?? (this.#data ? this.#data.length : 0);
  }

  get length() { return this.#length; }

  /**
   * Get the entire blob as a Buffer.
   * @returns {Promise<Buffer>}
   */
  async toBuffer() {
    if (this.#data) return this.#data;

    if (this.#lobHandle) {
      this.#data = await this.#lobHandle.readAll();
      return this.#data;
    }

    return Buffer.alloc(0);
  }

  /**
   * Get the blob as a Uint8Array.
   * @returns {Promise<Uint8Array>}
   */
  async toUint8Array() {
    const buf = await this.toBuffer();
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Read a portion of the blob.
   * @param {number} [offset=0]
   * @param {number} [length]
   * @returns {Promise<Buffer>}
   */
  async read(offset = 0, length) {
    if (this.#data) {
      const end = length != null ? offset + length : undefined;
      return this.#data.subarray(offset, end);
    }

    if (this.#lobHandle) {
      return this.#lobHandle.read(offset, length);
    }

    return Buffer.alloc(0);
  }

  /**
   * Get a Readable stream of the blob content.
   * @param {object} [opts]
   * @param {number} [opts.chunkSize=65536]
   * @returns {Readable}
   */
  getReadableStream(opts = {}) {
    const chunkSize = opts.chunkSize ?? 65536;
    const blob = this;
    let offset = 0;

    return new Readable({
      async read() {
        try {
          if (offset >= blob.length) {
            this.push(null);
            return;
          }
          const len = Math.min(chunkSize, blob.length - offset);
          const chunk = await blob.read(offset, len);
          offset += chunk.length;
          this.push(chunk);
          if (offset >= blob.length) {
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
   * Create a Blob from a Buffer or Uint8Array.
   * @param {Buffer|Uint8Array} data
   * @returns {Blob}
   */
  static from(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return new Blob({ data: buf, length: buf.length });
  }
}
