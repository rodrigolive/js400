/**
 * Signed 8-byte integer data type (big-endian).
 *
 * Decodes to `number` by default when the value fits a JS safe integer
 * (|value| <= 2^53-1), falling back to `bigint` only when precision would be
 * lost. Pass `{ bigint: 'bigint' }` to always return native BigInt, or
 * 'number' / 'string' to force those representations. See coerceInt64.
 *
 * Upstream: AS400Bin8.java
 * @module datatypes/AS400Bin8
 */

import { AS400DataType, TYPE_BIN8 } from './AS400DataType.js';
import { coerceInt64, normalizeBigintMode } from '../db/types/int64.js';

export class AS400Bin8 extends AS400DataType {
  /**
   * @param {object} [opts]
   * @param {('auto'|'number'|'bigint'|'string')} [opts.bigint='auto']
   */
  constructor(opts = {}) {
    super();
    this.mode = normalizeBigintMode(opts.bigint);
  }

  get typeId() { return TYPE_BIN8; }

  byteLength() { return 8; }

  toBuffer(value) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(value), 0);
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return coerceInt64(buf.readBigInt64BE(offset), this.mode);
  }
}
