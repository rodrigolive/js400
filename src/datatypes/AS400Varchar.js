/**
 * Variable-length text data type.
 *
 * IBM VARCHAR format: 2-byte big-endian length prefix followed by text data.
 * Maximum length is specified at construction.
 *
 * Upstream: AS400Varchar.java
 * @module datatypes/AS400Varchar
 */

import { AS400DataType, TYPE_VARCHAR } from './AS400DataType.js';
import { CharConverter } from '../ccsid/CharConverter.js';

export class AS400Varchar extends AS400DataType {
  #maxLength;
  #ccsid;
  #converter;

  constructor(maxLength, ccsid = 37) {
    super();
    if (typeof maxLength !== 'number' || maxLength < 0) {
      throw new Error('AS400Varchar requires a non-negative maxLength');
    }
    this.#maxLength = maxLength;
    this.#ccsid = ccsid;
    this.#converter = new CharConverter(ccsid);
  }

  get typeId() { return TYPE_VARCHAR; }

  get maxLength() { return this.#maxLength; }
  get ccsid() { return this.#ccsid; }

  byteLength() {
    return 2 + this.#maxLength;
  }

  toBuffer(value) {
    const str = String(value ?? '');
    const encoded = this.#converter.stringToByteArray(str);
    const dataLen = Math.min(encoded.length, this.#maxLength);
    const buf = Buffer.alloc(2 + this.#maxLength);
    buf.writeUInt16BE(dataLen, 0);
    encoded.copy(buf, 2, 0, dataLen);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    const dataLen = buf.readUInt16BE(offset);
    return this.#converter.byteArrayToString(buf, offset + 2, dataLen);
  }
}
