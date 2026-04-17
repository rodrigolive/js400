/**
 * SQL type factory — maps server descriptor type codes to decoder/encoder functions.
 *
 * Upstream: SQLDataFactory.java, SQLNativeType.java
 * @module db/types/factory
 */

import { numericTypes } from './numeric.js';
import { stringTypes } from './string.js';
import { binaryTypes } from './binary.js';
import { datetimeTypes } from './datetime.js';
import { lobTypes } from './lob.js';
import { specialTypes } from './special.js';

const allTypes = new Map();

function registerAll(typeMap) {
  for (const [key, handler] of Object.entries(typeMap)) {
    allTypes.set(Number(key), handler);
  }
}

registerAll(numericTypes);
registerAll(stringTypes);
registerAll(binaryTypes);
registerAll(datetimeTypes);
registerAll(lobTypes);
registerAll(specialTypes);

/**
 * Look up a type handler by SQL type code.
 *
 * Positive codes (server descriptor values like DECIMAL=484) are matched
 * by `sqlType & 0xFFFE` (low bit masks the nullable indicator).
 *
 * Negative codes (driver-internal extended types like NVARCHAR=-0x01E4,
 * XML=-370, BOOLEAN=-0x01FC) are matched by their SIGNED masked value so
 * they don't collide with positive numeric types that share the same
 * absolute value (e.g. DECIMAL(484) vs NVARCHAR(-484)).
 *
 * @param {number} sqlType
 * @returns {{ decode: Function, encode: Function, name: string } | null}
 */
export function getTypeHandler(sqlType) {
  if (sqlType < 0) {
    const signedKey = -(Math.abs(sqlType) & 0xFFFE);
    return allTypes.get(signedKey) ?? null;
  }
  return allTypes.get(sqlType & 0xFFFE) ?? null;
}

/**
 * Decode a column value from a row data buffer.
 *
 * @param {Buffer} buf - row data buffer
 * @param {number} offset - byte offset to start reading
 * @param {object} descriptor - column descriptor from DBDescriptors
 * @param {number} [serverCCSID=37]
 * @returns {{ value: any, bytesRead: number }}
 */
export function decodeValue(buf, offset, descriptor, serverCCSID = 37) {
  const handler = getTypeHandler(descriptor.sqlType);
  if (!handler) {
    return { value: null, bytesRead: descriptor.length || 0 };
  }
  return handler.decode(buf, offset, descriptor, serverCCSID);
}

/**
 * Encode a JS value into a buffer for a parameter marker.
 *
 * @param {any} value - JS value to encode
 * @param {object} descriptor - parameter descriptor
 * @param {number} [serverCCSID=37]
 * @returns {Buffer}
 */
export function encodeValue(value, descriptor, serverCCSID = 37) {
  const handler = getTypeHandler(descriptor.sqlType);
  if (!handler) {
    throw new Error(`No encoder for SQL type ${descriptor.sqlType}`);
  }
  return handler.encode(value, descriptor, serverCCSID);
}

/**
 * Encode a JS value directly into a destination buffer at `offset`.
 *
 * This is the zero-copy hot path used by executeBatch: the caller
 * pre-allocates the entire DBOriginalData body, then each field is
 * written in place. Types that don't implement encodeInto fall back
 * to `encodeValue + copy`.
 *
 * @param {any} value
 * @param {Buffer} buf - destination buffer
 * @param {number} offset - byte offset in `buf` where the field starts
 * @param {number} fieldLen - total bytes reserved for the field (including
 *                            VARCHAR length prefix, and any fixed-width pad)
 * @param {object} descriptor - parameter descriptor
 * @param {number} [serverCCSID=37]
 * @returns {number} bytes written (always fieldLen for fixed-width and
 *                   VARCHAR-family slots)
 */
