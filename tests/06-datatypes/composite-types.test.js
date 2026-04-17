/**
 * Tests for composite types and text types.
 */

import { describe, it, expect } from 'bun:test';
import {
  AS400Array,
  AS400Structure,
  AS400Bin4,
  AS400Text,
  AS400Varchar,
  AS400Float8,
  AS400Boolean,
  AS400PackedDecimal,
  AS400ByteArray,
} from '../../src/datatypes/index.js';

describe('AS400Array', () => {
  it('encodes and decodes array of integers', () => {
    const arr = new AS400Array(new AS400Bin4(), 3);
    const buf = arr.toBuffer([10, 20, 30]);
    const result = arr.fromBuffer(buf);
    expect(result).toEqual([10, 20, 30]);
  });

  it('has correct byteLength', () => {
    const arr = new AS400Array(new AS400Bin4(), 5);
    expect(arr.byteLength()).toBe(20);
  });

  it('pads short arrays with zeros', () => {
    const arr = new AS400Array(new AS400Bin4(), 3);
    const buf = arr.toBuffer([42]);
    const result = arr.fromBuffer(buf);
    expect(result[0]).toBe(42);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
  });

  it('decodes from offset', () => {
    const arr = new AS400Array(new AS400Bin4(), 2);
    const buf = Buffer.alloc(12);
    buf.writeInt32BE(99, 4);
    buf.writeInt32BE(88, 8);
    const result = arr.fromBuffer(buf, 4);
    expect(result).toEqual([99, 88]);
  });
});

describe('AS400Structure', () => {
  it('encodes and decodes heterogeneous structure', () => {
    const struct = new AS400Structure([
      new AS400Bin4(),
      new AS400Float8(),
      new AS400Boolean(),
    ]);

    const buf = struct.toBuffer([42, 3.14, true]);
    const [i, f, b] = struct.fromBuffer(buf);
    expect(i).toBe(42);
    expect(Math.abs(f - 3.14)).toBeLessThan(0.0001);
    expect(b).toBe(true);
  });

  it('has correct byteLength', () => {
    const struct = new AS400Structure([
      new AS400Bin4(),
      new AS400Bin4(),
    ]);
    expect(struct.byteLength()).toBe(8);
  });

  it('nests AS400Array inside AS400Structure', () => {
    const struct = new AS400Structure([
      new AS400Bin4(),
      new AS400Array(new AS400Bin4(), 3),
    ]);

    const buf = struct.toBuffer([99, [10, 20, 30]]);
    const [id, arr] = struct.fromBuffer(buf);
    expect(id).toBe(99);
    expect(arr).toEqual([10, 20, 30]);
  });

  it('nests AS400Structure inside AS400Array', () => {
    const inner = new AS400Structure([
      new AS400Bin4(),
      new AS400Boolean(),
    ]);
    const arr = new AS400Array(inner, 2);

    const buf = arr.toBuffer([
      [1, true],
      [2, false],
    ]);
    const result = arr.fromBuffer(buf);
    expect(result[0]).toEqual([1, true]);
    expect(result[1]).toEqual([2, false]);
  });

  it('rejects empty members array', () => {
    expect(() => new AS400Structure([])).toThrow();
  });
});

describe('AS400Text', () => {
  it('encodes and pads with EBCDIC spaces', () => {
    const text = new AS400Text(10, 37);
    const buf = text.toBuffer('HELLO');
    expect(buf.length).toBe(10);
    // Trailing bytes should be EBCDIC space (0x40)
    expect(buf[5]).toBe(0x40);
    expect(buf[9]).toBe(0x40);
  });

  it('decodes with trailing spaces', () => {
    const text = new AS400Text(10, 37);
    const buf = text.toBuffer('HELLO');
    const result = text.fromBuffer(buf);
    expect(result.startsWith('HELLO')).toBe(true);
  });

  it('round-trips text', () => {
    const text = new AS400Text(5, 37);
    const result = text.fromBuffer(text.toBuffer('ABCDE'));
    expect(result).toBe('ABCDE');
  });

  it('has correct byteLength', () => {
    const text = new AS400Text(20, 37);
    expect(text.byteLength()).toBe(20);
  });
});

describe('AS400Varchar', () => {
  it('encodes with 2-byte length prefix', () => {
    const vc = new AS400Varchar(20, 37);
    const buf = vc.toBuffer('HELLO');
    // First 2 bytes are length
    expect(buf.readUInt16BE(0)).toBe(5);
    expect(buf.length).toBe(22); // 2 + maxLength
  });

  it('decodes correctly', () => {
    const vc = new AS400Varchar(20, 37);
    const buf = vc.toBuffer('TEST');
    const result = vc.fromBuffer(buf);
    expect(result).toBe('TEST');
  });

  it('has correct byteLength', () => {
    const vc = new AS400Varchar(50, 37);
    expect(vc.byteLength()).toBe(52); // 2 + 50
  });
});

describe('AS400Structure with AS400Text', () => {
  it('encodes record-like structure', () => {
    const struct = new AS400Structure([
      new AS400Bin4(),
      new AS400Text(20, 37),
      new AS400Bin4(),
    ]);

    const buf = struct.toBuffer([1, 'CUSTOMER', 100]);
    const [id, name, balance] = struct.fromBuffer(buf);
    expect(id).toBe(1);
    expect(name.trim()).toBe('CUSTOMER');
    expect(balance).toBe(100);
  });
});
