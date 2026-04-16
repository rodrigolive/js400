/**
 * Numeric SQL type handlers.
 *
 * Upstream: SQLInteger.java, SQLSmallint.java, SQLBigint.java, SQLDecimal.java,
 *           SQLNumeric.java, SQLFloat.java, SQLDouble.java, SQLReal.java,
 *           SQLDecFloat16.java, SQLDecFloat34.java, SQLTinyint.java
 * @module db/types/numeric
 */

function decodeSmallint(buf, offset, desc) {
  return { value: buf.readInt16BE(offset), bytesRead: 2 };
}

function encodeSmallint(value, desc) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(Number(value) | 0, 0);
  return b;
}

function encodeSmallintInto(value, buf, offset, fieldLen) {
  buf.writeInt16BE(Number(value) | 0, offset);
  return 2;
}

function decodeInteger(buf, offset, desc) {
  return { value: buf.readInt32BE(offset), bytesRead: 4 };
}

function encodeInteger(value, desc) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Number(value) | 0, 0);
  return b;
}

function encodeIntegerInto(value, buf, offset, fieldLen) {
  buf.writeInt32BE(Number(value) | 0, offset);
  return 4;
}

function decodeBigint(buf, offset, desc) {
  return { value: buf.readBigInt64BE(offset), bytesRead: 8 };
}

function encodeBigint(value, desc) {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(value), 0);
  return b;
}

function encodeBigintInto(value, buf, offset, fieldLen) {
  buf.writeBigInt64BE(BigInt(value), offset);
  return 8;
}

function decodeFloat(buf, offset, desc) {
  if (desc.length === 4) {
    return { value: buf.readFloatBE(offset), bytesRead: 4 };
  }
  return { value: buf.readDoubleBE(offset), bytesRead: 8 };
}

function encodeFloat(value, desc) {
  if (desc.length === 4) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(Number(value), 0);
    return b;
  }
  const b = Buffer.alloc(8);
  b.writeDoubleBE(Number(value), 0);
  return b;
}

function encodeFloatInto(value, buf, offset, fieldLen, desc) {
  if (desc.length === 4) {
    buf.writeFloatBE(Number(value), offset);
    return 4;
  }
  buf.writeDoubleBE(Number(value), offset);
  return 8;
}

/**
 * Decode a packed decimal from EBCDIC packed format.
 * Each byte holds two digits except the last nibble which is the sign.
 * Positive sign: 0xF, 0xC; Negative: 0xD, 0xB.
 */
function decodeDecimal(buf, offset, desc) {
  const byteLen = desc.length;
  const scale = desc.scale;
  let str = '';
  let negative = false;

  for (let i = 0; i < byteLen; i++) {
    const b = buf[offset + i];
    const hi = (b >> 4) & 0x0F;
    const lo = b & 0x0F;

    if (i < byteLen - 1) {
      str += hi.toString() + lo.toString();
    } else {
      str += hi.toString();
      if (lo === 0x0D || lo === 0x0B) negative = true;
    }
  }

  str = str.replace(/^0+/, '') || '0';
  if (scale > 0) {
    while (str.length <= scale) str = '0' + str;
    const intPart = str.slice(0, str.length - scale);
    const fracPart = str.slice(str.length - scale);
    str = intPart + '.' + fracPart;
  }
  if (negative) str = '-' + str;

  return { value: Number(str), bytesRead: byteLen };
}

function encodeDecimal(value, desc) {
  const byteLen = desc.length;
  const scale = desc.scale;
  const num = Number(value);
  const negative = num < 0;
  const abs = Math.abs(num);

  const scaled = Math.round(abs * Math.pow(10, scale));
  let digits = scaled.toString();
  const totalDigits = (byteLen * 2) - 1;
  while (digits.length < totalDigits) digits = '0' + digits;
  if (digits.length > totalDigits) digits = digits.slice(digits.length - totalDigits);

  const b = Buffer.alloc(byteLen);
  let dIdx = 0;
  for (let i = 0; i < byteLen - 1; i++) {
    const hi = parseInt(digits[dIdx++], 10);
    const lo = parseInt(digits[dIdx++], 10);
    b[i] = (hi << 4) | lo;
  }
  const lastHi = parseInt(digits[dIdx], 10);
  const sign = negative ? 0x0D : 0x0F;
  b[byteLen - 1] = (lastHi << 4) | sign;

  return b;
}

function encodeDecimalInto(value, buf, offset, fieldLen, desc) {
  const byteLen = desc.length;
  const scale = desc.scale;
  const num = Number(value);
  const negative = num < 0;
  const abs = Math.abs(num);

  const scaled = Math.round(abs * Math.pow(10, scale));
  let digits = scaled.toString();
  const totalDigits = (byteLen * 2) - 1;
  while (digits.length < totalDigits) digits = '0' + digits;
  if (digits.length > totalDigits) digits = digits.slice(digits.length - totalDigits);

  let dIdx = 0;
  for (let i = 0; i < byteLen - 1; i++) {
    const hi = digits.charCodeAt(dIdx++) - 0x30;
    const lo = digits.charCodeAt(dIdx++) - 0x30;
    buf[offset + i] = (hi << 4) | lo;
  }
  const lastHi = digits.charCodeAt(dIdx) - 0x30;
  const sign = negative ? 0x0D : 0x0F;
  buf[offset + byteLen - 1] = (lastHi << 4) | sign;
  return byteLen;
}

