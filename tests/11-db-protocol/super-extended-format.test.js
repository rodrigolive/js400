/**
 * Tests for parseSuperExtendedDataFormat (code point 0x3812).
 *
 * Validates that the variable-length field name offset calculation
 * correctly uses per-field offsets (relative to each field's fixed
 * data start), matching JTOpen DBSuperExtendedDataFormat.java.
 *
 * Regression test for: column names garbled after the first column
 * because offsetToVarLen was treated as buffer-absolute instead of
 * field-relative.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseSuperExtendedDataFormat,
  parseBasicDataFormat,
} from '../../src/db/protocol/DBDescriptors.js';

/**
 * Build a super extended data format buffer (code point 0x3812 payload).
 *
 * Layout per JTOpen DBSuperExtendedDataFormat.java:
 *   Header (16 bytes):
 *     0-3:   consistencyToken
 *     4-7:   numFields (int32)
 *     8-11:  reserved / date-time format
 *     12-15: recordSize (int32)
 *
 *   Per field fixed part (48 bytes):
 *     0-1:   fieldLL
 *     2-3:   sqlType
 *     4-7:   fieldLength (int32)
 *     8-9:   scale
 *     10-11: precision
 *     12-13: ccsid
 *     14:    reserved
 *     15-16: joinRef
 *     17-20: reserved
 *     21:    attributeBitmap
 *     22-25: reserved
 *     26-29: lobMaxSize
 *     30-31: reserved
 *     32-35: offsetToVarLen (relative to THIS field's fixed start)
 *     36-39: lengthOfVarLen
 *     40-47: reserved
 *
 *   Variable-length data per field:
 *     LL(4) + CP(2, 0x3840) + CCSID(2) + name bytes
 *
 * @param {{ sqlType: number, length: number, ccsid: number, name: string }[]} fields
 * @param {number} [recordSize=0]
 * @returns {Buffer}
 */
function buildSuperExtendedBuffer(fields, recordSize = 0) {
  const numFields = fields.length;
  const HEADER = 16;
  const FIXED_PER_FIELD = 48;

  // Encode field names as UTF-8 (CCSID 1208)
  const nameBuffers = fields.map(f => Buffer.from(f.name, 'utf8'));

  // Variable-length entries: LL(4) + CP(2) + CCSID(2) + name
  const varEntries = nameBuffers.map(nb => {
    const entry = Buffer.alloc(8 + nb.length);
    entry.writeInt32BE(8 + nb.length, 0);   // LL
    entry.writeUInt16BE(0x3840, 4);          // CP = field name
    entry.writeUInt16BE(1208, 6);            // CCSID = UTF-8
    nb.copy(entry, 8);
    return entry;
  });

  // Compute offsets: offsetToVarLen is relative to start of each
  // field's fixed data (at HEADER + i * FIXED_PER_FIELD)
  const varDataStart = HEADER + numFields * FIXED_PER_FIELD;
  let varPos = varDataStart;
  const offsets = [];
  for (let i = 0; i < numFields; i++) {
    const fieldFixedStart = HEADER + i * FIXED_PER_FIELD;
    offsets.push(varPos - fieldFixedStart);
    varPos += varEntries[i].length;
  }

  const totalSize = varPos;
  const buf = Buffer.alloc(totalSize);

  // Header
  buf.writeInt32BE(0x01020304, 0);          // consistencyToken
  buf.writeInt32BE(numFields, 4);           // numFields
  buf.writeInt32BE(recordSize, 12);         // recordSize

  // Fixed parts
  for (let i = 0; i < numFields; i++) {
    const off = HEADER + i * FIXED_PER_FIELD;
    const f = fields[i];
    buf.writeInt16BE(FIXED_PER_FIELD, off);        // fieldLL
    buf.writeInt16BE(f.sqlType, off + 2);           // sqlType
    buf.writeInt32BE(f.length, off + 4);            // fieldLength
    buf.writeInt16BE(f.scale || 0, off + 8);        // scale
    buf.writeInt16BE(f.precision || 0, off + 10);   // precision
    buf.writeUInt16BE(f.ccsid || 0, off + 12);      // ccsid
    buf.writeInt32BE(offsets[i], off + 32);          // offsetToVarLen
    buf.writeInt32BE(varEntries[i].length, off + 36); // lengthOfVarLen
  }

  // Variable-length data
  let writePos = varDataStart;
  for (const entry of varEntries) {
    entry.copy(buf, writePos);
    writePos += entry.length;
  }

  return buf;
}

