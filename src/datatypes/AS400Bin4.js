/**
 * Signed 4-byte integer data type (big-endian).
 *
 * Upstream: AS400Bin4.java
 * @module datatypes/AS400Bin4
 */

import { AS400DataType, TYPE_BIN4 } from './AS400DataType.js';

export class AS400Bin4 extends AS400DataType {
  get typeId() { return TYPE_BIN4; }

  byteLength() { return 4; }

  toBuffer(value) {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(value, 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readInt32BE(offset);
  }
}
