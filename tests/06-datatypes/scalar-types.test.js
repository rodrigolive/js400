/**
 * Golden vector tests for all scalar data types.
 */

import { describe, it, expect } from 'bun:test';
import {
  AS400Bin1, AS400Bin2, AS400Bin4, AS400Bin8,
  AS400UnsignedBin1, AS400UnsignedBin2, AS400UnsignedBin4, AS400UnsignedBin8,
  AS400Float4, AS400Float8,
  AS400Boolean,
  AS400ByteArray,
  AS400DataType,
  BinaryConverter,
} from '../../src/datatypes/index.js';

describe('AS400Bin1', () => {
  const bin1 = new AS400Bin1();

  it('encodes and decodes positive', () => {
    const buf = bin1.toBuffer(127);
    expect(buf).toEqual(Buffer.from([0x7F]));
    expect(bin1.fromBuffer(buf)).toBe(127);
  });

  it('encodes and decodes negative', () => {
    const buf = bin1.toBuffer(-128);
    expect(buf).toEqual(Buffer.from([0x80]));
    expect(bin1.fromBuffer(buf)).toBe(-128);
  });

  it('encodes zero', () => {
    const buf = bin1.toBuffer(0);
    expect(buf).toEqual(Buffer.from([0x00]));
    expect(bin1.fromBuffer(buf)).toBe(0);
  });

  it('has correct byteLength', () => {
    expect(bin1.byteLength()).toBe(1);
  });

  it('extends AS400DataType', () => {
    expect(bin1).toBeInstanceOf(AS400DataType);
  });
});

describe('AS400Bin2', () => {
  const bin2 = new AS400Bin2();

  it('encodes 12345 big-endian', () => {
    const buf = bin2.toBuffer(12345);
    expect(buf).toEqual(Buffer.from([0x30, 0x39]));
    expect(bin2.fromBuffer(buf)).toBe(12345);
  });

  it('encodes -1', () => {
    const buf = bin2.toBuffer(-1);
    expect(buf).toEqual(Buffer.from([0xFF, 0xFF]));
    expect(bin2.fromBuffer(buf)).toBe(-1);
  });

  it('encodes max/min', () => {
    expect(bin2.fromBuffer(bin2.toBuffer(32767))).toBe(32767);
    expect(bin2.fromBuffer(bin2.toBuffer(-32768))).toBe(-32768);
  });
});

describe('AS400Bin4', () => {
  const bin4 = new AS400Bin4();

  it('encodes 12345 big-endian', () => {
    const buf = bin4.toBuffer(12345);
    expect(buf).toEqual(Buffer.from([0x00, 0x00, 0x30, 0x39]));
    expect(bin4.fromBuffer(buf)).toBe(12345);
  });

  it('round-trips edge values', () => {
    expect(bin4.fromBuffer(bin4.toBuffer(0))).toBe(0);
    expect(bin4.fromBuffer(bin4.toBuffer(-1))).toBe(-1);
    expect(bin4.fromBuffer(bin4.toBuffer(2147483647))).toBe(2147483647);
    expect(bin4.fromBuffer(bin4.toBuffer(-2147483648))).toBe(-2147483648);
  });

  it('has correct byteLength', () => {
    expect(bin4.byteLength()).toBe(4);
  });
});

describe('AS400Bin8', () => {
  const bin8 = new AS400Bin8();

  it('returns BigInt', () => {
    const val = bin8.fromBuffer(bin8.toBuffer(42));
    expect(typeof val).toBe('bigint');
    expect(val).toBe(42n);
  });

  it('handles values beyond MAX_SAFE_INTEGER', () => {
    const big = 9007199254740993n;
    const buf = bin8.toBuffer(big);
    expect(bin8.fromBuffer(buf)).toBe(big);
  });

  it('handles negative BigInt', () => {
    const val = -9007199254740993n;
    expect(bin8.fromBuffer(bin8.toBuffer(val))).toBe(val);
  });

  it('has correct byteLength', () => {
    expect(bin8.byteLength()).toBe(8);
  });
});

describe('AS400UnsignedBin1', () => {
  const u1 = new AS400UnsignedBin1();

  it('encodes 0 and 255', () => {
    expect(u1.fromBuffer(u1.toBuffer(0))).toBe(0);
    expect(u1.fromBuffer(u1.toBuffer(255))).toBe(255);
  });
});

