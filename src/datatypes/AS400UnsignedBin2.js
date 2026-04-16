/**
 * Unsigned 2-byte integer data type (big-endian).
 *
 * Upstream: AS400UnsignedBin2.java
 * @module datatypes/AS400UnsignedBin2
 */

import { AS400DataType, TYPE_UBIN2 } from './AS400DataType.js';

export class AS400UnsignedBin2 extends AS400DataType {
  get typeId() { return TYPE_UBIN2; }

  byteLength() { return 2; }

  toBuffer(value) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(value, 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readUInt16BE(offset);
  }
}
