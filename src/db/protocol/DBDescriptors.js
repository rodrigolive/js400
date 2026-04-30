/**
 * Column descriptor and parameter descriptor parsing.
 *
 * Parses the descriptor data returned by the database server for
 * result set columns and parameter markers. Used by describe, prepare,
 * and open operations.
 *
 * Upstream: DBSQLDescriptorDS.java, DBExtendedColumnDescriptors.java
 * @module db/protocol/DBDescriptors
 */

import { CharConverter } from '../../ccsid/CharConverter.js';

/**
 * SQL type constants as they appear in descriptor data from the server.
 * Values from JTOpen SQLData implementations and IBM i host server protocol.
 */
export const SqlType = Object.freeze({
  BLOB:            404,
  BLOB_LOCATOR:    960,
  CLOB:            408,
  CLOB_LOCATOR:    964,
  DBCLOB:          412,
  DBCLOB_LOCATOR:  968,
  NCLOB:           -0x01F4,
  NCLOB_LOCATOR:   -0x01F8,
  XML:             -370,
  XML_LOCATOR:     -0x0172,
  DATE:            384,
  TIME:            388,
  TIMESTAMP:       392,
  BINARY:          912,
  VARBINARY:       908,
  LONGVARBINARY:   404,
  CHAR:            452,
  VARCHAR:         448,
  LONGVARCHAR:     456,
  CHAR_FOR_BIT:    452,
  VARCHAR_FOR_BIT: 448,
  GRAPHIC:         468,
  VARGRAPHIC:      464,
  LONGGRAPHIC:     472,
  NCHAR:           -0x01E8,
  NVARCHAR:        -0x01E4,
  LONGNVARCHAR:    -0x01EC,
  SMALLINT:        500,
  INTEGER:         496,
  BIGINT:          492,
  FLOAT:           480,
  DOUBLE:          480,
  REAL:            480,
  DECIMAL:         484,
  NUMERIC:         488,
  DECFLOAT:        996,
  BOOLEAN:         -0x01FC,
  ROWID:           904,
  DATALINK:        396,
  ARRAY:           -0x01FD,
  ARRAY_LOCATOR:   -0x01FE,
});

/**
 * Fixed-length header for each column/parameter descriptor.
 * Each descriptor in the standard format occupies at least this many bytes.
 */
const SHORT_DESCRIPTOR_LENGTH = 16;

/**
 * Extended descriptor fixed part per column.
 * The extended descriptors carry more metadata.
 */
const EXTENDED_FIXED_LENGTH = 52;

/**
 * Parse standard column descriptors from a data buffer.
 *
 * Standard descriptor layout per column (16 bytes):
 *   0-1:   SQL type (int16)
 *   2-5:   Length (int32)
 *   6-7:   Scale (int16)
 *   8-9:   Precision (int16)
 *   10-11: CCSID (uint16)
 *   12-13: Join reference column (uint16)
 *   14-15: Flags (uint16)
 *
 * @param {Buffer} buf
 * @param {number} columnCount
 * @param {number} [offset=0]
 * @returns {ColumnDescriptor[]}
 */
export function parseColumnDescriptors(buf, columnCount, offset = 0) {
  const descriptors = [];
  let pos = offset;

  for (let i = 0; i < columnCount; i++) {
    if (pos + SHORT_DESCRIPTOR_LENGTH > buf.length) break;

    const sqlType = buf.readInt16BE(pos);
    const length = buf.readInt32BE(pos + 2);
    const scale = buf.readInt16BE(pos + 6);
    const precision = buf.readInt16BE(pos + 8);
    const ccsid = buf.readUInt16BE(pos + 10);
    const joinRef = buf.readUInt16BE(pos + 12);
    const flags = buf.readUInt16BE(pos + 14);

    descriptors.push({
      index: i,
      sqlType,
      length,
      scale,
      precision,
      ccsid,
      joinRef,
      flags,
      nullable: (flags & 0x01) !== 0,
      name: '',
      label: '',
      tableName: '',
      schemaName: '',
      baseColumnName: '',
      typeName: sqlTypeToName(sqlType),
    });

    pos += SHORT_DESCRIPTOR_LENGTH;
  }

  return descriptors;
}

