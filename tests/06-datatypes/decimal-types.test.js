/**
 * Tests for packed decimal, zoned decimal, and decimal float types.
 */

import { describe, it, expect } from 'bun:test';
import {
  AS400PackedDecimal,
  AS400ZonedDecimal,
  AS400DecFloat,
} from '../../src/datatypes/index.js';

describe('AS400PackedDecimal', () => {
  it('encodes positive integer', () => {
    const pd = new AS400PackedDecimal(7, 2);
    const buf = pd.toBuffer('12345.67');
    // packed(7,2): 7 digits -> 4 bytes
    // digits: 0123456, sign F
    // 01 23 45 67 -> with sign: 01 23 45 6F wait
    // actually 7 digits with 2 decimal: 12345.67 -> "1234567" + sign F
    // byte layout: 01 23 45 6F (since 7 is odd, digit goes left nibble, sign right)
    expect(buf.length).toBe(4);
    expect(pd.fromBuffer(buf)).toBe('12345.67');
  });

  it('encodes zero', () => {
    const pd = new AS400PackedDecimal(5, 0);
    const result = pd.fromBuffer(pd.toBuffer('0'));
    expect(result).toBe('0');
  });

  it('encodes negative value', () => {
    const pd = new AS400PackedDecimal(5, 2);
    const buf = pd.toBuffer('-123.45');
    const result = pd.fromBuffer(buf);
    expect(result).toBe('-123.45');
  });

  it('round-trips various values', () => {
    const pd = new AS400PackedDecimal(9, 2);
    const values = ['0.00', '1.00', '99999.99', '-1.23', '-99999.99'];
    for (const v of values) {
      // Normalize: strip leading zeros for integer part
      const result = pd.fromBuffer(pd.toBuffer(v));
      const normalizeV = v.replace(/^(-?)0+(?=\d)/, '$1');
      expect(result).toBe(normalizeV);
    }
  });

  it('encodes max precision', () => {
    const pd = new AS400PackedDecimal(1, 0);
    expect(pd.byteLength()).toBe(1);
    expect(pd.fromBuffer(pd.toBuffer('9'))).toBe('9');
    expect(pd.fromBuffer(pd.toBuffer('0'))).toBe('0');
  });

  it('preserves exact decimal string', () => {
    const pd = new AS400PackedDecimal(7, 2);
    const result = pd.fromBuffer(pd.toBuffer('100.50'));
    expect(result).toBe('100.50');
  });

  it('rejects invalid constructor args', () => {
    expect(() => new AS400PackedDecimal(0, 0)).toThrow();
    expect(() => new AS400PackedDecimal(64, 0)).toThrow();
    expect(() => new AS400PackedDecimal(5, 6)).toThrow();
  });
});

describe('AS400ZonedDecimal', () => {
  it('encodes positive integer', () => {
    const zd = new AS400ZonedDecimal(5, 2);
    const buf = zd.toBuffer('123.45');
    expect(buf.length).toBe(5);
    expect(zd.fromBuffer(buf)).toBe('123.45');
  });

  it('encodes negative value', () => {
    const zd = new AS400ZonedDecimal(5, 2);
    const buf = zd.toBuffer('-123.45');
    const result = zd.fromBuffer(buf);
    expect(result).toBe('-123.45');
  });

  it('encodes zero', () => {
    const zd = new AS400ZonedDecimal(3, 0);
    expect(zd.fromBuffer(zd.toBuffer('0'))).toBe('0');
  });

  it('has correct byte length (one byte per digit)', () => {
    const zd = new AS400ZonedDecimal(7, 2);
    expect(zd.byteLength()).toBe(7);
  });

  it('zone nibble is 0xF for non-last digits', () => {
    const zd = new AS400ZonedDecimal(3, 0);
    const buf = zd.toBuffer('123');
    // byte 0: F1, byte 1: F2, byte 2: F3 (positive sign)
    expect((buf[0] >> 4) & 0x0F).toBe(0x0F);
    expect(buf[0] & 0x0F).toBe(1);
    expect((buf[1] >> 4) & 0x0F).toBe(0x0F);
    expect(buf[1] & 0x0F).toBe(2);
    expect((buf[2] >> 4) & 0x0F).toBe(0x0F); // positive
    expect(buf[2] & 0x0F).toBe(3);
  });

  it('zone nibble is 0xD for negative last digit', () => {
    const zd = new AS400ZonedDecimal(3, 0);
    const buf = zd.toBuffer('-123');
    expect((buf[2] >> 4) & 0x0F).toBe(0x0D);
    expect(buf[2] & 0x0F).toBe(3);
  });

  it('round-trips edge cases', () => {
    const zd = new AS400ZonedDecimal(7, 3);
    const values = ['0.000', '9999.999', '-1.000', '-9999.999'];
    for (const v of values) {
      const result = zd.fromBuffer(zd.toBuffer(v));
      const normalizeV = v.replace(/^(-?)0+(?=\d)/, '$1');
      expect(result).toBe(normalizeV);
    }
  });
});

describe('AS400DecFloat', () => {
  describe('decimal64 (16 digits)', () => {
    const df16 = new AS400DecFloat(16);

    it('has correct byte length', () => {
      expect(df16.byteLength()).toBe(8);
    });

    it('round-trips integer', () => {
      const result = df16.fromBuffer(df16.toBuffer('12345'));
      expect(result).toBe('12345');
    });

    it('round-trips decimal', () => {
      const result = df16.fromBuffer(df16.toBuffer('123.45'));
      expect(result).toBe('123.45');
    });

    it('round-trips zero', () => {
      const result = df16.fromBuffer(df16.toBuffer('0'));
      expect(result).toMatch(/^0/);
    });

    it('handles infinity', () => {
      expect(df16.fromBuffer(df16.toBuffer('Infinity'))).toBe('Infinity');
      expect(df16.fromBuffer(df16.toBuffer('-Infinity'))).toBe('-Infinity');
    });

    it('handles NaN', () => {
      expect(df16.fromBuffer(df16.toBuffer('NaN'))).toBe('NaN');
    });
  });

  describe('decimal128 (34 digits)', () => {
    const df34 = new AS400DecFloat(34);

    it('has correct byte length', () => {
      expect(df34.byteLength()).toBe(16);
    });

    it('round-trips integer', () => {
      const result = df34.fromBuffer(df34.toBuffer('123456789'));
      expect(result).toBe('123456789');
    });

    it('round-trips decimal', () => {
      const result = df34.fromBuffer(df34.toBuffer('12345.6789'));
      expect(result).toBe('12345.6789');
    });

    it('handles infinity', () => {
      expect(df34.fromBuffer(df34.toBuffer('Infinity'))).toBe('Infinity');
    });

    it('handles NaN', () => {
      expect(df34.fromBuffer(df34.toBuffer('NaN'))).toBe('NaN');
    });
  });

  it('rejects invalid precision', () => {
    expect(() => new AS400DecFloat(8)).toThrow();
  });
});
