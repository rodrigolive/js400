/**
 * Tests for SQL type encode/decode: numeric, string, binary, datetime.
 */
import { describe, test, expect } from 'bun:test';
import {
  getTypeHandler, decodeValue, encodeValue, decodeRow, decodeRows,
} from '../../src/db/types/factory.js';
import { numericTypes } from '../../src/db/types/numeric.js';
import { stringTypes } from '../../src/db/types/string.js';
import { binaryTypes } from '../../src/db/types/binary.js';
import { datetimeTypes } from '../../src/db/types/datetime.js';

describe('type factory', () => {
  test('getTypeHandler returns handler for known types', () => {
    expect(getTypeHandler(500)).not.toBeNull(); // SMALLINT
    expect(getTypeHandler(496)).not.toBeNull(); // INTEGER
    expect(getTypeHandler(492)).not.toBeNull(); // BIGINT
    expect(getTypeHandler(452)).not.toBeNull(); // CHAR
    expect(getTypeHandler(448)).not.toBeNull(); // VARCHAR
    expect(getTypeHandler(484)).not.toBeNull(); // DECIMAL
    expect(getTypeHandler(488)).not.toBeNull(); // NUMERIC
    expect(getTypeHandler(480)).not.toBeNull(); // FLOAT
    expect(getTypeHandler(384)).not.toBeNull(); // DATE
    expect(getTypeHandler(388)).not.toBeNull(); // TIME
    expect(getTypeHandler(392)).not.toBeNull(); // TIMESTAMP
    expect(getTypeHandler(912)).not.toBeNull(); // BINARY
    expect(getTypeHandler(908)).not.toBeNull(); // VARBINARY
  });

  test('getTypeHandler handles nullable type codes (odd)', () => {
    expect(getTypeHandler(501)).not.toBeNull(); // SMALLINT nullable
    expect(getTypeHandler(497)).not.toBeNull(); // INTEGER nullable
    expect(getTypeHandler(449)).not.toBeNull(); // VARCHAR nullable
  });

  test('getTypeHandler returns null for unknown types', () => {
    expect(getTypeHandler(9999)).toBeNull();
  });
});

describe('SMALLINT (500)', () => {
  const handler = numericTypes[500];

  test('decode', () => {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(42, 0);
    const { value, bytesRead } = handler.decode(buf, 0, { length: 2 });
    expect(value).toBe(42);
    expect(bytesRead).toBe(2);
  });

  test('decode negative', () => {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(-100, 0);
    expect(handler.decode(buf, 0, { length: 2 }).value).toBe(-100);
  });

  test('encode', () => {
    const buf = handler.encode(42, { length: 2 });
    expect(buf.readInt16BE(0)).toBe(42);
  });

  test('round-trip', () => {
    const encoded = handler.encode(-999, { length: 2 });
    const { value } = handler.decode(encoded, 0, { length: 2 });
    expect(value).toBe(-999);
  });
});

describe('INTEGER (496)', () => {
  const handler = numericTypes[496];

  test('decode', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(123456, 0);
    expect(handler.decode(buf, 0, { length: 4 }).value).toBe(123456);
  });

  test('encode', () => {
    const buf = handler.encode(123456, { length: 4 });
    expect(buf.readInt32BE(0)).toBe(123456);
  });

  test('round-trip', () => {
    const encoded = handler.encode(-2147483648, { length: 4 });
    expect(handler.decode(encoded, 0, { length: 4 }).value).toBe(-2147483648);
  });
});

describe('BIGINT (492)', () => {
  const handler = numericTypes[492];

  test('decode', () => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(9007199254740991n, 0);
    expect(handler.decode(buf, 0, { length: 8 }).value).toBe(9007199254740991n);
  });

  test('encode', () => {
    const buf = handler.encode(12345678901234n, { length: 8 });
    expect(buf.readBigInt64BE(0)).toBe(12345678901234n);
  });
});

