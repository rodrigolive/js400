/**
 * Special SQL type handlers.
 *
 * Upstream: SQLRowID.java, SQLDataLink.java, SQLBoolean.java, SQLArray*.java
 * @module db/types/special
 */

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

// BOOLEAN — 1 byte (0 = false, 1 = true)
function decodeBoolean(buf, offset, desc) {
  return { value: buf[offset] !== 0, bytesRead: 1 };
}

function encodeBoolean(value, desc) {
  return Buffer.from([value ? 1 : 0]);
}

export const specialTypes = {
  904: { name: 'ROWID', decode: decodeRowId, encode: encodeRowId },
  396: { name: 'DATALINK', decode: decodeDataLink, encode: encodeDataLink },
};
