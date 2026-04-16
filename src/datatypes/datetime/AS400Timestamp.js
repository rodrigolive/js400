/**
 * IBM i timestamp data type.
 *
 * Format: yyyy-MM-dd-HH.mm.ss.mmmmmm (26 bytes)
 *
 * Values are encoded/decoded as timestamp strings.
 *
 * Upstream: AS400Timestamp.java
 * @module datatypes/datetime/AS400Timestamp
 */

import { AS400DataType, TYPE_TIMESTAMP } from '../AS400DataType.js';

const TIMESTAMP_LENGTH = 26;

export class AS400Timestamp extends AS400DataType {
  get typeId() { return TYPE_TIMESTAMP; }

  byteLength() {
    return TIMESTAMP_LENGTH;
  }

  toBuffer(value) {
    let str;
    if (typeof value === 'string') {
      str = value;
    } else if (value instanceof Date) {
      const y = value.getFullYear();
      const mo = String(value.getMonth() + 1).padStart(2, '0');
      const d = String(value.getDate()).padStart(2, '0');
      const h = String(value.getHours()).padStart(2, '0');
      const mi = String(value.getMinutes()).padStart(2, '0');
      const s = String(value.getSeconds()).padStart(2, '0');
      const us = String(value.getMilliseconds() * 1000).padStart(6, '0');
      str = `${y}-${mo}-${d}-${h}.${mi}.${s}.${us}`;
    } else {
      str = String(value);
    }

    str = str.padEnd(TIMESTAMP_LENGTH, '0');
    const buf = Buffer.alloc(TIMESTAMP_LENGTH, 0x40);
    buf.write(str.substring(0, TIMESTAMP_LENGTH), 0, 'ascii');
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.toString('ascii', offset, offset + TIMESTAMP_LENGTH).trim();
  }
}
