/**
 * Signed 2-byte integer data type (big-endian).
 *
 * Upstream: AS400Bin2.java
 * @module datatypes/AS400Bin2
 */

import { AS400DataType, TYPE_BIN2 } from './AS400DataType.js';

export class AS400Bin2 extends AS400DataType {
  get typeId() { return TYPE_BIN2; }

  byteLength() { return 2; }

  toBuffer(value) {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(value, 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readInt16BE(offset);
  }
}