export function encodeValueInto(value, buf, offset, fieldLen, descriptor, serverCCSID = 37) {
  const handler = getTypeHandler(descriptor.sqlType);
  if (!handler) {
    throw new Error(`No encoder for SQL type ${descriptor.sqlType}`);
  }
  if (handler.encodeInto) {
    return handler.encodeInto(value, buf, offset, fieldLen, descriptor, serverCCSID);
  }
  const encoded = handler.encode(value, descriptor, serverCCSID);
  const n = Math.min(encoded.length, fieldLen);
  encoded.copy(buf, offset, 0, n);
  if (n < fieldLen) buf.fill(0, offset + n, offset + fieldLen);
  return fieldLen;
}

/**
 * Decode an entire row from a buffer given column descriptors.
 *
 * @param {Buffer} buf - row data
 * @param {number} startOffset
 * @param {object[]} descriptors - column descriptors array
 * @param {number} [serverCCSID=37]
 * @returns {{ row: object, bytesRead: number }}
 */
export function decodeRow(buf, startOffset, descriptors, serverCCSID = 37) {
  const row = {};
  let offset = startOffset;

  for (const desc of descriptors) {
    // Check null indicator (2 bytes) for nullable columns
    if (desc.nullable) {
      if (offset + 2 > buf.length) break;
      const nullInd = buf.readInt16BE(offset);
      offset += 2;
      if (nullInd === -1) {
        row[desc.name || `col${desc.index}`] = null;
        // Skip past the data bytes
        const handler = getTypeHandler(desc.sqlType);
        if (handler) {
          const skip = handler.decode(buf, offset, desc, serverCCSID);
          offset += skip.bytesRead;
        }
        continue;
      }
    }

    const { value, bytesRead } = decodeValue(buf, offset, desc, serverCCSID);
    row[desc.name || `col${desc.index}`] = value;
    offset += bytesRead;
  }

  return { row, bytesRead: offset - startOffset };
}

/**
 * Decode multiple rows from a buffer.
 *
 * @param {Buffer} buf
 * @param {number} startOffset
 * @param {object[]} descriptors
 * @param {number} rowCount
 * @param {number} [serverCCSID=37]
 * @returns {object[]}
 */
export function decodeRows(buf, startOffset, descriptors, rowCount, serverCCSID = 37) {
  const rows = [];
  let offset = startOffset;

  for (let i = 0; i < rowCount; i++) {
    if (offset >= buf.length) break;
    const { row, bytesRead } = decodeRow(buf, offset, descriptors, serverCCSID);
    rows.push(row);
    offset += bytesRead;
  }

  return rows;
}

/**
 * Decode result data from a 0x380E or 0x3806 code point buffer.
 *
 * Two header formats exist depending on datastream level:
 *
 *   DS level >= 1 (CP 0x380E) — 20-byte header:
 *     0-3:   consistencyToken (int32)
 *     4-7:   rowCount (int32)
 *     8-9:   columnCount (int16)
 *     10-11: indicatorSize (int16, typically 2)
 *     12-15: reserved (int32)
 *     16-19: rowSize (int32, data bytes per row, NO indicators)
 *
 *   DS level 0 (CP 0x3806) — 14-byte header:
 *     0-3:   consistencyToken (int32)
 *     4-7:   rowCount (int32)
 *     8-9:   columnCount (int16)
 *     10-11: indicatorSize (int16, typically 2)
 *     12-13: rowSize (int16, data bytes per row, NO indicators)
 *
 *   Indicators block: rowCount * columnCount * indicatorSize bytes
 *   Data block:       rowCount * rowSize bytes
 *
 * Indicators are SEPARATE from row data (not interleaved).
 * An indicator value of -1 means null.
 *
 * @param {Buffer} buf - raw result data code point data (after LL/CP)
 * @param {object[]} descriptors - column descriptors from prepare
 * @param {number} [serverCCSID=37]
 * @returns {object[]}
 */
