/**
 * Tests for column descriptor parsing and SQL type name mapping.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseColumnDescriptors, parseExtendedColumnDescriptors,
  sqlTypeToName, calculateRowLength, getColumnByteLength,
  SqlType,
} from '../../src/db/protocol/DBDescriptors.js';

describe('SqlType constants', () => {
  test('expected type codes', () => {
    expect(SqlType.SMALLINT).toBe(500);
    expect(SqlType.INTEGER).toBe(496);
    expect(SqlType.BIGINT).toBe(492);
    expect(SqlType.CHAR).toBe(452);
    expect(SqlType.VARCHAR).toBe(448);
    expect(SqlType.DECIMAL).toBe(484);
    expect(SqlType.NUMERIC).toBe(488);
    expect(SqlType.DATE).toBe(384);
    expect(SqlType.TIME).toBe(388);
    expect(SqlType.TIMESTAMP).toBe(392);
    expect(SqlType.BLOB).toBe(404);
    expect(SqlType.CLOB).toBe(408);
    expect(SqlType.FLOAT).toBe(480);
    expect(SqlType.BINARY).toBe(912);
    expect(SqlType.VARBINARY).toBe(908);
    expect(SqlType.ROWID).toBe(904);
    expect(SqlType.DATALINK).toBe(396);
  });
});

describe('sqlTypeToName', () => {
  test('maps known types', () => {
    expect(sqlTypeToName(500)).toBe('SMALLINT');
    expect(sqlTypeToName(501)).toBe('SMALLINT'); // nullable variant (odd)
    expect(sqlTypeToName(496)).toBe('INTEGER');
    expect(sqlTypeToName(497)).toBe('INTEGER');
    expect(sqlTypeToName(492)).toBe('BIGINT');
    expect(sqlTypeToName(452)).toBe('CHAR');
    expect(sqlTypeToName(453)).toBe('CHAR');
    expect(sqlTypeToName(448)).toBe('VARCHAR');
    expect(sqlTypeToName(484)).toBe('DECIMAL');
    expect(sqlTypeToName(488)).toBe('NUMERIC');
    expect(sqlTypeToName(480)).toBe('FLOAT');
    expect(sqlTypeToName(384)).toBe('DATE');
    expect(sqlTypeToName(388)).toBe('TIME');
    expect(sqlTypeToName(392)).toBe('TIMESTAMP');
    expect(sqlTypeToName(912)).toBe('BINARY');
    expect(sqlTypeToName(908)).toBe('VARBINARY');
    expect(sqlTypeToName(404)).toBe('BLOB');
    expect(sqlTypeToName(408)).toBe('CLOB');
    expect(sqlTypeToName(412)).toBe('DBCLOB');
    expect(sqlTypeToName(960)).toBe('BLOB_LOCATOR');
    expect(sqlTypeToName(964)).toBe('CLOB_LOCATOR');
    expect(sqlTypeToName(968)).toBe('DBCLOB_LOCATOR');
    expect(sqlTypeToName(904)).toBe('ROWID');
    expect(sqlTypeToName(396)).toBe('DATALINK');
    expect(sqlTypeToName(996)).toBe('DECFLOAT');
  });

  test('maps negative types (nullable)', () => {
    expect(sqlTypeToName(-500)).toBe('SMALLINT');
    expect(sqlTypeToName(-496)).toBe('INTEGER');
  });

  test('returns UNKNOWN for unrecognized types', () => {
    expect(sqlTypeToName(9999)).toBe('UNKNOWN');
    expect(sqlTypeToName(0)).toBe('UNKNOWN');
  });
});

describe('parseColumnDescriptors', () => {
  function buildDescriptor(sqlType, length, scale, precision, ccsid, joinRef, flags) {
    const buf = Buffer.alloc(16);
    buf.writeInt16BE(sqlType, 0);
    buf.writeInt32BE(length, 2);
    buf.writeInt16BE(scale, 6);
    buf.writeInt16BE(precision, 8);
    buf.writeUInt16BE(ccsid, 10);
    buf.writeUInt16BE(joinRef, 12);
    buf.writeUInt16BE(flags, 14);
    return buf;
  }

  test('parses single INT column', () => {
    const buf = buildDescriptor(496, 4, 0, 10, 0, 0, 0);
    const descs = parseColumnDescriptors(buf, 1);
    expect(descs.length).toBe(1);
    expect(descs[0].sqlType).toBe(496);
    expect(descs[0].length).toBe(4);
    expect(descs[0].scale).toBe(0);
    expect(descs[0].precision).toBe(10);
    expect(descs[0].typeName).toBe('INTEGER');
    expect(descs[0].nullable).toBe(false);
  });

  test('parses nullable VARCHAR column', () => {
    const buf = buildDescriptor(449, 100, 0, 0, 37, 0, 0x0001);
    const descs = parseColumnDescriptors(buf, 1);
    expect(descs[0].sqlType).toBe(449);
    expect(descs[0].length).toBe(100);
    expect(descs[0].ccsid).toBe(37);
    expect(descs[0].nullable).toBe(true);
    expect(descs[0].typeName).toBe('VARCHAR');
  });

  test('parses multiple columns', () => {
    const buf = Buffer.concat([
      buildDescriptor(500, 2, 0, 5, 0, 0, 0),
      buildDescriptor(452, 10, 0, 0, 37, 0, 0x0001),
      buildDescriptor(484, 8, 2, 15, 0, 0, 0),
    ]);
    const descs = parseColumnDescriptors(buf, 3);
    expect(descs.length).toBe(3);
    expect(descs[0].typeName).toBe('SMALLINT');
    expect(descs[1].typeName).toBe('CHAR');
    expect(descs[1].nullable).toBe(true);
    expect(descs[2].typeName).toBe('DECIMAL');
    expect(descs[2].scale).toBe(2);
    expect(descs[2].precision).toBe(15);
  });

  test('handles offset parameter', () => {
    const prefix = Buffer.alloc(4); // 4 bytes before descriptors
    const desc = buildDescriptor(496, 4, 0, 10, 0, 0, 0);
    const buf = Buffer.concat([prefix, desc]);
    const descs = parseColumnDescriptors(buf, 1, 4);
    expect(descs.length).toBe(1);
    expect(descs[0].sqlType).toBe(496);
  });

  test('stops on short buffer', () => {
    const buf = Buffer.alloc(10); // Less than 16 bytes
    const descs = parseColumnDescriptors(buf, 1);
    expect(descs.length).toBe(0);
  });
});

describe('parseExtendedColumnDescriptors', () => {
  test('parses fixed parts correctly', () => {
    // Build a single extended descriptor: 52 bytes fixed + variable strings
    const fixed = Buffer.alloc(52, 0);
    fixed.writeInt16BE(496, 0);   // sqlType = INTEGER
    fixed.writeInt32BE(4, 2);     // length
    fixed.writeInt16BE(0, 6);     // scale
    fixed.writeInt16BE(10, 8);    // precision
    fixed.writeUInt16BE(0, 10);   // ccsid
    fixed.writeUInt16BE(0, 12);   // joinRef
    fixed.writeUInt16BE(0x0001, 14); // flags (nullable)
    fixed.writeInt32BE(1208, 16); // label CCSID (UTF-8)
    fixed.writeInt32BE(5, 20);    // label length
    fixed.writeInt32BE(1208, 24); // name CCSID
    fixed.writeInt32BE(4, 28);    // name length
    fixed.writeInt32BE(0, 32);    // base col CCSID
    fixed.writeInt32BE(0, 36);    // base col length
    fixed.writeInt32BE(0, 40);    // table CCSID
    fixed.writeInt32BE(0, 44);    // table length
    fixed.writeInt32BE(0, 48);    // schema CCSID

    const label = Buffer.from('COUNT', 'utf8');
    const name = Buffer.from('CNT1', 'utf8');

    const buf = Buffer.concat([fixed, label, name]);
    const descs = parseExtendedColumnDescriptors(buf, 1);

    expect(descs.length).toBe(1);
    expect(descs[0].sqlType).toBe(496);
    expect(descs[0].length).toBe(4);
    expect(descs[0].nullable).toBe(true);
    expect(descs[0].typeName).toBe('INTEGER');
    expect(descs[0].label).toBe('COUNT');
    expect(descs[0].name).toBe('CNT1');
  });
});

describe('getColumnByteLength', () => {
  test('SMALLINT = 2', () => {
    expect(getColumnByteLength({ sqlType: 500, length: 2 })).toBe(2);
  });

  test('INTEGER = 4', () => {
    expect(getColumnByteLength({ sqlType: 496, length: 4 })).toBe(4);
  });

  test('BIGINT = 8', () => {
    expect(getColumnByteLength({ sqlType: 492, length: 8 })).toBe(8);
  });

  test('FLOAT (4 bytes) = 4', () => {
    expect(getColumnByteLength({ sqlType: 480, length: 4 })).toBe(4);
  });

  test('FLOAT (8 bytes) = 8', () => {
    expect(getColumnByteLength({ sqlType: 480, length: 8 })).toBe(8);
  });

  test('VARCHAR = 2 + length', () => {
    expect(getColumnByteLength({ sqlType: 448, length: 50 })).toBe(52);
  });

  test('CHAR = length', () => {
    expect(getColumnByteLength({ sqlType: 452, length: 10 })).toBe(10);
  });

  test('BLOB_LOCATOR = 4', () => {
    expect(getColumnByteLength({ sqlType: 960, length: 0 })).toBe(4);
  });
});

describe('calculateRowLength', () => {
  test('sums column lengths plus null indicators', () => {
    const descs = [
      { sqlType: 496, length: 4, nullable: false },  // INT = 4
      { sqlType: 448, length: 50, nullable: true },   // VARCHAR = 2+50+2(null) = 54
      { sqlType: 500, length: 2, nullable: false },   // SMALLINT = 2
    ];
    // 4 + (52+2) + 2 = 60
    expect(calculateRowLength(descs)).toBe(60);
  });

  test('empty descriptors = 0', () => {
    expect(calculateRowLength([])).toBe(0);
  });
});
