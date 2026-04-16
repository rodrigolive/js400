/**
 * Decimal floating-point data type.
 *
 * Supports IEEE 754 decimal64 (8 bytes, 16 digits) and
 * decimal128 (16 bytes, 34 digits).
 *
 * Values are represented as strings to preserve exact precision.
 * Uses Densely Packed Decimal (DPD) encoding for the coefficient.
 *
 * Upstream: AS400DecFloat.java
 * @module datatypes/AS400DecFloat
 */

import { AS400DataType, TYPE_DECFLOAT } from './AS400DataType.js';

// Build DPD lookup tables: 3 BCD digits (0-999) <-> 10-bit DPD
const bcdToDpd = new Uint16Array(1000);
const dpdToBcd = new Uint16Array(1024);

function initDpdTables() {
  for (let val = 0; val < 1000; val++) {
    const d0 = Math.floor(val / 100);
    const d1 = Math.floor((val % 100) / 10);
    const d2 = val % 10;
    const dpd = encodeDpdTriple(d0, d1, d2);
    bcdToDpd[val] = dpd;
    dpdToBcd[dpd] = val;
  }
}

function encodeDpdTriple(d0, d1, d2) {
  // IEEE 754 DPD encoding using case table
  const a = (d0 >> 3) & 1, b = (d0 >> 2) & 1, c = (d0 >> 1) & 1, d = d0 & 1;
  const e = (d1 >> 3) & 1, f = (d1 >> 2) & 1, g = (d1 >> 1) & 1, h = d1 & 1;
  const i = (d2 >> 3) & 1, j = (d2 >> 2) & 1, k = (d2 >> 1) & 1, m = d2 & 1;

  let p, q, r, s, t, u, v, w, x, y;

  if (!a && !e && !i) {
    p=b; q=c; r=d; s=f; t=g; u=h; v=0; w=j; x=k; y=m;
  } else if (!a && !e && i) {
    p=b; q=c; r=d; s=f; t=g; u=h; v=1; w=0; x=0; y=m;
  } else if (!a && e && !i) {
    p=b; q=c; r=d; s=j; t=k; u=h; v=1; w=0; x=1; y=m;
  } else if (!a && e && i) {
    p=b; q=c; r=d; s=0; t=0; u=h; v=1; w=1; x=1; y=m;
  } else if (a && !e && !i) {
    p=j; q=k; r=d; s=f; t=g; u=h; v=1; w=1; x=0; y=m;
  } else if (a && !e && i) {
    p=f; q=g; r=d; s=0; t=1; u=h; v=1; w=1; x=0; y=m;
  } else if (a && e && !i) {
    p=j; q=k; r=d; s=0; t=0; u=h; v=1; w=1; x=1; y=m;
  } else {
    p=0; q=0; r=d; s=0; t=1; u=h; v=1; w=1; x=1; y=m;
  }

  return (p << 9) | (q << 8) | (r << 7) | (s << 6) | (t << 5) |
         (u << 4) | (v << 3) | (w << 2) | (x << 1) | y;
}

initDpdTables();

export class AS400DecFloat extends AS400DataType {
  #numBytes;
  #precision;

  constructor(precision = 34) {
    super();
    if (precision !== 16 && precision !== 34) {
      throw new Error('AS400DecFloat precision must be 16 or 34');
    }
    this.#precision = precision;
    this.#numBytes = precision === 16 ? 8 : 16;
  }

