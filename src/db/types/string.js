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
  452: { name: 'CHAR', decode: decodeChar, encode: encodeChar },
  448: { name: 'VARCHAR', decode: decodeVarchar, encode: encodeVarchar },
  456: { name: 'LONGVARCHAR', decode: decodeLongVarchar, encode: encodeVarchar },
  468: { name: 'GRAPHIC', decode: decodeGraphic, encode: encodeGraphic },
  464: { name: 'VARGRAPHIC', decode: decodeVargraphic, encode: encodeVargraphic },
  472: { name: 'LONGGRAPHIC', decode: decodeLongGraphic, encode: encodeVargraphic },
};