/**
 * Parse extended column descriptors from code point data.
 *
 * Extended descriptor layout per column (52 bytes fixed + variable):
 *   0-1:    SQL type (int16)
 *   2-5:    Length (int32)
 *   6-7:    Scale (int16)
 *   8-9:    Precision (int16)
 *   10-11:  CCSID (uint16)
 *   12-13:  Join reference (uint16)
 *   14-15:  Flags (uint16)
 *   16-19:  Label CCSID (int32)
 *   20-23:  Label length (int32)
 *   24-27:  Name CCSID (int32)
 *   28-31:  Name length (int32)
 *   32-35:  Base column name CCSID (int32)
 *   36-39:  Base column name length (int32)
 *   40-43:  Table name CCSID (int32)
 *   44-47:  Table name length (int32)
 *   48-51:  Schema name CCSID (int32)
 *
 * After the fixed parts for all columns, variable-length data follows
 * in column order: label, name, base-column-name, table-name for each column.
 *
 * @param {Buffer} buf
 * @param {number} columnCount
 * @param {number} [offset=0]
 * @returns {ColumnDescriptor[]}
 */
export function parseExtendedColumnDescriptors(buf, columnCount, offset = 0) {
  const descriptors = [];
  const fixedEnd = offset + columnCount * EXTENDED_FIXED_LENGTH;

  // First pass: read fixed parts
  let pos = offset;
  const fixedParts = [];
  for (let i = 0; i < columnCount; i++) {
    if (pos + EXTENDED_FIXED_LENGTH > buf.length) break;

    fixedParts.push({
      sqlType: buf.readInt16BE(pos),
      length: buf.readInt32BE(pos + 2),
      scale: buf.readInt16BE(pos + 6),
      precision: buf.readInt16BE(pos + 8),
      ccsid: buf.readUInt16BE(pos + 10),
      joinRef: buf.readUInt16BE(pos + 12),
      flags: buf.readUInt16BE(pos + 14),
      labelCcsid: buf.readInt32BE(pos + 16),
      labelLen: buf.readInt32BE(pos + 20),
      nameCcsid: buf.readInt32BE(pos + 24),
      nameLen: buf.readInt32BE(pos + 28),
      baseColNameCcsid: buf.readInt32BE(pos + 32),
      baseColNameLen: buf.readInt32BE(pos + 36),
      tableNameCcsid: buf.readInt32BE(pos + 40),
      tableNameLen: buf.readInt32BE(pos + 44),
      schemaNameCcsid: buf.readInt32BE(pos + 48),
    });

    pos += EXTENDED_FIXED_LENGTH;
  }

  // Second pass: read variable-length strings
  let varPos = fixedEnd;
  for (let i = 0; i < fixedParts.length; i++) {
    const fp = fixedParts[i];

    const label = readVarString(buf, varPos, fp.labelLen, fp.labelCcsid);
    varPos += fp.labelLen;

    const name = readVarString(buf, varPos, fp.nameLen, fp.nameCcsid);
    varPos += fp.nameLen;

    const baseColumnName = readVarString(buf, varPos, fp.baseColNameLen, fp.baseColNameCcsid);
    varPos += fp.baseColNameLen;

    const tableName = readVarString(buf, varPos, fp.tableNameLen, fp.tableNameCcsid);
    varPos += fp.tableNameLen;

    // Schema name length is not in the fixed part, so we look for a trailing field
    // For simplicity, schema name is often not present in the variable area
    const schemaName = '';

    descriptors.push({
      index: i,
      sqlType: fp.sqlType,
      length: fp.length,
      scale: fp.scale,
      precision: fp.precision,
      ccsid: fp.ccsid,
      joinRef: fp.joinRef,
      flags: fp.flags,
      nullable: (fp.flags & 0x01) !== 0,
      name: name.trim(),
      label: label.trim(),
      tableName: tableName.trim(),
      schemaName: schemaName.trim(),
      baseColumnName: baseColumnName.trim(),
      typeName: sqlTypeToName(fp.sqlType),
    });
  }

  return descriptors;
}

/**
 * Parse parameter marker descriptors (same layout as column descriptors).
 * @param {Buffer} buf
 * @param {number} paramCount
 * @param {number} [offset=0]
 * @returns {ColumnDescriptor[]}
 */
export function parseParameterDescriptors(buf, paramCount, offset = 0) {
  return parseColumnDescriptors(buf, paramCount, offset);
}

/**
 * Read a variable-length string from a buffer.
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} length
 * @param {number} ccsid
 * @returns {string}
 */
