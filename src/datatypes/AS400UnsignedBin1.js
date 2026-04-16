/**
 * Unsigned 1-byte integer data type.
 *
 * Upstream: AS400UnsignedBin1.java
 * @module datatypes/AS400UnsignedBin1
 */

import { AS400DataType, TYPE_UBIN1 } from './AS400DataType.js';

export class AS400UnsignedBin1 extends AS400DataType {
  get typeId() { return TYPE_UBIN1; }

  byteLength() { return 1; }

  toBuffer(value) {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(value, 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readUInt8(offset);
  }
}
