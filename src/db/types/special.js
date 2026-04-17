/**
 * Special / extended SQL type handlers.
 *
 * Includes ROWID, DATALINK, BOOLEAN, NCHAR, NVARCHAR, LONGNVARCHAR, NCLOB,
 * XML, ARRAY — the types registered against negative (extended) SqlType
 * codes. The negative codes are used directly as the registration key so
 * the factory's `Math.abs(sqlType) & 0xFFFE` mask-out-the-nullable-bit
 * lookup still resolves them correctly (we register both positive-abs and
 * negative keys).
 *
 * Upstream: SQLRowID.java, SQLDataLink.java, SQLBoolean.java,
 *           SQLNChar.java, SQLNVarchar.java, SQLNClob.java, SQLXML*.java,
 *           SQLArray*.java
 * @module db/types/special
 */

import { SqlType } from '../protocol/DBDescriptors.js';

// ROWID — fixed-length row identifier
function decodeRowId(buf, offset, desc) {
  const data = Buffer.alloc(desc.length);
  buf.copy(data, 0, offset, offset + desc.length);
  return { value: data, bytesRead: desc.length };
}

function encodeRowId(value, desc) {
  const b = Buffer.alloc(desc.length);
  if (Buffer.isBuffer(value)) {
    value.copy(b, 0, 0, Math.min(value.length, desc.length));
  }
  return b;
}

// DATALINK — variable-length URL stored as VARCHAR-like
function decodeDataLink(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const str = buf.toString('utf8', offset + 2, offset + 2 + dataLen);
  return { value: str, bytesRead: 2 + desc.length };
}

function encodeDataLink(value, desc) {
  const str = String(value ?? '');
  const encoded = Buffer.from(str, 'utf8');
  const maxLen = desc.length;
  const actualLen = Math.min(encoded.length, maxLen);
  const b = Buffer.alloc(2 + maxLen);
  b.writeUInt16BE(actualLen, 0);
  encoded.copy(b, 2, 0, actualLen);
  return b;
}

// BOOLEAN — 1 byte (0 = false, non-zero = true)
function decodeBoolean(buf, offset, _desc) {
  return { value: buf[offset] !== 0, bytesRead: 1 };
}

function encodeBoolean(value, _desc) {
  return Buffer.from([value ? 1 : 0]);
}

function encodeBooleanInto(value, buf, offset, fieldLen, _desc, _ccsid) {
  buf[offset] = value ? 1 : 0;
  if (fieldLen > 1) buf.fill(0, offset + 1, offset + fieldLen);
  return fieldLen || 1;
}

// NCHAR / NVARCHAR / LONGNVARCHAR — UTF-16BE (ccsid 1200 / 13488)
function decodeNChar(buf, offset, desc) {
  const len = desc.length;
  const chars = [];
  for (let i = 0; i + 1 < len; i += 2) {
    chars.push(String.fromCharCode(buf.readUInt16BE(offset + i)));
  }
  return { value: chars.join('').replace(/\u0000+$/, '').trimEnd(), bytesRead: len };
}

function encodeNChar(value, desc) {
  const str = String(value ?? '');
  const maxLen = desc.length;
  const b = Buffer.alloc(maxLen);
  const maxChars = maxLen >> 1;
  const n = Math.min(str.length, maxChars);
  for (let i = 0; i < n; i++) b.writeUInt16BE(str.charCodeAt(i), i * 2);
  for (let i = n; i < maxChars; i++) b.writeUInt16BE(0x0020, i * 2);
  return b;
}

function encodeNCharInto(value, buf, offset, fieldLen, desc, _ccsid) {
  const maxLen = desc.length;
  const str = String(value ?? '');
  const maxChars = maxLen >> 1;
  const n = Math.min(str.length, maxChars);
  for (let i = 0; i < n; i++) buf.writeUInt16BE(str.charCodeAt(i), offset + i * 2);
  for (let i = n; i < maxChars; i++) buf.writeUInt16BE(0x0020, offset + i * 2);
  if (fieldLen > maxLen) buf.fill(0, offset + maxLen, offset + fieldLen);
  return fieldLen || maxLen;
}