describe('FLOAT (480)', () => {
  const handler = numericTypes[480];

  test('decode 4-byte float', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(3.14, 0);
    const { value, bytesRead } = handler.decode(buf, 0, { length: 4 });
    expect(value).toBeCloseTo(3.14, 2);
    expect(bytesRead).toBe(4);
  });

  test('decode 8-byte double', () => {
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(3.141592653589793, 0);
    const { value, bytesRead } = handler.decode(buf, 0, { length: 8 });
    expect(value).toBeCloseTo(3.141592653589793, 10);
    expect(bytesRead).toBe(8);
  });

  test('encode 4-byte float', () => {
    const buf = handler.encode(2.5, { length: 4 });
    expect(buf.length).toBe(4);
    expect(buf.readFloatBE(0)).toBeCloseTo(2.5, 2);
  });

  test('encode 8-byte double', () => {
    const buf = handler.encode(2.5, { length: 8 });
    expect(buf.length).toBe(8);
    expect(buf.readDoubleBE(0)).toBe(2.5);
  });
});

describe('DECIMAL (484) - packed', () => {
  const handler = numericTypes[484];

  test('decode 12345 (precision=5, scale=0)', () => {
    // Packed decimal: each byte = 2 digits, last nibble = sign
    // 12345 → 0x12 0x34 0x5F (digits: 1,2,3,4,5 sign F=positive)
    const buf = Buffer.from([0x12, 0x34, 0x5F]);
    const { value } = handler.decode(buf, 0, { length: 3, scale: 0, precision: 5 });
    expect(value).toBe(12345);
  });

  test('decode -12345 (negative)', () => {
    // 12345 negative → 0x12 0x34 0x5D (sign D=negative)
    const buf = Buffer.from([0x12, 0x34, 0x5D]);
    const { value } = handler.decode(buf, 0, { length: 3, scale: 0, precision: 5 });
    expect(value).toBe(-12345);
  });

  test('decode 123.45 (scale=2)', () => {
    const buf = Buffer.from([0x12, 0x34, 0x5F]);
    const { value } = handler.decode(buf, 0, { length: 3, scale: 2, precision: 5 });
    expect(value).toBeCloseTo(123.45, 2);
  });

  test('encode round-trip', () => {
    const encoded = handler.encode(123.45, { length: 4, scale: 2, precision: 7 });
    const { value } = handler.decode(encoded, 0, { length: 4, scale: 2, precision: 7 });
    expect(value).toBeCloseTo(123.45, 2);
  });

  test('encode negative round-trip', () => {
    const encoded = handler.encode(-99.99, { length: 3, scale: 2, precision: 4 });
    const { value } = handler.decode(encoded, 0, { length: 3, scale: 2, precision: 4 });
    expect(value).toBeCloseTo(-99.99, 2);
  });
});

describe('NUMERIC (488) - zoned', () => {
  const handler = numericTypes[488];

  test('decode positive zoned', () => {
    // 12345 in zoned: F1 F2 F3 F4 F5 (last byte zone=F for positive)
    const buf = Buffer.from([0xF1, 0xF2, 0xF3, 0xF4, 0xF5]);
    const { value } = handler.decode(buf, 0, { length: 5, scale: 0 });
    expect(value).toBe(12345);
  });

  test('decode negative zoned', () => {
    // -12345 in zoned: F1 F2 F3 F4 D5 (last byte zone=D for negative)
    const buf = Buffer.from([0xF1, 0xF2, 0xF3, 0xF4, 0xD5]);
    const { value } = handler.decode(buf, 0, { length: 5, scale: 0 });
    expect(value).toBe(-12345);
  });

  test('decode with scale', () => {
    const buf = Buffer.from([0xF1, 0xF2, 0xF3, 0xF4, 0xF5]);
    const { value } = handler.decode(buf, 0, { length: 5, scale: 2 });
    expect(value).toBeCloseTo(123.45, 2);
  });

  test('encode round-trip', () => {
    const encoded = handler.encode(456.78, { length: 5, scale: 2 });
    const { value } = handler.decode(encoded, 0, { length: 5, scale: 2 });
    expect(value).toBeCloseTo(456.78, 2);
  });
});

