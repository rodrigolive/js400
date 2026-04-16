/**
 * Date/time SQL type handlers.
 *
 * Upstream: SQLDate.java, SQLTime.java, SQLTimestamp.java, SQLTimestamp2.java
 * @module db/types/datetime
 */

import { CharConverter } from '../../ccsid/CharConverter.js';

function decodeString(buf, offset, length, ccsid) {
  if (ccsid === 1208) return buf.toString('utf8', offset, offset + length);
  if (ccsid === 13488 || ccsid === 1200) {
    const chars = [];
    for (let i = 0; i + 1 < length; i += 2) {
      chars.push(String.fromCharCode(buf.readUInt16BE(offset + i)));
    }
    return chars.join('');
  }
  try {
    return CharConverter.byteArrayToString(buf, offset, length, ccsid || 37);
  } catch {
    return buf.toString('latin1', offset, offset + length);
  }
}

function decodeDate(buf, offset, desc, serverCCSID) {
  const ccsid = desc.ccsid || serverCCSID;
  const str = decodeString(buf, offset, desc.length, ccsid).trim();
  return { value: str, bytesRead: desc.length };
}

function encodeDate(value, desc, serverCCSID) {
  const str = String(value ?? '');
  const ccsid = desc.ccsid || serverCCSID;
  if (ccsid === 13488 || ccsid === 1200) {
    const b = Buffer.alloc(desc.length);
    for (let i = 0; i < str.length && i * 2 < desc.length; i++) {
      b.writeUInt16BE(str.charCodeAt(i), i * 2);
    }
    return b;
  }
  try {
    const encoded = CharConverter.stringToByteArray(str, ccsid || 37);
    const b = Buffer.alloc(desc.length, 0x40);
    encoded.copy(b, 0, 0, Math.min(encoded.length, desc.length));
    return b;
  } catch {
    const b = Buffer.alloc(desc.length, 0x40);
    Buffer.from(str, 'latin1').copy(b);
    return b;
  }
}

function decodeTime(buf, offset, desc, serverCCSID) {
  const ccsid = desc.ccsid || serverCCSID;
  const str = decodeString(buf, offset, desc.length, ccsid).trim();
  return { value: str, bytesRead: desc.length };
}

function encodeTime(value, desc, serverCCSID) {
  return encodeDate(value, desc, serverCCSID);
}

function decodeTimestamp(buf, offset, desc, serverCCSID) {
  const ccsid = desc.ccsid || serverCCSID;
  const str = decodeString(buf, offset, desc.length, ccsid).trim();
  return { value: str, bytesRead: desc.length };
}

function encodeTimestamp(value, desc, serverCCSID) {
  return encodeDate(value, desc, serverCCSID);
}

export const datetimeTypes = {
  384: { name: 'DATE', decode: decodeDate, encode: encodeDate },
  388: { name: 'TIME', decode: decodeTime, encode: encodeTime },
  392: { name: 'TIMESTAMP', decode: decodeTimestamp, encode: encodeTimestamp },
};
