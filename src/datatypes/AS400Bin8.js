/**
 * Signed 8-byte integer data type (big-endian).
 * Returns BigInt since values can exceed Number.MAX_SAFE_INTEGER.
 *
 * Upstream: AS400Bin8.java
 * @module datatypes/AS400Bin8
 */

import { AS400DataType, TYPE_BIN8 } from './AS400DataType.js';

export class AS400Bin8 extends AS400DataType {
  get typeId() { return TYPE_BIN8; }

  byteLength() { return 8; }

  toBuffer(value) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(value), 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.readBigInt64BE(offset);
  }
}
