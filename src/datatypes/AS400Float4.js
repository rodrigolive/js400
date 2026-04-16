/**
 * 32-bit IEEE 754 single-precision float (big-endian).
 *
 * Upstream: AS400Float4.java
 * @module datatypes/AS400Float4
 */

import { AS400DataType, TYPE_FLOAT4 } from './AS400DataType.js';

export class AS400Float4 extends AS400DataType {
  get typeId() { return TYPE_FLOAT4; }

  byteLength() { return 4; }

  toBuffer(value) {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value, 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readFloatBE(offset);
  }
}
