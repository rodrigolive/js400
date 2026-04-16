/**
 * String SQL type handlers.
 *
 * Upstream: SQLChar*.java, SQLVarchar*.java, SQLGraphic.java,
 *           SQLVargraphic.java, SQLNChar.java, SQLNVarchar.java
 * @module db/types/string
 */

import { CharConverter } from '../../ccsid/CharConverter.js';

function decodeUtf16BE(buf, offset, length) {
  const chars = [];
  for (let i = 0; i + 1 < length; i += 2) {
    chars.push(String.fromCharCode(buf.readUInt16BE(offset + i)));
  }
  return chars.join('');
}

function encodeUtf16BE(str) {
  const b = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    b.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  return b;
}

function decodeString(buf, offset, length, ccsid) {
  if (ccsid === 1208) return buf.toString('utf8', offset, offset + length);
  if (ccsid === 13488 || ccsid === 1200 || ccsid === 61952) {
    return decodeUtf16BE(buf, offset, length);
  }
  if (ccsid === 65535) return buf.subarray(offset, offset + length);
  try {
    return CharConverter.byteArrayToString(buf, offset, length, ccsid || 37);
  } catch {
    return buf.toString('latin1', offset, offset + length);
  }
}

function encodeString(str, length, ccsid) {
  if (ccsid === 1208) {
    const b = Buffer.alloc(length);
    const written = b.write(str, 0, length, 'utf8');
    if (written < length) b.fill(0x20, written);
    return b;
  }
  if (ccsid === 13488 || ccsid === 1200 || ccsid === 61952) {
    const textBuf = encodeUtf16BE(str);
    const b = Buffer.alloc(length);
    textBuf.copy(b, 0, 0, Math.min(textBuf.length, length));
    if (textBuf.length < length) {
      for (let i = textBuf.length; i + 1 < length; i += 2) {
        b.writeUInt16BE(0x0020, i);
      }
    }
    return b;
  }
  try {
    const encoded = CharConverter.stringToByteArray(str, ccsid || 37);
    const b = Buffer.alloc(length, 0x40); // EBCDIC space padding
    encoded.copy(b, 0, 0, Math.min(encoded.length, length));
    return b;
  } catch {
    const b = Buffer.alloc(length, 0x40);
    Buffer.from(str, 'latin1').copy(b, 0, 0, Math.min(str.length, length));
    return b;
  }
}

/**
 * Zero-copy CHAR encoder.
 * Writes str directly into `buf` at `offset`, padded to `fieldLen`
 * bytes. Pad byte is 0x40 for EBCDIC, 0x20 for UTF-8/UTF-16.
 */
function encodeCharInto(value, buf, offset, fieldLen, desc, serverCCSID) {
  const ccsid = desc.ccsid || serverCCSID;
  const str = String(value ?? '');
  const maxLen = desc.length;

  if (ccsid === 1208) {
    const written = buf.write(str, offset, maxLen, 'utf8');
    if (written < maxLen) buf.fill(0x20, offset + written, offset + maxLen);
    return maxLen;
  }
  if (ccsid === 1200 || ccsid === 13488 || ccsid === 61952) {
    const maxChars = maxLen >> 1;
    const n = str.length < maxChars ? str.length : maxChars;
    for (let i = 0; i < n; i++) {
      const code = str.charCodeAt(i);
      buf[offset + i * 2] = (code >> 8) & 0xFF;
      buf[offset + i * 2 + 1] = code & 0xFF;
    }
    // Pad remainder with 0x0020 (UTF-16 space)
    const padStart = offset + n * 2;
    const padEnd = offset + maxLen;
    for (let i = padStart; i + 1 < padEnd; i += 2) {
      buf[i] = 0x00;
      buf[i + 1] = 0x20;
    }
    return maxLen;
  }
  // Single-byte EBCDIC (or other single-byte CCSID)
  try {
    const written = CharConverter.stringToByteArrayInto(str, buf, offset, maxLen, ccsid || 37);
    if (written < maxLen) buf.fill(0x40, offset + written, offset + maxLen);
    return maxLen;
  } catch {
    // Fallback: latin1 byte copy, EBCDIC space padding
    const n = str.length < maxLen ? str.length : maxLen;
    for (let i = 0; i < n; i++) buf[offset + i] = str.charCodeAt(i) & 0xFF;
    if (n < maxLen) buf.fill(0x40, offset + n, offset + maxLen);
    return maxLen;
  }
}