describe('CHAR (452)', () => {
  const handler = stringTypes[452];

  test('decode UTF-16BE string', () => {
    // 'Hi' in UTF-16BE (CCSID 13488)
    const buf = Buffer.alloc(10);
    buf.writeUInt16BE(0x0048, 0); // H
    buf.writeUInt16BE(0x0069, 2); // i
    // rest is spaces in UTF-16BE
    for (let i = 4; i < 10; i += 2) buf.writeUInt16BE(0x0020, i);
    const { value, bytesRead } = handler.decode(buf, 0, { length: 10, ccsid: 13488 });
    expect(value).toBe('Hi');
    expect(bytesRead).toBe(10);
  });

  test('encode UTF-16BE string', () => {
    const encoded = handler.encode('AB', { length: 8, ccsid: 13488 });
    expect(encoded.length).toBe(8);
    expect(encoded.readUInt16BE(0)).toBe(0x0041); // A
    expect(encoded.readUInt16BE(2)).toBe(0x0042); // B
  });

  test('trims trailing spaces on decode', () => {
    const buf = Buffer.alloc(6);
    buf.writeUInt16BE(0x0058, 0); // X
    buf.writeUInt16BE(0x0020, 2); // space
    buf.writeUInt16BE(0x0020, 4); // space
    const { value } = handler.decode(buf, 0, { length: 6, ccsid: 13488 });
    expect(value).toBe('X');
  });
});

describe('VARCHAR (448)', () => {
  const handler = stringTypes[448];

  test('decode UTF-16BE VARCHAR', () => {
    const maxLen = 20;
    const buf = Buffer.alloc(2 + maxLen);
    buf.writeUInt16BE(4, 0); // actual data length = 4 bytes = 2 chars
    buf.writeUInt16BE(0x0048, 2); // H
    buf.writeUInt16BE(0x0069, 4); // i
    const { value, bytesRead } = handler.decode(buf, 0, { length: maxLen, ccsid: 13488 });
    expect(value).toBe('Hi');
    expect(bytesRead).toBe(2 + maxLen);
  });

  test('encode VARCHAR', () => {
    const encoded = handler.encode('Hi', { length: 20, ccsid: 13488 });
    expect(encoded.length).toBe(6); // 2-byte prefix + 4 bytes of UTF-16BE data
    const dataLen = encoded.readUInt16BE(0);
    expect(dataLen).toBe(4); // 2 chars × 2 bytes
  });
});

describe('BINARY (912)', () => {
  const handler = binaryTypes[912];

  test('decode', () => {
    const buf = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const { value, bytesRead } = handler.decode(buf, 0, { length: 4 });
    expect(bytesRead).toBe(4);
    expect(value[0]).toBe(0xDE);
    expect(value[3]).toBe(0xEF);
  });

  test('encode from Buffer', () => {
    const input = Buffer.from([0xCA, 0xFE]);
    const encoded = handler.encode(input, { length: 4 });
    expect(encoded.length).toBe(4);
    expect(encoded[0]).toBe(0xCA);
    expect(encoded[1]).toBe(0xFE);
    expect(encoded[2]).toBe(0);
  });
});

describe('VARBINARY (908)', () => {
  const handler = binaryTypes[908];

  test('decode', () => {
    const buf = Buffer.alloc(2 + 10);
    buf.writeUInt16BE(3, 0); // actual length = 3
    buf[2] = 0x01;
    buf[3] = 0x02;
    buf[4] = 0x03;
    const { value, bytesRead } = handler.decode(buf, 0, { length: 10 });
    expect(bytesRead).toBe(12);
    expect(value.length).toBe(3);
    expect(value[0]).toBe(0x01);
  });

  test('encode from Buffer', () => {
    const input = Buffer.from([0xAA, 0xBB]);
    const encoded = handler.encode(input, { length: 8 });
    expect(encoded.length).toBe(4); // 2-byte prefix + 2 data bytes
    expect(encoded.readUInt16BE(0)).toBe(2);
    expect(encoded[2]).toBe(0xAA);
  });
});

