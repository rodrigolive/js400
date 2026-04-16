/**
 * Unsigned 8-byte integer data type (big-endian).
 * Returns BigInt since values can exceed Number.MAX_SAFE_INTEGER.
 *
 * Upstream: AS400UnsignedBin8.java
 * @module datatypes/AS400UnsignedBin8
 */

import { AS400DataType, TYPE_UBIN8 } from './AS400DataType.js';

export class AS400UnsignedBin8 extends AS400DataType {
  get typeId() { return TYPE_UBIN8; }

  byteLength() { return 8; }

  toBuffer(value) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(value), 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readBigUInt64BE(offset);
  }
}
