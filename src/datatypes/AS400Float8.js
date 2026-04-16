/**
 * 64-bit IEEE 754 double-precision float (big-endian).
 *
 * Upstream: AS400Float8.java
 * @module datatypes/AS400Float8
 */

import { AS400DataType, TYPE_FLOAT8 } from './AS400DataType.js';

export class AS400Float8 extends AS400DataType {
  get typeId() { return TYPE_FLOAT8; }

  byteLength() { return 8; }

  toBuffer(value) {
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(value, 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readDoubleBE(offset);
  }
}