describe('AS400UnsignedBin2', () => {
  const u2 = new AS400UnsignedBin2();

  it('encodes 0 and 65535', () => {
    expect(u2.fromBuffer(u2.toBuffer(0))).toBe(0);
    expect(u2.fromBuffer(u2.toBuffer(65535))).toBe(65535);
  });
});

describe('AS400UnsignedBin4', () => {
  const u4 = new AS400UnsignedBin4();

  it('encodes full range', () => {
    expect(u4.fromBuffer(u4.toBuffer(0))).toBe(0);
    expect(u4.fromBuffer(u4.toBuffer(4294967295))).toBe(4294967295);
  });
});

describe('AS400UnsignedBin8', () => {
  const u8 = new AS400UnsignedBin8();

  it('returns BigInt', () => {
    const val = u8.fromBuffer(u8.toBuffer(0));
    expect(typeof val).toBe('bigint');
  });

  it('handles max uint64', () => {
    const max = 18446744073709551615n;
    expect(u8.fromBuffer(u8.toBuffer(max))).toBe(max);
  });
});

describe('AS400Float4', () => {
  const f4 = new AS400Float4();

  it('round-trips float values', () => {
    const val = f4.fromBuffer(f4.toBuffer(3.14));
    expect(Math.abs(val - 3.14)).toBeLessThan(0.001);
  });

  it('encodes zero', () => {
    expect(f4.fromBuffer(f4.toBuffer(0))).toBe(0);
  });

  it('has correct byteLength', () => {
    expect(f4.byteLength()).toBe(4);
  });
});

describe('AS400Float8', () => {
  const f8 = new AS400Float8();

  it('round-trips double values exactly', () => {
    expect(f8.fromBuffer(f8.toBuffer(3.141592653589793))).toBe(3.141592653589793);
  });

  it('handles negative values', () => {
    expect(f8.fromBuffer(f8.toBuffer(-1.5))).toBe(-1.5);
  });

  it('has correct byteLength', () => {
    expect(f8.byteLength()).toBe(8);
  });
});

describe('AS400Boolean', () => {
  const bool = new AS400Boolean();

  it('encodes true as 0xF1', () => {
    const buf = bool.toBuffer(true);
    expect(buf[0]).toBe(0xF1);
  });

  it('encodes false as 0xF0', () => {
    const buf = bool.toBuffer(false);
    expect(buf[0]).toBe(0xF0);
  });

  it('decodes correctly', () => {
    expect(bool.fromBuffer(Buffer.from([0xF1]))).toBe(true);
    expect(bool.fromBuffer(Buffer.from([0xF0]))).toBe(false);
  });

  it('has correct byteLength', () => {
    expect(bool.byteLength()).toBe(1);
  });
});

describe('AS400ByteArray', () => {
  const ba = new AS400ByteArray(5);

  it('encodes and decodes raw bytes', () => {
    const input = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const buf = ba.toBuffer(input);
    expect(buf).toEqual(input);
    expect(ba.fromBuffer(buf)).toEqual(input);
  });

  it('pads short input with zeros', () => {
    const buf = ba.toBuffer(Buffer.from([0x01, 0x02]));
    expect(buf).toEqual(Buffer.from([0x01, 0x02, 0x00, 0x00, 0x00]));
  });

  it('truncates long input', () => {
    const buf = ba.toBuffer(Buffer.from([1, 2, 3, 4, 5, 6, 7]));
    expect(buf.length).toBe(5);
  });

  it('has correct byteLength', () => {
    expect(ba.byteLength()).toBe(5);
  });
});

describe('BinaryConverter', () => {
  it('intToByteArray and byteArrayToInt round-trip', () => {
    const buf = Buffer.alloc(4);
    BinaryConverter.intToByteArray(12345, buf);
    expect(BinaryConverter.byteArrayToInt(buf)).toBe(12345);
  });

  it('bytesToHex', () => {
    expect(BinaryConverter.bytesToHex(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]))).toBe('DEADBEEF');
  });

  it('hexToBytes', () => {
    expect(BinaryConverter.hexToBytes('DEADBEEF')).toEqual(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
  });
});

describe('toBytes/toObject aliases', () => {
  const bin4 = new AS400Bin4();

  it('toBytes is alias for toBuffer', () => {
    expect(bin4.toBytes(42)).toEqual(bin4.toBuffer(42));
  });

  it('toObject is alias for fromBuffer', () => {
    const buf = bin4.toBuffer(42);
    expect(bin4.toObject(buf)).toBe(bin4.fromBuffer(buf));
  });
});
