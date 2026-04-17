/**
 * Tests for FieldDescription factory methods and all field types.
 */

import { describe, it, expect } from 'bun:test';
import { FieldDescription, FIELD_TYPE } from '../../src/record/FieldDescription.js';

describe('FIELD_TYPE constants', () => {
  it('defines all expected types', () => {
    expect(FIELD_TYPE.BINARY).toBe('binary');
    expect(FIELD_TYPE.CHARACTER).toBe('character');
    expect(FIELD_TYPE.PACKED).toBe('packed');
    expect(FIELD_TYPE.ZONED).toBe('zoned');
    expect(FIELD_TYPE.FLOAT).toBe('float');
    expect(FIELD_TYPE.HEX).toBe('hex');
    expect(FIELD_TYPE.DATE).toBe('date');
    expect(FIELD_TYPE.TIME).toBe('time');
    expect(FIELD_TYPE.TIMESTAMP).toBe('timestamp');
    expect(FIELD_TYPE.DBCS_EITHER).toBe('dbcsEither');
    expect(FIELD_TYPE.DBCS_GRAPHIC).toBe('dbcsGraphic');
    expect(FIELD_TYPE.DBCS_ONLY).toBe('dbcsOnly');
    expect(FIELD_TYPE.DBCS_OPEN).toBe('dbcsOpen');
    expect(FIELD_TYPE.ARRAY).toBe('array');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(FIELD_TYPE)).toBe(true);
  });
});

describe('FieldDescription.binary', () => {
  it('creates a 4-byte signed binary field', () => {
    const fd = FieldDescription.binary('CUSTNO', 4);
    expect(fd.name).toBe('CUSTNO');
    expect(fd.fieldType).toBe(FIELD_TYPE.BINARY);
    expect(fd.byteLength).toBe(4);
    expect(fd.dataType.byteLength()).toBe(4);
  });

  it('creates a 2-byte signed binary field', () => {
    const fd = FieldDescription.binary('CODE', 2);
    expect(fd.byteLength).toBe(2);
  });

  it('creates an 8-byte signed binary field', () => {
    const fd = FieldDescription.binary('BIGNUM', 8);
    expect(fd.byteLength).toBe(8);
  });

  it('creates a 1-byte signed binary field', () => {
    const fd = FieldDescription.binary('FLAG', 1);
    expect(fd.byteLength).toBe(1);
  });

  it('creates unsigned binary fields', () => {
    const fd = FieldDescription.binary('UVAL', 4, { unsigned: true });
    expect(fd.byteLength).toBe(4);
    // Unsigned should encode 0xFFFFFFFF as 4294967295
    const buf = fd.dataType.toBuffer(4294967295);
    expect(buf.readUInt32BE(0)).toBe(4294967295);
  });

  it('round-trips a 4-byte integer value', () => {
    const fd = FieldDescription.binary('NUM', 4);
    const buf = fd.dataType.toBuffer(42);
    expect(fd.dataType.fromBuffer(buf)).toBe(42);
  });
});

describe('FieldDescription.character', () => {
  it('creates a character field with default CCSID 37', () => {
    const fd = FieldDescription.character('NAME', 20);
    expect(fd.name).toBe('NAME');
    expect(fd.fieldType).toBe(FIELD_TYPE.CHARACTER);
    expect(fd.byteLength).toBe(20);
    expect(fd.ccsid).toBe(37);
  });

  it('round-trips a text value', () => {
    const fd = FieldDescription.character('CITY', 10);
    const buf = fd.dataType.toBuffer('Hello');
    const val = fd.dataType.fromBuffer(buf);
    expect(val.trim()).toBe('Hello');
  });

  it('accepts a custom CCSID', () => {
    const fd = FieldDescription.character('DESC', 10, 500);
    expect(fd.ccsid).toBe(500);
  });
});

describe('FieldDescription.packedDecimal', () => {
  it('creates a packed decimal field', () => {
    const fd = FieldDescription.packedDecimal('PRICE', 7, 2);
    expect(fd.fieldType).toBe(FIELD_TYPE.PACKED);
    expect(fd.digits).toBe(7);
    expect(fd.decimalPositions).toBe(2);
    // 7 digits packed = floor(7/2) + 1 = 4 bytes
    expect(fd.byteLength).toBe(4);
  });

  it('round-trips a decimal value', () => {
    const fd = FieldDescription.packedDecimal('AMT', 9, 2);
    const buf = fd.dataType.toBuffer('12345.67');
    expect(fd.dataType.fromBuffer(buf)).toBe('12345.67');
  });

  it('round-trips negative', () => {
    const fd = FieldDescription.packedDecimal('BAL', 7, 2);
    const buf = fd.dataType.toBuffer('-100.50');
    expect(fd.dataType.fromBuffer(buf)).toBe('-100.50');
  });
});

describe('FieldDescription.zonedDecimal', () => {
  it('creates a zoned decimal field', () => {
    const fd = FieldDescription.zonedDecimal('QTY', 5, 0);
    expect(fd.fieldType).toBe(FIELD_TYPE.ZONED);
    expect(fd.byteLength).toBe(5); // 1 byte per digit
  });

  it('round-trips a value', () => {
    const fd = FieldDescription.zonedDecimal('RATE', 7, 4);
    const buf = fd.dataType.toBuffer('12.3456');
    expect(fd.dataType.fromBuffer(buf)).toBe('12.3456');
  });
});