function decodeNVarchar(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const chars = [];
  for (let i = 0; i + 1 < dataLen; i += 2) {
    chars.push(String.fromCharCode(buf.readUInt16BE(offset + 2 + i)));
  }
  return { value: chars.join(''), bytesRead: 2 + desc.length };
}

function encodeNVarchar(value, desc) {
  const str = String(value ?? '');
  const maxLen = desc.length;
  const actualLen = Math.min(str.length * 2, maxLen);
  const b = Buffer.alloc(2 + maxLen);
  b.writeUInt16BE(actualLen, 0);
  for (let i = 0; i * 2 < actualLen; i++) b.writeUInt16BE(str.charCodeAt(i), 2 + i * 2);
  return b;
}

function encodeNVarcharInto(value, buf, offset, fieldLen, desc, _ccsid) {
  const str = String(value ?? '');
  const maxLen = desc.length;
  const actualLen = Math.min(str.length * 2, maxLen);
  buf.writeUInt16BE(actualLen, offset);
  for (let i = 0; i * 2 < actualLen; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), offset + 2 + i * 2);
  }
  const padStart = offset + 2 + actualLen;
  const padEnd = offset + fieldLen;
  if (padEnd > padStart) buf.fill(0, padStart, padEnd);
  return fieldLen;
}

// NCLOB — inline double-byte character LOB (2-byte length prefix)
function decodeNClob(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const chars = [];
  for (let i = 0; i + 1 < dataLen; i += 2) {
    chars.push(String.fromCharCode(buf.readUInt16BE(offset + 2 + i)));
  }
  return { value: chars.join(''), bytesRead: 2 + desc.length };
}

function encodeNClob(value, desc) {
  return encodeNVarchar(value, desc);
}

// NCLOB_LOCATOR — 4-byte locator handle
function decodeNClobLocator(buf, offset, _desc) {
  const handle = buf.readInt32BE(offset);
  return { value: { locator: handle, type: 'nclob' }, bytesRead: 4 };
}

function encodeNClobLocator(value, _desc) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value?.locator ?? 0, 0);
  return b;
}

// XML — inline XML text (2-byte length prefix + UTF-8)
function decodeXml(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const str = buf.toString('utf8', offset + 2, offset + 2 + dataLen);
  return { value: str, bytesRead: 2 + desc.length };
}

function encodeXml(value, desc) {
  const str = String(value ?? '');
  const encoded = Buffer.from(str, 'utf8');
  const maxLen = desc.length;
  const actualLen = Math.min(encoded.length, maxLen);
  const b = Buffer.alloc(2 + maxLen);
  b.writeUInt16BE(actualLen, 0);
  encoded.copy(b, 2, 0, actualLen);
  return b;
}

// XML_LOCATOR — 4-byte locator handle
function decodeXmlLocator(buf, offset, _desc) {
  const handle = buf.readInt32BE(offset);
  return { value: { locator: handle, type: 'xml' }, bytesRead: 4 };
}

function encodeXmlLocator(value, _desc) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value?.locator ?? 0, 0);
  return b;
}

// ARRAY — JSON-encoded for now. Real format is locator + type descriptor.
function decodeArray(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const str = buf.toString('utf8', offset + 2, offset + 2 + dataLen);
  let parsed;
  try { parsed = JSON.parse(str); } catch { parsed = str; }
  return { value: parsed, bytesRead: 2 + desc.length };
}

function encodeArray(value, desc) {
  const payload = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '[]');
  const encoded = Buffer.from(payload, 'utf8');
  const maxLen = desc.length;
  const actualLen = Math.min(encoded.length, maxLen);
  const b = Buffer.alloc(2 + maxLen);
  b.writeUInt16BE(actualLen, 0);
  encoded.copy(b, 2, 0, actualLen);
  return b;
}

