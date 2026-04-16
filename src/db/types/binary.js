/**
 * Binary SQL type handlers.
 *
 * Upstream: SQLBinary.java, SQLVarbinary.java, SQLLongVarbinary.java
 * @module db/types/binary
 */

function decodeBinary(buf, offset, desc) {
  const data = Buffer.alloc(desc.length);
  buf.copy(data, 0, offset, offset + desc.length);
  return { value: data, bytesRead: desc.length };
}

function encodeBinary(value, desc) {
  const b = Buffer.alloc(desc.length);
  if (Buffer.isBuffer(value)) {
    value.copy(b, 0, 0, Math.min(value.length, desc.length));
  } else if (typeof value === 'string') {
    Buffer.from(value, 'hex').copy(b, 0, 0, Math.min(value.length / 2, desc.length));
  }
  return b;
}

function decodeVarbinary(buf, offset, desc) {
  const dataLen = buf.readUInt16BE(offset);
  const data = Buffer.alloc(dataLen);
  buf.copy(data, 0, offset + 2, offset + 2 + dataLen);
  return { value: data, bytesRead: 2 + desc.length };
}

function encodeVarbinary(value, desc) {
  let data;
  if (Buffer.isBuffer(value)) {
    data = value;
  } else if (typeof value === 'string') {
    data = Buffer.from(value, 'hex');
  } else {
    data = Buffer.alloc(0);
  }
  const maxLen = desc.length;
  const actualLen = Math.min(data.length, maxLen);
  const b = Buffer.alloc(2 + actualLen);
  b.writeUInt16BE(actualLen, 0);
  data.copy(b, 2, 0, actualLen);
  return b;
}

export const binaryTypes = {
  912: { name: 'BINARY', decode: decodeBinary, encode: encodeBinary },
  908: { name: 'VARBINARY', decode: decodeVarbinary, encode: encodeVarbinary },
};
