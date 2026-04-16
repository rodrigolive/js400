/**
 * Packed decimal data type.
 *
 * IBM packed decimal stores two digits per byte with a trailing sign nibble.
 * Sign: 0xF = positive, 0xD = negative, 0xC = positive (alternate).
 * Total bytes = Math.floor(numDigits / 2) + 1
 *
 * Values are represented as strings to preserve exact precision.
 *
 * Upstream: AS400PackedDecimal.java
 * @module datatypes/AS400PackedDecimal
 */

import { AS400DataType, TYPE_PACKED } from './AS400DataType.js';

export class AS400PackedDecimal extends AS400DataType {
  #numDigits;
  #numDecimalPositions;

  constructor(numDigits, numDecimalPositions) {
    super();
    if (numDigits < 1 || numDigits > 63) {
      throw new Error('numDigits must be between 1 and 63');
    }
    if (numDecimalPositions < 0 || numDecimalPositions > numDigits) {
      throw new Error('numDecimalPositions must be between 0 and numDigits');
    }
    this.#numDigits = numDigits;
    this.#numDecimalPositions = numDecimalPositions;
  }

  get typeId() { return TYPE_PACKED; }

  get numDigits() { return this.#numDigits; }
  get numDecimalPositions() { return this.#numDecimalPositions; }

  byteLength() {
    return Math.floor(this.#numDigits / 2) + 1;
  }

  toBuffer(value) {
    const str = String(value);
    const negative = str.startsWith('-');
    const abs = negative ? str.substring(1) : str;

    let intPart, fracPart;
    const dotIdx = abs.indexOf('.');
    if (dotIdx >= 0) {
      intPart = abs.substring(0, dotIdx);
      fracPart = abs.substring(dotIdx + 1);
    } else {
      intPart = abs;
      fracPart = '';
    }

    if (intPart === '') intPart = '0';

    const intDigits = this.#numDigits - this.#numDecimalPositions;
    intPart = intPart.padStart(intDigits, '0');
    if (intPart.length > intDigits) {
      intPart = intPart.substring(intPart.length - intDigits);
    }

    fracPart = fracPart.padEnd(this.#numDecimalPositions, '0');
    if (fracPart.length > this.#numDecimalPositions) {
      fracPart = fracPart.substring(0, this.#numDecimalPositions);
    }

    const digits = intPart + fracPart;
    const len = this.byteLength();
    const buf = Buffer.alloc(len);

    const paddedDigits = digits.padStart(this.#numDigits, '0');

    for (let i = 0; i < this.#numDigits; i++) {
      const d = parseInt(paddedDigits[i], 10) || 0;
      const byteIdx = Math.floor(i / 2);
      if (i % 2 === 0) {
        buf[byteIdx] = (d << 4);
      } else {
        buf[byteIdx] |= d;
      }
    }

    const signNibble = negative ? 0x0D : 0x0F;
    const lastByteIdx = len - 1;
    if (this.#numDigits % 2 === 0) {
      buf[lastByteIdx] = (parseInt(paddedDigits[this.#numDigits - 1], 10) << 4) | signNibble;
    } else {
      buf[lastByteIdx] = (buf[lastByteIdx] & 0xF0) | signNibble;
    }

    return buf;
  }

  fromBuffer(buf, offset = 0) {
    const len = this.byteLength();
    let digits = '';
    let negative = false;

    for (let i = 0; i < len; i++) {
      const b = buf[offset + i];
      const hi = (b >> 4) & 0x0F;
      const lo = b & 0x0F;

      if (i === len - 1) {
        digits += hi.toString();
        negative = (lo === 0x0D);
      } else {
        digits += hi.toString() + lo.toString();
      }
    }

    while (digits.length < this.#numDigits) {
      digits = '0' + digits;
    }

    let result;
    if (this.#numDecimalPositions > 0) {
      const splitPos = digits.length - this.#numDecimalPositions;
      let intPart = digits.substring(0, splitPos).replace(/^0+/, '') || '0';
      const fracPart = digits.substring(splitPos);
      result = intPart + '.' + fracPart;
    } else {
      result = digits.replace(/^0+/, '') || '0';
    }

    if (negative && result !== '0' && !result.match(/^0\.0+$/)) {
      result = '-' + result;
    }

    return result;
  }
}