  get typeId() { return TYPE_DECFLOAT; }
  get precision() { return this.#precision; }
  byteLength() { return this.#numBytes; }

  toBuffer(value) {
    const str = String(value);
    const buf = Buffer.alloc(this.#numBytes);

    if (this.#precision === 16) {
      this.#encodeDecimal64(str, buf);
    } else {
      this.#encodeDecimal128(str, buf);
    }
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    if (this.#precision === 16) {
      return this.#decodeDecimal64(buf, offset);
    }
    return this.#decodeDecimal128(buf, offset);
  }

  #parseNumber(str) {
    const s = str.trim();
    if (s === 'Infinity' || s === '+Infinity') return { sign: 0, special: 'inf' };
    if (s === '-Infinity') return { sign: 1, special: 'inf' };
    if (s === 'NaN' || s === 'sNaN') return { sign: 0, special: 'nan' };

    let sign = 0;
    let rest = s;
    if (rest.startsWith('-')) { sign = 1; rest = rest.substring(1); }
    else if (rest.startsWith('+')) { rest = rest.substring(1); }

    let exp = 0;
    const eIdx = rest.search(/[eE]/);
    if (eIdx >= 0) {
      exp = parseInt(rest.substring(eIdx + 1), 10);
      rest = rest.substring(0, eIdx);
    }

    const dotIdx = rest.indexOf('.');
    let digits;
    if (dotIdx >= 0) {
      exp -= (rest.length - dotIdx - 1);
      digits = rest.replace('.', '');
    } else {
      digits = rest;
    }

    digits = digits.replace(/^0+/, '') || '0';
    return { sign, digits, exp };
  }

  // --- Decimal64 (8 bytes, 16 coefficient digits, biased exponent 398) ---

  #encodeDecimal64(str, buf) {
    const p = this.#parseNumber(str);
    if (p.special === 'inf') { buf[0] = p.sign ? 0xF8 : 0x78; return; }
    if (p.special === 'nan') { buf[0] = 0x7C; return; }

    let { sign, digits, exp } = p;
    if (digits.length > 16) digits = digits.substring(0, 16);
    exp -= (16 - digits.length);
    digits = digits.padEnd(16, '0');
    const biased = exp + 398;

    const msd = parseInt(digits[0], 10);
    const expHi = (biased >> 8) & 0x03;
    const expLo = biased & 0xFF;

    if (msd >= 8) {
      buf[0] = (sign << 7) | 0x60 | (expHi << 1) | (msd & 1);
    } else {
      buf[0] = (sign << 7) | (expHi << 5) | (msd << 2) | ((expLo >> 6) & 0x03);
    }

    if (msd >= 8) {
      buf[1] = expLo;
    } else {
      buf[1] = ((expLo & 0x3F) << 2);
    }

    this.#packTrailing(digits, 1, 5, buf, msd >= 8 ? 16 : 14);
  }

  #decodeDecimal64(buf, offset) {
    const b0 = buf[offset];
    const sign = (b0 >> 7) & 1;

    if ((b0 & 0x7C) === 0x78) return sign ? '-Infinity' : 'Infinity';
    if ((b0 & 0x7C) === 0x7C) return 'NaN';

    let msd, biased;
    if ((b0 & 0x60) === 0x60) {
      msd = 8 + (b0 & 1);
      const expHi = (b0 >> 1) & 0x03;
      biased = (expHi << 8) | buf[offset + 1];
    } else {
      msd = (b0 >> 2) & 0x07;
      const expHi = (b0 >> 5) & 0x03;
      biased = (expHi << 8) | ((b0 & 0x03) << 6) | ((buf[offset + 1] >> 2) & 0x3F);
    }

    const trailing = this.#unpackTrailing(buf, offset,
      (b0 & 0x60) === 0x60 ? 16 : 14, 5);
    let digits = msd.toString() + trailing;
    const exp = biased - 398;