describe('FieldDescription.float', () => {
  it('creates a 4-byte float field', () => {
    const fd = FieldDescription.float('TEMP', 4);
    expect(fd.fieldType).toBe(FIELD_TYPE.FLOAT);
    expect(fd.byteLength).toBe(4);
  });

  it('creates an 8-byte double field', () => {
    const fd = FieldDescription.float('PI', 8);
    expect(fd.byteLength).toBe(8);
  });

  it('round-trips float4', () => {
    const fd = FieldDescription.float('VAL', 4);
    const buf = fd.dataType.toBuffer(3.14);
    expect(fd.dataType.fromBuffer(buf)).toBeCloseTo(3.14, 2);
  });

  it('round-trips float8', () => {
    const fd = FieldDescription.float('VAL', 8);
    const buf = fd.dataType.toBuffer(3.141592653589793);
    expect(fd.dataType.fromBuffer(buf)).toBeCloseTo(3.141592653589793, 10);
  });
});

describe('FieldDescription.hex', () => {
  it('creates a hex field', () => {
    const fd = FieldDescription.hex('RAW', 16);
    expect(fd.fieldType).toBe(FIELD_TYPE.HEX);
    expect(fd.byteLength).toBe(16);
  });

  it('round-trips binary data', () => {
    const fd = FieldDescription.hex('DATA', 4);
    const input = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const buf = fd.dataType.toBuffer(input);
    const out = fd.dataType.fromBuffer(buf);
    expect(out).toEqual(input);
  });
});

describe('FieldDescription.date', () => {
  it('creates a date field with *ISO format', () => {
    const fd = FieldDescription.date('HIRE_DATE');
    expect(fd.fieldType).toBe(FIELD_TYPE.DATE);
    expect(fd.format).toBe('*ISO');
    expect(fd.byteLength).toBe(10); // yyyy-MM-dd
  });

  it('round-trips a date string', () => {
    const fd = FieldDescription.date('BDATE', '*ISO');
    const buf = fd.dataType.toBuffer('2024-01-15');
    expect(fd.dataType.fromBuffer(buf)).toBe('2024-01-15');
  });
});

describe('FieldDescription.time', () => {
  it('creates a time field', () => {
    const fd = FieldDescription.time('START_TIME');
    expect(fd.fieldType).toBe(FIELD_TYPE.TIME);
    expect(fd.byteLength).toBe(8);
  });

  it('round-trips a time string', () => {
    const fd = FieldDescription.time('T', '*HMS');
    const buf = fd.dataType.toBuffer('14:30:00');
    expect(fd.dataType.fromBuffer(buf)).toBe('14:30:00');
  });
});

describe('FieldDescription.timestamp', () => {
  it('creates a timestamp field', () => {
    const fd = FieldDescription.timestamp('UPDATED');
    expect(fd.fieldType).toBe(FIELD_TYPE.TIMESTAMP);
    expect(fd.byteLength).toBe(26);
  });
});

describe('FieldDescription.dbcs*', () => {
  it('creates dbcsEither field', () => {
    const fd = FieldDescription.dbcsEither('KANA', 10);
    expect(fd.fieldType).toBe(FIELD_TYPE.DBCS_EITHER);
  });

  it('creates dbcsGraphic field with default CCSID 13488', () => {
    const fd = FieldDescription.dbcsGraphic('KANJI', 10);
    expect(fd.fieldType).toBe(FIELD_TYPE.DBCS_GRAPHIC);
    expect(fd.ccsid).toBe(13488);
  });

  it('creates dbcsOnly field', () => {
    const fd = FieldDescription.dbcsOnly('DBONLY', 10);
    expect(fd.fieldType).toBe(FIELD_TYPE.DBCS_ONLY);
  });

  it('creates dbcsOpen field', () => {
    const fd = FieldDescription.dbcsOpen('DBOPEN', 10);
    expect(fd.fieldType).toBe(FIELD_TYPE.DBCS_OPEN);
  });
});

describe('FieldDescription.array', () => {
  it('creates an array field from element descriptor', () => {
    const elem = FieldDescription.binary('ELEM', 4);
    const fd = FieldDescription.array('NUMS', elem, 5);
    expect(fd.fieldType).toBe(FIELD_TYPE.ARRAY);
    expect(fd.arrayCount).toBe(5);
    expect(fd.byteLength).toBe(20); // 5 * 4
  });
});

describe('FieldDescription metadata', () => {
  it('supports allowNull', () => {
    const fd = FieldDescription.character('OPT', 5, 37, { allowNull: true });
    expect(fd.allowNull).toBe(true);
  });

  it('supports text (description)', () => {
    const fd = FieldDescription.character('NAME', 20, 37, { text: 'Customer name' });
    expect(fd.text).toBe('Customer name');
  });

  it('supports alias', () => {
    const fd = FieldDescription.character('CNAME', 20, 37, { alias: 'customerName' });
    expect(fd.alias).toBe('customerName');
  });

  it('allows setting allowNull', () => {
    const fd = FieldDescription.binary('ID', 4);
    expect(fd.allowNull).toBe(false);
    fd.allowNull = true;
    expect(fd.allowNull).toBe(true);
  });

  it('allows setting defaultValue', () => {
    const fd = FieldDescription.binary('STATUS', 4);
    fd.defaultValue = 1;
    expect(fd.defaultValue).toBe(1);
  });
});
