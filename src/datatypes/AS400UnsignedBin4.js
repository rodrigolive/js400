/**
 * Unsigned 4-byte integer data type (big-endian).
 *
 * Upstream: AS400UnsignedBin4.java
 * @module datatypes/AS400UnsignedBin4
 */

import { AS400DataType, TYPE_UBIN4 } from './AS400DataType.js';

export class AS400UnsignedBin4 extends AS400DataType {
  get typeId() { return TYPE_UBIN4; }

  byteLength() { return 4; }

  toBuffer(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value, 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readUInt32BE(offset);
  }
}
