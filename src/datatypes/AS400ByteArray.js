/**
 * Raw byte array data type.
 *
 * Upstream: AS400ByteArray.java
 * @module datatypes/AS400ByteArray
 */

import { AS400DataType, TYPE_BYTE_ARRAY } from './AS400DataType.js';

export class AS400ByteArray extends AS400DataType {
  #length;

  constructor(length) {
    super();
    if (typeof length !== 'number' || length < 0) {
      throw new Error('AS400ByteArray requires a non-negative length');
    }
    this.#length = length;
  }

  get typeId() { return TYPE_BYTE_ARRAY; }

  byteLength() { return this.#length; }

  toBuffer(value) {
    const buf = Buffer.alloc(this.#length);
    if (value) {
      const src = Buffer.isBuffer(value) ? value : Buffer.from(value);
      src.copy(buf, 0, 0, Math.min(src.length, this.#length));
    }
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return Buffer.from(buf.subarray(offset, offset + this.#length));
  }
}