/**
 * Zero-copy VARCHAR encoder.
 * Writes 2-byte length prefix + data into `buf` at `offset`. Pads the
 * slot tail with zeros up to `fieldLen`. Per JTOpen SQLVarcharBase the
 * wire format is: [ui16 actualLen][data...][zero-pad to descriptor max].
 */
function encodeVarcharInto(value, buf, offset, fieldLen, desc, serverCCSID) {
  const ccsid = desc.ccsid || serverCCSID;
  const str = String(value ?? '');
  const maxLen = desc.length;
  let actualLen;

  if (ccsid === 1208) {
    actualLen = buf.write(str, offset + 2, maxLen, 'utf8');
  } else if (ccsid === 1200 || ccsid === 13488 || ccsid === 61952) {
    const maxChars = maxLen >> 1;
    const n = str.length < maxChars ? str.length : maxChars;
    for (let i = 0; i < n; i++) {
      const code = str.charCodeAt(i);
      buf[offset + 2 + i * 2] = (code >> 8) & 0xFF;
      buf[offset + 2 + i * 2 + 1] = code & 0xFF;
    }
    actualLen = n * 2;
  } else {
    try {
      actualLen = CharConverter.stringToByteArrayInto(str, buf, offset + 2, maxLen, ccsid || 37);
    } catch {
      const n = str.length < maxLen ? str.length : maxLen;
      for (let i = 0; i < n; i++) buf[offset + 2 + i] = str.charCodeAt(i) & 0xFF;
      actualLen = n;
    }
  }

  buf[offset] = (actualLen >> 8) & 0xFF;
  buf[offset + 1] = actualLen & 0xFF;

  // Zero-pad tail to descriptor max. JTOpen SQLVarcharBase always
  // pads — even a few bytes — to avoid leaking uninitialized bytes
  // from the request buffer. We allocUnsafe the request body, so we
  // MUST clear the tail here.
  const padStart = offset + 2 + actualLen;
  const padEnd = offset + fieldLen;
  if (padEnd > padStart) {
    buf.fill(0, padStart, padEnd);
  }
  return fieldLen;
}

function encodeVargraphicInto(value, buf, offset, fieldLen, desc, serverCCSID) {
  const ccsid = desc.ccsid || 13488;
  const str = String(value ?? '');
  const maxLen = desc.length;
  const maxChars = maxLen >> 1;
  const n = str.length < maxChars ? str.length : maxChars;
  for (let i = 0; i < n; i++) {
    const code = str.charCodeAt(i);
    buf[offset + 2 + i * 2] = (code >> 8) & 0xFF;
    buf[offset + 2 + i * 2 + 1] = code & 0xFF;
  }
  const actualLen = n * 2;
  buf[offset] = (actualLen >> 8) & 0xFF;
  buf[offset + 1] = actualLen & 0xFF;
  const padStart = offset + 2 + actualLen;
  const padEnd = offset + fieldLen;
  if (padEnd > padStart) {
    buf.fill(0, padStart, padEnd);
  }
  return fieldLen;
}

function encodeGraphicInto(value, buf, offset, fieldLen, desc, serverCCSID) {
  const ccsid = desc.ccsid || 13488;
  const str = String(value ?? '');
  const maxLen = desc.length;
  const maxChars = maxLen >> 1;
  const n = str.length < maxChars ? str.length : maxChars;
  for (let i = 0; i < n; i++) {
    const code = str.charCodeAt(i);
    buf[offset + i * 2] = (code >> 8) & 0xFF;
    buf[offset + i * 2 + 1] = code & 0xFF;
  }
  const padStart = offset + n * 2;
  const padEnd = offset + maxLen;
  for (let i = padStart; i + 1 < padEnd; i += 2) {
    buf[i] = 0x00;
    buf[i + 1] = 0x20;
  }
  return maxLen;
}

// CHAR — fixed-length character
function decodeChar(buf, offset, desc, serverCCSID) {
  const ccsid = desc.ccsid || serverCCSID;
  const str = decodeString(buf, offset, desc.length, ccsid);
  return { value: typeof str === 'string' ? str.trimEnd() : str, bytesRead: desc.length };
}