describe('parseSuperExtendedDataFormat', () => {
  test('parses single column name correctly', () => {
    const buf = buildSuperExtendedBuffer([
      { sqlType: 496, length: 4, ccsid: 0, name: 'MYID' },
    ], 4);

    const result = parseSuperExtendedDataFormat(buf);
    expect(result.descriptors.length).toBe(1);
    expect(result.descriptors[0].name).toBe('MYID');
    expect(result.descriptors[0].sqlType).toBe(496);
    expect(result.descriptors[0].typeName).toBe('INTEGER');
  });

  test('parses all column names in multi-column result', () => {
    const buf = buildSuperExtendedBuffer([
      { sqlType: 496, length: 4, ccsid: 0, name: 'ORDER_ID' },
      { sqlType: 449, length: 102, ccsid: 37, name: 'CUST_NAME' },
      { sqlType: 500, length: 2, ccsid: 0, name: 'STATUS' },
      { sqlType: 385, length: 10, ccsid: 0, name: 'SHIP_DATE' },
    ], 118);

    const result = parseSuperExtendedDataFormat(buf);
    expect(result.descriptors.length).toBe(4);
    expect(result.descriptors[0].name).toBe('ORDER_ID');
    expect(result.descriptors[1].name).toBe('CUST_NAME');
    expect(result.descriptors[2].name).toBe('STATUS');
    expect(result.descriptors[3].name).toBe('SHIP_DATE');
  });

  test('column names survive with varying name lengths', () => {
    const buf = buildSuperExtendedBuffer([
      { sqlType: 496, length: 4, ccsid: 0, name: 'A' },
      { sqlType: 496, length: 4, ccsid: 0, name: 'MEDIUM_NAME' },
      { sqlType: 496, length: 4, ccsid: 0, name: 'A_VERY_LONG_COLUMN_NAME_HERE' },
      { sqlType: 496, length: 4, ccsid: 0, name: 'X' },
    ]);

    const result = parseSuperExtendedDataFormat(buf);
    expect(result.descriptors.length).toBe(4);
    expect(result.descriptors[0].name).toBe('A');
    expect(result.descriptors[1].name).toBe('MEDIUM_NAME');
    expect(result.descriptors[2].name).toBe('A_VERY_LONG_COLUMN_NAME_HERE');
    expect(result.descriptors[3].name).toBe('X');
  });

  test('preserves SQL type metadata for all columns', () => {
    const buf = buildSuperExtendedBuffer([
      { sqlType: 496, length: 4, ccsid: 0, name: 'INT_COL', precision: 10 },
      { sqlType: 449, length: 130, ccsid: 37, name: 'VARCHAR_COL' },
      { sqlType: 484, length: 8, ccsid: 0, name: 'DEC_COL', scale: 2, precision: 15 },
      { sqlType: 500, length: 2, ccsid: 0, name: 'SMALL_COL', precision: 5 },
      { sqlType: 492, length: 8, ccsid: 0, name: 'BIG_COL', precision: 19 },
    ]);

    const result = parseSuperExtendedDataFormat(buf);
    expect(result.descriptors.length).toBe(5);

    expect(result.descriptors[0].typeName).toBe('INTEGER');
    expect(result.descriptors[0].name).toBe('INT_COL');

    expect(result.descriptors[1].typeName).toBe('VARCHAR');
    expect(result.descriptors[1].name).toBe('VARCHAR_COL');
    expect(result.descriptors[1].nullable).toBe(true);

    expect(result.descriptors[2].typeName).toBe('DECIMAL');
    expect(result.descriptors[2].name).toBe('DEC_COL');
    expect(result.descriptors[2].scale).toBe(2);

    expect(result.descriptors[3].typeName).toBe('SMALLINT');
    expect(result.descriptors[3].name).toBe('SMALL_COL');

    expect(result.descriptors[4].typeName).toBe('BIGINT');
    expect(result.descriptors[4].name).toBe('BIG_COL');
  });

  test('returns empty on short buffer', () => {
    const buf = Buffer.alloc(8);
    const result = parseSuperExtendedDataFormat(buf);
    expect(result.descriptors.length).toBe(0);
  });

  test('returns empty on null buffer', () => {
    const result = parseSuperExtendedDataFormat(null);
    expect(result.descriptors.length).toBe(0);
  });

  test('normalizes VARCHAR length (subtracts 2-byte prefix)', () => {
    const buf = buildSuperExtendedBuffer([
      { sqlType: 448, length: 130, ccsid: 37, name: 'VC_COL' },
    ]);

    const result = parseSuperExtendedDataFormat(buf);
    // 130 on wire includes 2-byte length prefix → normalized to 128
    expect(result.descriptors[0].length).toBe(128);
    expect(result.descriptors[0].rawFieldLength).toBe(130);
  });
});