    return this.#format(sign, digits, exp);
  }

  // --- Decimal128 (16 bytes, 34 coefficient digits, biased exponent 6176) ---

  #encodeDecimal128(str, buf) {
    const p = this.#parseNumber(str);
    if (p.special === 'inf') { buf[0] = p.sign ? 0xF8 : 0x78; return; }
    if (p.special === 'nan') { buf[0] = 0x7C; return; }

    let { sign, digits, exp } = p;
    if (digits.length > 34) digits = digits.substring(0, 34);
    exp -= (34 - digits.length);
    digits = digits.padEnd(34, '0');
    const biased = exp + 6176;

    const msd = parseInt(digits[0], 10);
    const expHi = (biased >> 12) & 0x03;

    if (msd >= 8) {
      buf[0] = (sign << 7) | 0x60 | (expHi << 1) | (msd & 1);
      buf[1] = (biased >> 4) & 0xFF;
      buf[2] = ((biased & 0x0F) << 4);
      this.#packTrailing(digits, 1, 11, buf, 20);
    } else {
      buf[0] = (sign << 7) | (expHi << 5) | (msd << 2) | ((biased >> 10) & 0x03);
      buf[1] = (biased >> 2) & 0xFF;
      buf[2] = ((biased & 0x03) << 6);
      this.#packTrailing(digits, 1, 11, buf, 18);
    }
  }

  #decodeDecimal128(buf, offset) {
    const b0 = buf[offset];
    const sign = (b0 >> 7) & 1;

    if ((b0 & 0x7C) === 0x78) return sign ? '-Infinity' : 'Infinity';
    if ((b0 & 0x7C) === 0x7C) return 'NaN';

    let msd, biased, bitStart;
    if ((b0 & 0x60) === 0x60) {
      msd = 8 + (b0 & 1);
      const expHi = (b0 >> 1) & 0x03;
      biased = (expHi << 12) | (buf[offset + 1] << 4) | ((buf[offset + 2] >> 4) & 0x0F);
      bitStart = 20;
    } else {
      msd = (b0 >> 2) & 0x07;
      const expHi = (b0 >> 5) & 0x03;
      biased = (expHi << 12) | ((b0 & 0x03) << 10) | (buf[offset + 1] << 2) | ((buf[offset + 2] >> 6) & 0x03);
      bitStart = 18;
    }

    const trailing = this.#unpackTrailing(buf, offset, bitStart, 11);
    let digits = msd.toString() + trailing;
    const exp = biased - 6176;

    return this.#format(sign, digits, exp);
  }

  // --- DPD packing helpers ---

  #packTrailing(digits, startDigitIdx, numGroups, buf, bitOffset) {
    let bitPos = bitOffset;
    for (let g = 0; g < numGroups; g++) {
      const d0 = parseInt(digits[startDigitIdx + g * 3], 10) || 0;
      const d1 = parseInt(digits[startDigitIdx + g * 3 + 1], 10) || 0;
      const d2 = parseInt(digits[startDigitIdx + g * 3 + 2], 10) || 0;
      const dpd = bcdToDpd[d0 * 100 + d1 * 10 + d2];

      for (let b = 9; b >= 0; b--) {
        const byteIdx = Math.floor(bitPos / 8);
        const bitIdx = 7 - (bitPos % 8);
        buf[byteIdx] |= (((dpd >> b) & 1) << bitIdx);
        bitPos++;
      }
    }
  }

  #unpackTrailing(buf, offset, bitOffset, numGroups) {
    let result = '';
    let bitPos = bitOffset;
    for (let g = 0; g < numGroups; g++) {
      let dpd = 0;
      for (let b = 9; b >= 0; b--) {
        const byteIdx = Math.floor(bitPos / 8);
        const bitIdx = 7 - (bitPos % 8);
        dpd |= (((buf[offset + byteIdx] >> bitIdx) & 1) << b);
        bitPos++;
      }
      const val = dpdToBcd[dpd] || 0;
      result += String(val).padStart(3, '0');
    }
    return result;
  }

  #format(sign, digits, exponent) {
    // Strip trailing zeros from coefficient, adjust exponent
    while (digits.length > 1 && digits[digits.length - 1] === '0') {
      digits = digits.slice(0, -1);
      exponent++;
    }
    // Strip leading zeros
    digits = digits.replace(/^0+/, '') || '0';
    const adjExp = exponent + digits.length - 1;

    if (adjExp >= 0 && exponent >= 0) {
      const result = digits + (exponent > 0 ? '0'.repeat(exponent) : '');
      return (sign ? '-' : '') + result;
    }
    if (adjExp >= 0) {
      const dotPos = adjExp + 1;
      if (dotPos >= digits.length) {
        return (sign ? '-' : '') + digits;
      }
      return (sign ? '-' : '') + digits.substring(0, dotPos) + '.' + digits.substring(dotPos);
    }
    return (sign ? '-' : '') + '0.' + '0'.repeat(-adjExp - 1) + digits;
  }
}
