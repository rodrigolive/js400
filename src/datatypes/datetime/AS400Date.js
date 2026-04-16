/**
 * IBM i date data type.
 *
 * Supports IBM i date formats: *MDY, *DMY, *YMD, *JUL, *ISO, *USA, *EUR, *JIS,
 * *CYMD, *CMDY, *CDMY, *LONGJUL.
 *
 * Values are encoded/decoded as date strings in the specified format.
 *
 * Upstream: AS400Date.java
 * @module datatypes/datetime/AS400Date
 */

import { AS400DataType, TYPE_DATE } from '../AS400DataType.js';

const FORMATS = {
  '*MDY':     { pattern: 'MM/dd/yy',       len: 8,  sep: '/' },
  '*DMY':     { pattern: 'dd/MM/yy',       len: 8,  sep: '/' },
  '*YMD':     { pattern: 'yy/MM/dd',       len: 8,  sep: '/' },
  '*JUL':     { pattern: 'yy/ddd',         len: 6,  sep: '/' },
  '*ISO':     { pattern: 'yyyy-MM-dd',     len: 10, sep: '-' },
  '*USA':     { pattern: 'MM/dd/yyyy',     len: 10, sep: '/' },
  '*EUR':     { pattern: 'dd.MM.yyyy',     len: 10, sep: '.' },
  '*JIS':     { pattern: 'yyyy-MM-dd',     len: 10, sep: '-' },
  '*CYMD':    { pattern: 'Cyy/MM/dd',      len: 9,  sep: '/' },
  '*CMDY':    { pattern: 'CMM/dd/yy',      len: 9,  sep: '/' },
  '*CDMY':    { pattern: 'Cdd/MM/yy',      len: 9,  sep: '/' },
  '*LONGJUL': { pattern: 'yyyy/ddd',       len: 8,  sep: '/' },
};

export class AS400Date extends AS400DataType {
  #format;
  #separator;
  #formatInfo;

  constructor(format = '*ISO', separator) {
    super();
    const fmt = format.toUpperCase();
    this.#formatInfo = FORMATS[fmt];
    if (!this.#formatInfo) {
      throw new Error(`Unknown date format: ${format}`);
    }
    this.#format = fmt;
    this.#separator = separator ?? this.#formatInfo.sep;
  }

  get typeId() { return TYPE_DATE; }

  get format() { return this.#format; }

  byteLength() {
    return this.#formatInfo.len;
  }

  toBuffer(value) {
    const str = typeof value === 'string' ? value : this.#dateToString(value);
    const buf = Buffer.alloc(this.#formatInfo.len, 0x40);
    buf.write(str, 0, 'ascii');
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return buf.toString('ascii', offset, offset + this.#formatInfo.len).trim();
  }

  #dateToString(date) {
    if (date instanceof Date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const sep = this.#separator;

      switch (this.#format) {
        case '*ISO':
        case '*JIS':
          return `${y}-${m}-${d}`;
        case '*USA':
          return `${m}/${d}/${y}`;
        case '*EUR':
          return `${d}.${m}.${y}`;
        case '*MDY':
          return `${m}${sep}${d}${sep}${String(y).slice(-2)}`;
        case '*DMY':
          return `${d}${sep}${m}${sep}${String(y).slice(-2)}`;
        case '*YMD':
          return `${String(y).slice(-2)}${sep}${m}${sep}${d}`;
        default:
          return `${y}-${m}-${d}`;
      }
    }
    return String(value);
  }
}