describe('DATE (384)', () => {
  const handler = datetimeTypes[384];

  test('decode UTF-16BE date', () => {
    const dateStr = '2026-04-15';
    const buf = Buffer.alloc(dateStr.length * 2);
    for (let i = 0; i < dateStr.length; i++) {
      buf.writeUInt16BE(dateStr.charCodeAt(i), i * 2);
    }
    const { value } = handler.decode(buf, 0, { length: buf.length, ccsid: 13488 });
    expect(value).toBe('2026-04-15');
  });
});

describe('TIME (388)', () => {
  const handler = datetimeTypes[388];

  test('decode UTF-16BE time', () => {
    const timeStr = '14:30:00';
    const buf = Buffer.alloc(timeStr.length * 2);
    for (let i = 0; i < timeStr.length; i++) {
      buf.writeUInt16BE(timeStr.charCodeAt(i), i * 2);
    }
    const { value } = handler.decode(buf, 0, { length: buf.length, ccsid: 13488 });
    expect(value).toBe('14:30:00');
  });
});

describe('TIMESTAMP (392)', () => {
  const handler = datetimeTypes[392];

  test('decode UTF-16BE timestamp', () => {
    const tsStr = '2026-04-15-14.30.00.000000';
    const buf = Buffer.alloc(tsStr.length * 2);
    for (let i = 0; i < tsStr.length; i++) {
      buf.writeUInt16BE(tsStr.charCodeAt(i), i * 2);
    }
    const { value } = handler.decode(buf, 0, { length: buf.length, ccsid: 13488 });
    expect(value).toBe('2026-04-15-14.30.00.000000');
  });
});

describe('decodeRow', () => {
  test('decodes multi-column row', () => {
    // Build a row: INT(4) + SMALLINT(2)
    const buf = Buffer.alloc(6);
    buf.writeInt32BE(42, 0);
    buf.writeInt16BE(7, 4);

    const descs = [
      { index: 0, name: 'id', sqlType: 496, length: 4, nullable: false },
      { index: 1, name: 'count', sqlType: 500, length: 2, nullable: false },
    ];

    const { row, bytesRead } = decodeRow(buf, 0, descs);
    expect(row.id).toBe(42);
    expect(row.count).toBe(7);
    expect(bytesRead).toBe(6);
  });

  test('handles nullable column with null indicator', () => {
    // Build: null indicator (-1) + INT data (4 bytes, ignored)
    const buf = Buffer.alloc(6);
    buf.writeInt16BE(-1, 0); // null indicator
    buf.writeInt32BE(99, 2); // data (should be ignored)

    const descs = [
      { index: 0, name: 'val', sqlType: 496, length: 4, nullable: true },
    ];

    const { row } = decodeRow(buf, 0, descs);
    expect(row.val).toBeNull();
  });

  test('handles nullable column with non-null value', () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16BE(0, 0); // not null
    buf.writeInt32BE(123, 2);

    const descs = [
      { index: 0, name: 'val', sqlType: 496, length: 4, nullable: true },
    ];

    const { row } = decodeRow(buf, 0, descs);
    expect(row.val).toBe(123);
  });
});

describe('decodeRows', () => {
  test('decodes multiple rows', () => {
    // 3 rows of INT(4)
    const buf = Buffer.alloc(12);
    buf.writeInt32BE(10, 0);
    buf.writeInt32BE(20, 4);
    buf.writeInt32BE(30, 8);

    const descs = [
      { index: 0, name: 'num', sqlType: 496, length: 4, nullable: false },
    ];

    const rows = decodeRows(buf, 0, descs, 3);
    expect(rows.length).toBe(3);
    expect(rows[0].num).toBe(10);
    expect(rows[1].num).toBe(20);
    expect(rows[2].num).toBe(30);
  });

  test('stops at buffer end even if rowCount is higher', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(42, 0);

    const descs = [
      { index: 0, name: 'x', sqlType: 496, length: 4, nullable: false },
    ];

    const rows = decodeRows(buf, 0, descs, 100);
    expect(rows.length).toBe(1);
  });

  test('uses col index for unnamed columns', () => {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(7, 0);

    const descs = [
      { index: 0, name: '', sqlType: 500, length: 2, nullable: false },
    ];

    const rows = decodeRows(buf, 0, descs, 1);
    expect(rows[0].col0).toBe(7);
  });
});