function decodeArrayLocator(buf, offset, _desc) {
  const handle = buf.readInt32BE(offset);
  return { value: { locator: handle, type: 'array' }, bytesRead: 4 };
}

function encodeArrayLocator(value, _desc) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value?.locator ?? 0, 0);
  return b;
}

// Extended (driver-internal) types use NEGATIVE SqlType codes (XML=-370,
// NVARCHAR=-0x01E4, etc.). Registering them under `Math.abs(sqlType) & 0xFFFE`
// collides catastrophically with regular positive types:
//
//   DECIMAL(484)      <-> NVARCHAR(-0x01E4, abs=484)
//   NUMERIC(488)      <-> NCHAR(-0x01E8, abs=488)
//   BIGINT(492)       <-> LONGNVARCHAR(-0x01EC, abs=492)
//   SMALLINT(500)     <-> NCLOB(-0x01F4, abs=500)
//   BOOLEAN(-0x01FC)  <-> ARRAY(-0x01FD, abs=508 after masking LSB)
//
// To avoid those collisions we key extended types by their signed-masked
// value (i.e. preserve the negative sign). Regular server descriptor
// lookups always use the positive path and the factory looks up the
// signed key first, then falls back to the positive key.
function extendedKey(code) {
  return code < 0
    ? -(Math.abs(code) & 0xFFFE)
    : code & 0xFFFE;
}

const BOOLEAN_KEY      = extendedKey(SqlType.BOOLEAN);
const XML_KEY          = extendedKey(SqlType.XML);
const XML_LOC_KEY      = extendedKey(SqlType.XML_LOCATOR);
const NCHAR_KEY        = extendedKey(SqlType.NCHAR);
const NVARCHAR_KEY     = extendedKey(SqlType.NVARCHAR);
const LONGNVARCHAR_KEY = extendedKey(SqlType.LONGNVARCHAR);
const NCLOB_KEY        = extendedKey(SqlType.NCLOB);
const NCLOB_LOC_KEY    = extendedKey(SqlType.NCLOB_LOCATOR);
const ARRAY_KEY        = extendedKey(SqlType.ARRAY);
const ARRAY_LOC_KEY    = extendedKey(SqlType.ARRAY_LOCATOR);

export const specialTypes = {
  904: { name: 'ROWID', decode: decodeRowId, encode: encodeRowId },
  396: { name: 'DATALINK', decode: decodeDataLink, encode: encodeDataLink },

  [BOOLEAN_KEY]:      { name: 'BOOLEAN',      decode: decodeBoolean,      encode: encodeBoolean,   encodeInto: encodeBooleanInto },
  [XML_KEY]:          { name: 'XML',          decode: decodeXml,          encode: encodeXml },
  [XML_LOC_KEY]:      { name: 'XML_LOCATOR',  decode: decodeXmlLocator,   encode: encodeXmlLocator },
  [NCHAR_KEY]:        { name: 'NCHAR',        decode: decodeNChar,        encode: encodeNChar,     encodeInto: encodeNCharInto },
  [NVARCHAR_KEY]:     { name: 'NVARCHAR',     decode: decodeNVarchar,     encode: encodeNVarchar,  encodeInto: encodeNVarcharInto },
  [LONGNVARCHAR_KEY]: { name: 'LONGNVARCHAR', decode: decodeNVarchar,     encode: encodeNVarchar,  encodeInto: encodeNVarcharInto },
  [NCLOB_KEY]:        { name: 'NCLOB',        decode: decodeNClob,        encode: encodeNClob },
  [NCLOB_LOC_KEY]:    { name: 'NCLOB_LOCATOR',decode: decodeNClobLocator, encode: encodeNClobLocator },
  [ARRAY_KEY]:        { name: 'ARRAY',        decode: decodeArray,        encode: encodeArray },
  [ARRAY_LOC_KEY]:    { name: 'ARRAY_LOCATOR',decode: decodeArrayLocator, encode: encodeArrayLocator },
};