function readVarString(buf, offset, length, ccsid) {
  if (length <= 0 || offset + length > buf.length) return '';

  const sub = buf.subarray(offset, offset + length);
  if (ccsid === 13488 || ccsid === 1200) {
    return decodeUtf16BE(sub);
  }
  if (ccsid === 1208) {
    return sub.toString('utf8');
  }
  try {
    return CharConverter.byteArrayToString(sub, 0, length, ccsid);
  } catch {
    return sub.toString('latin1');
  }
}

/**
 * Decode UTF-16BE buffer to JS string.
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeUtf16BE(buf) {
  const chars = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    chars.push(String.fromCharCode(buf.readUInt16BE(i)));
  }
  return chars.join('');
}

/**
 * Map SQL type code to a human-readable name.
 * @param {number} sqlType
 * @returns {string}
 */
export function sqlTypeToName(sqlType) {
  const absType = Math.abs(sqlType) & 0xFFFE;
  switch (absType) {
    case 492: return 'BIGINT';
    case 496: return 'INTEGER';
    case 500: return 'SMALLINT';
    case 484: return 'DECIMAL';
    case 488: return 'NUMERIC';
    case 480: return 'FLOAT';
    case 996: return 'DECFLOAT';
    case 452: return 'CHAR';
    case 448: return 'VARCHAR';
    case 456: return 'LONGVARCHAR';
    case 468: return 'GRAPHIC';
    case 464: return 'VARGRAPHIC';
    case 472: return 'LONGGRAPHIC';
    case 384: return 'DATE';
    case 388: return 'TIME';
    case 392: return 'TIMESTAMP';
    case 912: return 'BINARY';
    case 908: return 'VARBINARY';
    case 404: return 'BLOB';
    case 408: return 'CLOB';
    case 412: return 'DBCLOB';
    case 960: return 'BLOB_LOCATOR';
    case 964: return 'CLOB_LOCATOR';
    case 968: return 'DBCLOB_LOCATOR';
    case 904: return 'ROWID';
    case 396: return 'DATALINK';
    default: return 'UNKNOWN';
  }
}

/**
 * Calculate the byte length for a row based on column descriptors.
 * @param {ColumnDescriptor[]} descriptors
 * @returns {number}
 */
export function calculateRowLength(descriptors) {
  let total = 0;
  for (const desc of descriptors) {
    total += getColumnByteLength(desc);
    if (desc.nullable) total += 2;
  }
  return total;
}

/**
 * Get the byte length of a single column value on the wire.
 * @param {ColumnDescriptor} desc
 * @returns {number}
 */
export function getColumnByteLength(desc) {
  const absType = Math.abs(desc.sqlType) & 0xFFFE;
  switch (absType) {
    case 500: return 2;                  // SMALLINT
    case 496: return 4;                  // INTEGER
    case 492: return 8;                  // BIGINT
    case 480:                            // FLOAT/DOUBLE/REAL
      return desc.length === 4 ? 4 : 8;
    case 484:                            // DECIMAL (packed)
    case 488:                            // NUMERIC (zoned)
      return desc.length;
    case 996: return desc.length;        // DECFLOAT
    case 384: return desc.length;        // DATE
    case 388: return desc.length;        // TIME
    case 392: return desc.length;        // TIMESTAMP
    case 452:                            // CHAR
    case 468:                            // GRAPHIC
      return desc.length;
    case 448:                            // VARCHAR
    case 464:                            // VARGRAPHIC
    case 456:                            // LONGVARCHAR
    case 472:                            // LONGGRAPHIC
      return 2 + desc.length;           // 2-byte length prefix + data
    case 912: return desc.length;        // BINARY
    case 908: return 2 + desc.length;    // VARBINARY
    case 960:                            // BLOB_LOCATOR
    case 964:                            // CLOB_LOCATOR
    case 968:                            // DBCLOB_LOCATOR
      return 4;                          // locator handle
    default: return desc.length || 0;
  }
}