function encodeChar(value, desc, serverCCSID) {
  const ccsid = desc.ccsid || serverCCSID;
  return encodeString(String(value ?? ''), desc.length, ccsid);
}

// VARCHAR — 2-byte length prefix + character data
function decodeVarchar(buf, offset, desc, serverCCSID) {
  const dataLen = buf.readUInt16BE(offset);
  const ccsid = desc.ccsid || serverCCSID;
  const str = decodeString(buf, offset + 2, dataLen, ccsid);
  return { value: typeof str === 'string' ? str : str, bytesRead: 2 + desc.length };
}

function encodeVarchar(value, desc, serverCCSID) {
  const ccsid = desc.ccsid || serverCCSID;
  const str = String(value ?? '');
  let encoded;
  if (ccsid === 1208) {
    encoded = Buffer.from(str, 'utf8');
  } else if (ccsid === 13488 || ccsid === 1200 || ccsid === 61952) {
    encoded = encodeUtf16BE(str);
  } else {
    try {
      encoded = Buffer.from(CharConverter.stringToByteArray(str, ccsid || 37));
    } catch {
      encoded = Buffer.from(str, 'latin1');
    }
  }
  const maxLen = desc.length;
  const actualLen = Math.min(encoded.length, maxLen);
  const b = Buffer.alloc(2 + actualLen);
  b.writeUInt16BE(actualLen, 0);
  encoded.copy(b, 2, 0, actualLen);
  return b;
}

// GRAPHIC — fixed-length double-byte (always UTF-16BE or DBCS)
function decodeGraphic(buf, offset, desc, serverCCSID) {
  const ccsid = desc.ccsid || 13488;
  const str = decodeString(buf, offset, desc.length, ccsid);
  return { value: typeof str === 'string' ? str.trimEnd() : str, bytesRead: desc.length };
}

function encodeGraphic(value, desc, serverCCSID) {
  const ccsid = desc.ccsid || 13488;
  return encodeString(String(value ?? ''), desc.length, ccsid);
}

// VARGRAPHIC — 2-byte length prefix + double-byte data
function decodeVargraphic(buf, offset, desc, serverCCSID) {
  const dataLen = buf.readUInt16BE(offset);
  const ccsid = desc.ccsid || 13488;
  const str = decodeString(buf, offset + 2, dataLen, ccsid);
  return { value: typeof str === 'string' ? str : str, bytesRead: 2 + desc.length };
}

function encodeVargraphic(value, desc, serverCCSID) {
  const ccsid = desc.ccsid || 13488;
  const str = String(value ?? '');
  const encoded = encodeUtf16BE(str);
  const maxLen = desc.length;
  const actualLen = Math.min(encoded.length, maxLen);
  const b = Buffer.alloc(2 + actualLen);
  b.writeUInt16BE(actualLen, 0);
  encoded.copy(b, 2, 0, actualLen);
  return b;
}

// LONGVARCHAR — same format as VARCHAR
function decodeLongVarchar(buf, offset, desc, serverCCSID) {
  return decodeVarchar(buf, offset, desc, serverCCSID);
}

// LONGGRAPHIC — same format as VARGRAPHIC
function decodeLongGraphic(buf, offset, desc, serverCCSID) {
  return decodeVargraphic(buf, offset, desc, serverCCSID);
}

export const stringTypes = {
  452: { name: 'CHAR', decode: decodeChar, encode: encodeChar, encodeInto: encodeCharInto },
  448: { name: 'VARCHAR', decode: decodeVarchar, encode: encodeVarchar, encodeInto: encodeVarcharInto },
  456: { name: 'LONGVARCHAR', decode: decodeLongVarchar, encode: encodeVarchar, encodeInto: encodeVarcharInto },
  468: { name: 'GRAPHIC', decode: decodeGraphic, encode: encodeGraphic, encodeInto: encodeGraphicInto },
  464: { name: 'VARGRAPHIC', decode: decodeVargraphic, encode: encodeVargraphic, encodeInto: encodeVargraphicInto },
  472: { name: 'LONGGRAPHIC', decode: decodeLongGraphic, encode: encodeVargraphic, encodeInto: encodeVargraphicInto },
};