describe('parseBasicDataFormat multi-column names', () => {
  /**
   * Build a basic data format buffer (code point 0x3805 payload).
   *
   * Layout per JTOpen DBOriginalDataFormat.java (REPEATED_LENGTH_ = 54):
   *   Header (8 bytes):
   *     0-3:  consistencyToken
   *     4-5:  numFields (int16)
   *     6-7:  recordSize (int16)
   *
   *   Per field (24 header + 30 name = 54 bytes):
   *     0-1:   fieldLL (int16) = 54
   *     2-3:   sqlType (int16)
   *     4-5:   fieldLength (int16)
   *     6-7:   scale (int16)
   *     8-9:   precision (int16)
   *     10-11: ccsid (uint16)
   *     12:    dateTimeFormat
   *     13:    flags1
   *     14-15: flags2 (int16)
   *     16-17: reserved
   *     18-19: reserved
   *     20-21: nameLength (int16)
   *     22-23: nameCCSID (uint16)
   *     24+:   name (padded to 30 bytes)
   */
  function buildBasicBuffer(fields, recordSize = 0) {
    const HEADER = 8;
    const FIELD_SIZE = 54; // JTOpen DBOriginalDataFormat REPEATED_LENGTH_ = 54

    const buf = Buffer.alloc(HEADER + fields.length * FIELD_SIZE);

    // Header
    buf.writeInt32BE(1, 0);                         // consistencyToken
    buf.writeInt16BE(fields.length, 4);             // numFields
    buf.writeInt16BE(recordSize, 6);                // recordSize

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const off = HEADER + i * FIELD_SIZE;
      const nameBytes = Buffer.from(f.name, 'utf8');

      buf.writeInt16BE(FIELD_SIZE, off);              // fieldLL
      buf.writeInt16BE(f.sqlType, off + 2);           // sqlType
      buf.writeInt16BE(f.length, off + 4);            // fieldLength
      buf.writeInt16BE(f.scale || 0, off + 6);        // scale
      buf.writeInt16BE(f.precision || 0, off + 8);    // precision
      buf.writeUInt16BE(f.ccsid || 0, off + 10);      // ccsid
      buf.writeInt16BE(nameBytes.length, off + 20);   // nameLength
      buf.writeUInt16BE(1208, off + 22);              // nameCCSID = UTF-8
      nameBytes.copy(buf, off + 24, 0, Math.min(nameBytes.length, 30));
    }

    return buf;
  }

  test('parses all column names in multi-column result', () => {
    const buf = buildBasicBuffer([
      { sqlType: 496, length: 4, name: 'ORDER_ID' },
      { sqlType: 449, length: 102, ccsid: 37, name: 'CUST_NAME' },
      { sqlType: 500, length: 2, name: 'STATUS' },
    ], 108);

    const result = parseBasicDataFormat(buf);
    expect(result.descriptors.length).toBe(3);
    expect(result.descriptors[0].name).toBe('ORDER_ID');
    expect(result.descriptors[1].name).toBe('CUST_NAME');
    expect(result.descriptors[2].name).toBe('STATUS');
  });
});