/**
 * Parse the basic data format (reply code point 0x3805 or 0x3808).
 *
 * Layout confirmed from wire dumps against a live IBM i host:
 *   Header (8 bytes):
 *     0-3:  consistencyToken (int32)
 *     4-5:  numFields (int16)
 *     6-7:  recordSize (int16) — total row data bytes (no indicators)
 *
 *   Per field (fieldLL bytes, typically 54):
 *     0-1:   fieldLL (int16) — total descriptor size for this field
 *     2-3:   sqlType (int16) — SQL type code (odd = nullable)
 *     4-5:   fieldLength (int16) — wire byte length (includes 2-byte len prefix for VARCHAR)
 *     6-7:   precision (int16) — character/digit precision
 *     8-9:   scale (int16)
 *     10-11: ccsid (uint16) — data CCSID (e.g. 37 for EBCDIC)
 *     12:    dateTimeFormat (byte)
 *     13:    flags1 (byte)
 *     14-15: flags2 (int16)
 *     16-17: reserved (2 bytes)
 *     18-19: reserved (2 bytes)
 *     20-21: nameLength (int16) — field name length in bytes
 *     22-23: nameCCSID (uint16) — CCSID of the field name
 *     24+:   name (nameLength bytes, encoded in nameCCSID)
 *     24+nameLen to fieldLL: zero padding
 *
 * @param {Buffer} buf — raw code point data (after LL/CP prefix)
 * @returns {{ descriptors: ColumnDescriptor[], recordSize: number }}
 */
export function parseBasicDataFormat(buf) {
  if (!buf || buf.length < 8) {
    return { descriptors: [], recordSize: 0 };
  }

  const numFields = buf.readInt16BE(4);
  const recordSize = buf.readInt16BE(6);

  const descriptors = [];
  let pos = 8; // skip header

  for (let i = 0; i < numFields; i++) {
    if (pos + 24 > buf.length) break;

    const fieldLL = buf.readInt16BE(pos);
    if (fieldLL < 24 || pos + fieldLL > buf.length) break;

    const sqlType = buf.readInt16BE(pos + 2);
    const length = buf.readInt16BE(pos + 4);
    // Basic data format (both reply 0x3805 and request 0x3801):
    // byte 6 = scale, byte 8 = precision
    const scale = buf.readInt16BE(pos + 6);
    const precision = buf.readInt16BE(pos + 8);
    const ccsid = buf.readUInt16BE(pos + 10);
    const nameLength = buf.readInt16BE(pos + 20);
    const nameCCSID = buf.readUInt16BE(pos + 22);

    let name = '';
    if (nameLength > 0 && pos + 24 + nameLength <= buf.length) {
      const nameBytes = buf.subarray(pos + 24, pos + 24 + nameLength);
      name = readVarString(nameBytes, 0, nameLength, nameCCSID);
    }

    // Normalize length for variable-length types: the basic format's fieldLength
    // includes the 2-byte length prefix (e.g. VARCHAR(128) has fieldLength=130),
    // but decoders/encoders expect desc.length = data-only bytes (128).
    const absType = Math.abs(sqlType) & 0xFFFE;
    const isVarLen = absType === 448 || absType === 464 || absType === 456
                  || absType === 472 || absType === 908;
    const normalizedLength = isVarLen && length >= 2 ? length - 2 : length;

    descriptors.push({
      index: i,
      sqlType,
      length: normalizedLength,
      rawFieldLength: length,  // wire-level length (includes 2-byte prefix for VARCHAR)
      scale,
      precision,
      ccsid,
      joinRef: 0,
      flags: 0,
      nullable: (sqlType & 1) !== 0,
      name: name.trim(),
      label: name.trim(),
      tableName: '',
      schemaName: '',
      baseColumnName: name.trim(),
      typeName: sqlTypeToName(sqlType),
    });

    pos += fieldLL;
  }

  return { descriptors, recordSize };
}

/**
 * Parse super extended data format (reply code point 0x3812).
 *
 * Header (16 bytes):
 *   0-3:   consistencyToken (int32)
 *   4-7:   numFields (int32)
 *   8:     dateFormat (byte)
 *   9:     timeFormat (byte)
 *   10:    dateSeparator (byte)
 *   11:    timeSeparator (byte)
 *   12-15: recordSize (int32)
 *
 * Per field (48 bytes):
 *   0-1:   fieldLL (int16)
 *   2-3:   sqlType (int16)
 *   4-7:   fieldLength (int32)
 *   8-9:   scale (int16)
 *   10-11: precision (int16)
 *   12-13: ccsid (uint16)
 *   14:    reserved (byte)
 *   15-16: joinRef (int16)
 *   17-20: reserved (int32)
 *   21:    attributeBitmap (byte)
 *   22-25: reserved (int32)
 *   26-29: lobMaxSize (int32)
 *   30-31: reserved (int16)
 *   32-35: offsetToVarLen (int32)
 *   36-39: lengthOfVarLen (int32)
 *   40-43: reserved (int32)
 *   44-47: reserved (int32)
 *
 * Variable length field info (per field):
 *   4 bytes: LL
 *   2 bytes: CP (0x3840=name, 0x3841=UDT name)
 *   2 bytes: CCSID
 *   N bytes: name in EBCDIC
 *
 * @param {Buffer} buf
 * @returns {{ descriptors: ColumnDescriptor[], recordSize: number }}
 */