/**
 * Decode zoned decimal (one digit per byte in EBCDIC zone format).
 * Zone nibble is 0xF for digits, last byte sign in low nibble.
 */
function decodeNumeric(buf, offset, desc) {
  const byteLen = desc.length;
  const scale = desc.scale;
  let str = '';
  let negative = false;

  for (let i = 0; i < byteLen; i++) {
    const b = buf[offset + i];
    const zone = (b >> 4) & 0x0F;
    const digit = b & 0x0F;
    str += digit.toString();
    if (i === byteLen - 1) {
      if (zone === 0x0D || zone === 0x0B) negative = true;
    }
  }

  str = str.replace(/^0+/, '') || '0';
  if (scale > 0) {
    while (str.length <= scale) str = '0' + str;
    const intPart = str.slice(0, str.length - scale);
    const fracPart = str.slice(str.length - scale);
    str = intPart + '.' + fracPart;
  }
  if (negative) str = '-' + str;

  return { value: Number(str), bytesRead: byteLen };
}

function encodeNumeric(value, desc) {
  const byteLen = desc.length;
  const scale = desc.scale;
  const num = Number(value);
  const negative = num < 0;
  const abs = Math.abs(num);

  const scaled = Math.round(abs * Math.pow(10, scale));
  let digits = scaled.toString();
  while (digits.length < byteLen) digits = '0' + digits;
  if (digits.length > byteLen) digits = digits.slice(digits.length - byteLen);

  const b = Buffer.alloc(byteLen);
  for (let i = 0; i < byteLen; i++) {
    const d = parseInt(digits[i], 10);
    if (i === byteLen - 1) {
      const sign = negative ? 0x0D : 0x0F;
      b[i] = (sign << 4) | d;
    } else {
      b[i] = 0xF0 | d;
    }
  }
  return b;
}

function encodeNumericInto(value, buf, offset, fieldLen, desc) {
  const byteLen = desc.length;
  const scale = desc.scale;
  const num = Number(value);
  const negative = num < 0;
  const abs = Math.abs(num);

  const scaled = Math.round(abs * Math.pow(10, scale));
  let digits = scaled.toString();
  while (digits.length < byteLen) digits = '0' + digits;
  if (digits.length > byteLen) digits = digits.slice(digits.length - byteLen);

  for (let i = 0; i < byteLen; i++) {
    const d = digits.charCodeAt(i) - 0x30;
    if (i === byteLen - 1) {
      const sign = negative ? 0x0D : 0x0F;
      buf[offset + i] = (sign << 4) | d;
    } else {
      buf[offset + i] = 0xF0 | d;
    }
  }
  return byteLen;
}

/**
 * Decode DECFLOAT (16 or 34 digits).
 * For now, parse as a double since JS doesn't have native decimal types.
 */
function decodeDecFloat(buf, offset, desc) {
  const byteLen = desc.length;
  if (byteLen === 8) {
    return { value: buf.readDoubleBE(offset), bytesRead: 8 };
  }
  // DECFLOAT34 is 16 bytes — read as two doubles and approximate
  const hi = buf.readDoubleBE(offset);
  return { value: hi, bytesRead: byteLen };
}

function encodeDecFloat(value, desc) {
  const byteLen = desc.length;
  if (byteLen === 8) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(Number(value), 0);
    return b;
  }
  const b = Buffer.alloc(byteLen);
  b.writeDoubleBE(Number(value), 0);
  return b;
}

function encodeDecFloatInto(value, buf, offset, fieldLen, desc) {
  buf.writeDoubleBE(Number(value), offset);
  if (desc.length > 8) {
    buf.fill(0, offset + 8, offset + desc.length);
  }
  return desc.length;
}

/**
 * Type handler registry keyed by the masked SQL type code.
 * Key = Math.abs(sqlType) & 0xFFFE
 */
export const numericTypes = {
  500: { name: 'SMALLINT', decode: decodeSmallint, encode: encodeSmallint, encodeInto: encodeSmallintInto },
  496: { name: 'INTEGER', decode: decodeInteger, encode: encodeInteger, encodeInto: encodeIntegerInto },
  492: { name: 'BIGINT', decode: decodeBigint, encode: encodeBigint, encodeInto: encodeBigintInto },
  480: { name: 'FLOAT', decode: decodeFloat, encode: encodeFloat, encodeInto: encodeFloatInto },
  484: { name: 'DECIMAL', decode: decodeDecimal, encode: encodeDecimal, encodeInto: encodeDecimalInto },
  488: { name: 'NUMERIC', decode: decodeNumeric, encode: encodeNumeric, encodeInto: encodeNumericInto },
  996: { name: 'DECFLOAT', decode: decodeDecFloat, encode: encodeDecFloat, encodeInto: encodeDecFloatInto },
};
