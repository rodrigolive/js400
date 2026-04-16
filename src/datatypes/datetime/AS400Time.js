/**
 * IBM i time data type.
 *
 * Supports IBM i time formats: *HMS, *ISO, *USA, *EUR, *JIS.
 *
 * Values are encoded/decoded as time strings in the specified format.
 *
 * Upstream: AS400Time.java
 * @module datatypes/datetime/AS400Time
 */

import { AS400DataType, TYPE_TIME } from '../AS400DataType.js';

const FORMATS = {
  '*HMS': { pattern: 'hh:mm:ss', len: 8, sep: ':' },
  '*ISO': { pattern: 'hh.mm.ss', len: 8, sep: '.' },
  '*USA': { pattern: 'hh:mm AM', len: 8, sep: ':' },
  '*EUR': { pattern: 'hh.mm.ss', len: 8, sep: '.' },
  '*JIS': { pattern: 'hh:mm:ss', len: 8, sep: ':' },
};

export class AS400Time extends AS400DataType {
  #format;
  #separator;
  #formatInfo;

  constructor(format = '*ISO', separator) {
    super();
    const fmt = format.toUpperCase();
    this.#formatInfo = FORMATS[fmt];
    if (!this.#formatInfo) {
      throw new Error(`Unknown time format: ${format}`);
    }
    this.#format = fmt;
    this.#separator = separator ?? this.#formatInfo.sep;
  }

  get typeId() { return TYPE_TIME; }

  get format() { return this.#format; }

  byteLength() {
    return this.#formatInfo.len;
  }

  toBuffer(value) {
    const str = typeof value === 'string' ? value : String(value);
    const buf = Buffer.alloc(this.#formatInfo.len, 0x40);
    buf.write(str, 0, 'ascii');
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.toString('ascii', offset, offset + this.#formatInfo.len).trim();
  }
}
