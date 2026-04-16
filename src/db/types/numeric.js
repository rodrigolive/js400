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

function decodeInteger(buf, offset, desc) {
  return { value: buf.readInt32BE(offset), bytesRead: 4 };
}

function encodeInteger(value, desc) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Number(value) | 0, 0);
  return b;
}

function decodeBigint(buf, offset, desc) {
  return { value: buf.readBigInt64BE(offset), bytesRead: 8 };
}

function encodeBigint(value, desc) {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(value), 0);
  return b;
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

/**
 * Type handler registry keyed by the masked SQL type code.
 * Key = Math.abs(sqlType) & 0xFFFE
 */
export const numericTypes = {
  500: { name: 'SMALLINT', decode: decodeSmallint, encode: encodeSmallint },
  496: { name: 'INTEGER', decode: decodeInteger, encode: encodeInteger },
  492: { name: 'BIGINT', decode: decodeBigint, encode: encodeBigint },
  480: { name: 'FLOAT', decode: decodeFloat, encode: encodeFloat },
  484: { name: 'DECIMAL', decode: decodeDecimal, encode: encodeDecimal },
  488: { name: 'NUMERIC', decode: decodeNumeric, encode: encodeNumeric },
  996: { name: 'DECFLOAT', decode: decodeDecFloat, encode: encodeDecFloat },
};
