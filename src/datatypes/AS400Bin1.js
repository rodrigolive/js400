/**
 * Signed 1-byte integer data type.
 *
 * Upstream: AS400Bin1.java
 * @module datatypes/AS400Bin1
 */

import { AS400DataType, TYPE_BIN1 } from './AS400DataType.js';

export class AS400Bin1 extends AS400DataType {
  get typeId() { return TYPE_BIN1; }

  byteLength() { return 1; }

  toBuffer(value) {
    const buf = Buffer.alloc(1);
    buf.writeInt8(value, 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readInt8(offset);
  }
}
