/**
 * Zoned decimal data type.
 *
 * IBM zoned decimal stores one digit per byte.
 * Upper nibble (zone) is 0xF for all digits except the last.
 * Last byte zone: 0xF = positive, 0xD = negative.
 * Lower nibble is the digit value (0-9).
 * Total bytes = numDigits
 *
 * Values are represented as strings to preserve exact precision.
 *
 * Upstream: AS400ZonedDecimal.java
 * @module datatypes/AS400ZonedDecimal
 */

import { AS400DataType, TYPE_ZONED } from './AS400DataType.js';

export class AS400ZonedDecimal extends AS400DataType {
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

  get typeId() { return TYPE_ZONED; }

  get numDigits() { return this.#numDigits; }
  get numDecimalPositions() { return this.#numDecimalPositions; }

  byteLength() {
    return this.#numDigits;
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

    const digits = (intPart + fracPart).padStart(this.#numDigits, '0');
    const buf = Buffer.alloc(this.#numDigits);

    for (let i = 0; i < this.#numDigits; i++) {
      const d = parseInt(digits[i], 10) || 0;
      if (i === this.#numDigits - 1) {
        buf[i] = ((negative ? 0x0D : 0x0F) << 4) | d;
      } else {
        buf[i] = (0x0F << 4) | d;
      }
    }

    return buf;
  }

  fromBuffer(buf, offset = 0) {
    let digits = '';
    let negative = false;

    for (let i = 0; i < this.#numDigits; i++) {
      const b = buf[offset + i];
      const zone = (b >> 4) & 0x0F;
      const digit = b & 0x0F;
      digits += digit.toString();

      if (i === this.#numDigits - 1) {
        negative = (zone === 0x0D);
      }
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
