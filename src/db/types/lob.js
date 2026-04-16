/**
 * LOB and XML SQL type handlers.
 *
 * LOB types come in two forms on the wire:
 * - Inline data (small LOBs sent directly in the row)
 * - Locator handles (4-byte server-side references for large LOBs)
 *
 * Upstream: SQLBlob*.java, SQLClob*.java, SQLDBClob*.java, SQLXML*.java
 * @module db/types/lob
 */

// BLOB — inline binary LOB (2-byte length prefix + data)
function decodeBlob(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const data = Buffer.alloc(dataLen);
  buf.copy(data, 0, offset + 2, offset + 2 + dataLen);
  return { value: data, bytesRead: 2 + desc.length };
}

function encodeBlob(value, desc) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  const maxLen = desc.length;
  const actualLen = Math.min(data.length, maxLen);
  const b = Buffer.alloc(2 + actualLen);
  b.writeUInt16BE(actualLen, 0);
  data.copy(b, 2, 0, actualLen);
  return b;
}

// BLOB_LOCATOR — 4-byte locator handle
function decodeBlobLocator(buf, offset, desc) {
  const handle = buf.readInt32BE(offset);
  return { value: { locator: handle, type: 'blob' }, bytesRead: 4 };
}

function encodeBlobLocator(value, desc) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value?.locator ?? 0, 0);
  return b;
}

// CLOB — inline character LOB (2-byte length prefix + character data)
function decodeClob(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const str = buf.toString('utf8', offset + 2, offset + 2 + dataLen);
  return { value: str, bytesRead: 2 + desc.length };
}

function encodeClob(value, desc) {
  const str = String(value ?? '');
  const encoded = Buffer.from(str, 'utf8');
  const maxLen = desc.length;
  const actualLen = Math.min(encoded.length, maxLen);
  const b = Buffer.alloc(2 + actualLen);
  b.writeUInt16BE(actualLen, 0);
  encoded.copy(b, 2, 0, actualLen);
  return b;
}

// CLOB_LOCATOR — 4-byte locator handle
function decodeClobLocator(buf, offset, desc) {
  const handle = buf.readInt32BE(offset);
  return { value: { locator: handle, type: 'clob' }, bytesRead: 4 };
}

function encodeClobLocator(value, desc) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value?.locator ?? 0, 0);
  return b;
}

// DBCLOB — inline double-byte character LOB
function decodeDbclob(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const chars = [];
  for (let i = 0; i + 1 < dataLen; i += 2) {
    chars.push(String.fromCharCode(buf.readUInt16BE(offset + 2 + i)));
  }
  return { value: chars.join(''), bytesRead: 2 + desc.length };
}

function encodeDbclob(value, desc) {
  const str = String(value ?? '');
  const maxLen = desc.length;
  const actualLen = Math.min(str.length * 2, maxLen);
  const b = Buffer.alloc(2 + actualLen);
  b.writeUInt16BE(actualLen, 0);
  for (let i = 0; i < str.length && i * 2 < actualLen; i++) {
    b.writeUInt16BE(str.charCodeAt(i), 2 + i * 2);
  }
  return b;
}

// DBCLOB_LOCATOR — 4-byte locator handle
function decodeDblcobLocator(buf, offset, desc) {
  const handle = buf.readInt32BE(offset);
  return { value: { locator: handle, type: 'dbclob' }, bytesRead: 4 };
}

function encodeDblcobLocator(value, desc) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value?.locator ?? 0, 0);
  return b;
}

export const lobTypes = {
  404: { name: 'BLOB', decode: decodeBlob, encode: encodeBlob },
  960: { name: 'BLOB_LOCATOR', decode: decodeBlobLocator, encode: encodeBlobLocator },
  408: { name: 'CLOB', decode: decodeClob, encode: encodeClob },
  964: { name: 'CLOB_LOCATOR', decode: decodeClobLocator, encode: encodeClobLocator },
  412: { name: 'DBCLOB', decode: decodeDbclob, encode: encodeDbclob },
  968: { name: 'DBCLOB_LOCATOR', decode: decodeDblcobLocator, encode: encodeDblcobLocator },
};
