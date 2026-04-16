/**
 * Boolean data type (1 byte: 0xF1 = true, 0xF0 = false).
 *
 * Upstream: AS400Boolean.java — uses EBCDIC '1'/'0' encoding.
 * @module datatypes/AS400Boolean
 */

import { AS400DataType, TYPE_BOOLEAN } from './AS400DataType.js';

const EBCDIC_0 = 0xF0;
const EBCDIC_1 = 0xF1;

export class AS400Boolean extends AS400DataType {
  get typeId() { return TYPE_BOOLEAN; }

  byteLength() { return 1; }

  toBuffer(value) {
    const buf = Buffer.alloc(1);
    buf[0] = value ? EBCDIC_1 : EBCDIC_0;
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf[offset] === EBCDIC_1;
  }
}