export function parseSuperExtendedDataFormat(buf) {
  if (!buf || buf.length < 16) {
    return { descriptors: [], recordSize: 0 };
  }

  const numFields = buf.readInt32BE(4);
  const recordSize = buf.readInt32BE(12);
  const descriptors = [];

  // Parse fixed parts (48 bytes each)
  const fixedParts = [];
  for (let i = 0; i < numFields; i++) {
    const off = 16 + i * 48;
    if (off + 48 > buf.length) break;

    fixedParts.push({
      sqlType: buf.readInt16BE(off + 2),
      length: buf.readInt32BE(off + 4),
      scale: buf.readInt16BE(off + 8),
      precision: buf.readInt16BE(off + 10),
      ccsid: buf.readUInt16BE(off + 12),
      joinRef: buf.readInt16BE(off + 15),
      offsetToVarLen: buf.readInt32BE(off + 32),
      lengthOfVarLen: buf.readInt32BE(off + 36),
    });
  }

  // Parse variable-length names
  for (let i = 0; i < fixedParts.length; i++) {
    const fp = fixedParts[i];
    let name = '';

    if (fp.lengthOfVarLen > 0) {
      // offsetToVarLen is relative to the start of THIS field's fixed
      // data (at 16 + i*48), NOT the buffer header. See JTOpen
      // DBSuperExtendedDataFormat.java findCodePoint / getFieldName:
      //   offset_ + 16 + offsetToVarLen + (fieldIndex * REPEATED_FIXED_LENGTH_)
      const actualOff = 16 + (i * 48) + fp.offsetToVarLen;
      if (actualOff + 8 <= buf.length) {
        const varFieldLL = buf.readInt32BE(actualOff);
        const varFieldCCSID = buf.readUInt16BE(actualOff + 6);
        const nameLen = varFieldLL - 8;
        if (nameLen > 0 && actualOff + 8 + nameLen <= buf.length) {
          name = readVarString(buf, actualOff + 8, nameLen, varFieldCCSID || 37);
        }
      }
    }

    // Normalize length for variable-length types: the super-extended
    // format's fieldLength includes the 2-byte length prefix (same as
    // the basic format), but decoders expect desc.length = data-only
    // bytes. JTOpen SQLDataFactory.newData always subtracts 2 for
    // VARCHAR/VARGRAPHIC/LONGVARCHAR/LONGGRAPHIC/VARBINARY.
    const absType = Math.abs(fp.sqlType) & 0xFFFE;
    const isVarLen = absType === 448 || absType === 464 || absType === 456
                  || absType === 472 || absType === 908;
    const normalizedLength = isVarLen && fp.length >= 2 ? fp.length - 2 : fp.length;

    descriptors.push({
      index: i,
      sqlType: fp.sqlType,
      length: normalizedLength,
      rawFieldLength: fp.length,
      scale: fp.scale,
      precision: fp.precision,
      ccsid: fp.ccsid,
      joinRef: fp.joinRef,
      flags: 0,
      nullable: (fp.sqlType & 1) !== 0,
      name: name.trim(),
      label: name.trim(),
      tableName: '',
      schemaName: '',
      baseColumnName: name.trim(),
      typeName: sqlTypeToName(fp.sqlType),
    });
  }

  return { descriptors, recordSize };
}

export class DBDescriptors {
  static parseColumnDescriptors = parseColumnDescriptors;
  static parseExtendedColumnDescriptors = parseExtendedColumnDescriptors;
  static parseParameterDescriptors = parseParameterDescriptors;
  static parseBasicDataFormat = parseBasicDataFormat;
  static parseSuperExtendedDataFormat = parseSuperExtendedDataFormat;
  static sqlTypeToName = sqlTypeToName;
  static calculateRowLength = calculateRowLength;
  static getColumnByteLength = getColumnByteLength;
  static SqlType = SqlType;
  static SHORT_DESCRIPTOR_LENGTH = SHORT_DESCRIPTOR_LENGTH;
  static EXTENDED_FIXED_LENGTH = EXTENDED_FIXED_LENGTH;
}