export function decodeResultData(buf, descriptors, serverCCSID = 37) {
  if (!buf || buf.length < 14) return [];

  const rowCount = buf.readInt32BE(4);
  const columnCount = buf.readInt16BE(8);
  const indicatorSize = buf.readInt16BE(10);

  // Detect header format by validating against the total buffer size.
  // 14-byte header (DS level 0, CP 0x3806): rowSize at offset 12 as int16
  // 20-byte header (DS level >= 1, CP 0x380E): rowSize at offset 16 as int32
  // The correct format is the one where header + indicators + data == bufLen.
  let headerSize;
  let rowSize;
  const indBlock = rowCount * columnCount * indicatorSize;
  const rowSize14 = buf.readUInt16BE(12);
  const expected14 = 14 + indBlock + rowCount * rowSize14;
  if (expected14 === buf.length && rowSize14 > 0) {
    headerSize = 14;
    rowSize = rowSize14;
  } else if (buf.length >= 20) {
    const rowSize20 = buf.readInt32BE(16);
    const expected20 = 20 + indBlock + rowCount * rowSize20;
    if (expected20 === buf.length && rowSize20 > 0) {
      headerSize = 20;
      rowSize = rowSize20;
    } else {
      // Fallback: use whichever header size yields a valid layout
      headerSize = 14;
      rowSize = rowSize14;
    }
  } else {
    headerSize = 14;
    rowSize = rowSize14;
  }

  if (rowCount <= 0 || columnCount <= 0 || rowSize <= 0) return [];
  const indicatorBlockSize = rowCount * columnCount * indicatorSize;
  const indicatorStart = headerSize;
  const dataStart = headerSize + indicatorBlockSize;

  const rows = [];
  const descCount = Math.min(columnCount, descriptors.length);

  // Pre-resolve column offsets, names, handlers once — avoid per-row Map
  // lookups and property fallbacks across 8000+ rows.
  const colOffsets = new Array(descCount);
  const colNames = new Array(descCount);
  const colHandlers = new Array(descCount);
  let off = 0;
  for (let c = 0; c < descCount; c++) {
    const desc = descriptors[c];
    colOffsets[c] = off;
    colNames[c] = desc.name || `col${desc.index}`;
    colHandlers[c] = getTypeHandler(desc.sqlType);
    const absType = Math.abs(desc.sqlType) & 0xFFFE;
    switch (absType) {
      case 500: off += 2; break;  // SMALLINT
      case 496: off += 4; break;  // INTEGER
      case 492: off += 8; break;  // BIGINT
      case 480: off += (desc.length === 4 ? 4 : 8); break; // FLOAT
      case 452: case 468: off += desc.length; break; // CHAR/GRAPHIC
      case 448: case 464: case 456: case 472: off += 2 + desc.length; break; // VARCHAR etc
      case 484: case 488: off += desc.length; break; // DECIMAL/NUMERIC
      case 912: off += desc.length; break; // BINARY
      case 908: off += 2 + desc.length; break; // VARBINARY
      case 384: case 388: case 392: off += desc.length; break; // DATE/TIME/TIMESTAMP
      case 996: off += desc.length; break; // DECFLOAT
      default: off += desc.length || 0; break;
    }
  }

  const canIndicator = indicatorSize === 2;

  for (let r = 0; r < rowCount; r++) {
    const rowDataOffset = dataStart + r * rowSize;
    if (rowDataOffset + rowSize > buf.length) break;

    const row = {};
    const indRowBase = indicatorStart + r * columnCount * indicatorSize;
    for (let c = 0; c < descCount; c++) {
      const name = colNames[c];
      const handler = colHandlers[c];

      // Read indicator
      let isNull = false;
      if (canIndicator) {
        const indOffset = indRowBase + c * indicatorSize;
        if (indOffset + 2 <= buf.length) {
          isNull = buf.readInt16BE(indOffset) === -1;
        }
      }

      if (isNull) {
        row[name] = null;
      } else if (handler) {
        const valOffset = rowDataOffset + colOffsets[c];
        row[name] = handler.decode(buf, valOffset, descriptors[c], serverCCSID).value;
      } else {
        row[name] = null;
      }
    }

    rows.push(row);
  }

  return rows;
}

export class SqlTypeFactory {
  static getTypeHandler = getTypeHandler;
  static decodeValue = decodeValue;
  static encodeValue = encodeValue;
  static decodeRow = decodeRow;
  static decodeRows = decodeRows;
  static decodeResultData = decodeResultData;
}
