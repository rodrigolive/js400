/**
 * Tests for CCSID conversion and CharConverter.
 */

import { describe, it, expect } from 'bun:test';
import { CharConverter } from '../../src/ccsid/CharConverter.js';
import { ConvTable, ConvTableUtf8, ConvTableUtf16, ConvTableBinary } from '../../src/ccsid/ConvTable.js';

describe('CharConverter CCSID 37', () => {
  const conv = new CharConverter(37);

  it('round-trips ASCII printable characters', () => {
    const input = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const ebcdic = conv.stringToByteArray(input);
    const result = conv.byteArrayToString(ebcdic);
    expect(result).toBe(input);
  });

  it('round-trips digits', () => {
    const input = '0123456789';
    const result = conv.byteArrayToString(conv.stringToByteArray(input));
    expect(result).toBe(input);
  });

  it('round-trips lowercase', () => {
    const input = 'abcdefghijklmnopqrstuvwxyz';
    const result = conv.byteArrayToString(conv.stringToByteArray(input));
    expect(result).toBe(input);
  });

  it('round-trips special characters', () => {
    const input = '!@#$%^&*()';
    const result = conv.byteArrayToString(conv.stringToByteArray(input));
    expect(result).toBe(input);
  });

  it('encodes space as 0x40', () => {
    const ebcdic = conv.stringToByteArray(' ');
    expect(ebcdic[0]).toBe(0x40);
  });

  it('encodes A as 0xC1', () => {
    const ebcdic = conv.stringToByteArray('A');
    expect(ebcdic[0]).toBe(0xC1);
  });

  it('encodes 0 as 0xF0', () => {
    const ebcdic = conv.stringToByteArray('0');
    expect(ebcdic[0]).toBe(0xF0);
  });

  it('decodes EBCDIC HELLO', () => {
    // HELLO in CCSID 37: C8 C5 D3 D3 D6
    const buf = Buffer.from([0xC8, 0xC5, 0xD3, 0xD3, 0xD6]);
    expect(conv.byteArrayToString(buf)).toBe('HELLO');
  });
});

describe('CharConverter CCSID 500', () => {
  const conv = new CharConverter(500);

  it('round-trips text', () => {
    const input = 'HELLO WORLD';
    const result = conv.byteArrayToString(conv.stringToByteArray(input));
    expect(result).toBe(input);
  });
});

describe('CharConverter CCSID 1140 (Euro-aware)', () => {
  const conv = new CharConverter(1140);

  it('round-trips basic ASCII', () => {
    const input = 'TEST123';
    const result = conv.byteArrayToString(conv.stringToByteArray(input));
    expect(result).toBe(input);
  });
});

describe('CharConverter UTF-8 (CCSID 1208)', () => {
  const conv = new CharConverter(1208);

  it('round-trips ASCII', () => {
    const input = 'Hello, World!';
    const result = conv.byteArrayToString(conv.stringToByteArray(input));
    expect(result).toBe(input);
  });

  it('round-trips multi-byte characters', () => {
    const input = 'Hllo Wrld';
    const ebcdic = conv.stringToByteArray(input);
    expect(conv.byteArrayToString(ebcdic)).toBe(input);
  });
});

describe('CharConverter UTF-16 (CCSID 1200)', () => {
  const conv = new CharConverter(1200);

  it('round-trips text', () => {
    const input = 'Hello';
    const result = conv.byteArrayToString(conv.stringToByteArray(input));
    expect(result).toBe(input);
  });

  it('encodes in big-endian', () => {
    const buf = conv.stringToByteArray('A');
    expect(buf[0]).toBe(0x00);
    expect(buf[1]).toBe(0x41);
  });
});

describe('CharConverter binary (CCSID 65535)', () => {
  const conv = new CharConverter(65535);

  it('passes through bytes', () => {
    const input = 'test';
    const buf = conv.stringToByteArray(input);
    expect(conv.byteArrayToString(buf)).toBe(input);
  });
});

describe('CharConverter static methods', () => {
  it('isSupported returns true for CCSID 37', () => {
    expect(CharConverter.isSupported(37)).toBe(true);
  });

  it('isSupported returns true for CCSID 1208', () => {
    expect(CharConverter.isSupported(1208)).toBe(true);
  });

  it('isSupported returns false for unknown CCSID', () => {
    expect(CharConverter.isSupported(99999)).toBe(false);
  });

  it('static byteArrayToString works', () => {
    const buf = Buffer.from([0xC8, 0xC5, 0xD3, 0xD3, 0xD6]);
    expect(CharConverter.byteArrayToString(buf, 0, 5, 37)).toBe('HELLO');
  });

  it('static stringToByteArray works', () => {
    const buf = CharConverter.stringToByteArray('A', 37);
    expect(buf[0]).toBe(0xC1);
  });
});

describe('CCSID table determinism', () => {
  it('same CCSID produces same converter', () => {
    const conv1 = new CharConverter(37);
    const conv2 = new CharConverter(37);
    const input = 'DETERMINISM TEST';
    expect(conv1.stringToByteArray(input)).toEqual(conv2.stringToByteArray(input));
  });
});

describe('Major EBCDIC code pages round-trip', () => {
  const testCcsids = [37, 273, 277, 278, 280, 284, 285, 297, 500, 871, 1140, 1141, 1142, 1143, 1144, 1145, 1146, 1147, 1148, 1149];

  for (const ccsid of testCcsids) {
    it(`CCSID ${ccsid} round-trips A-Z`, () => {
      const conv = new CharConverter(ccsid);
      const input = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const result = conv.byteArrayToString(conv.stringToByteArray(input));
      expect(result).toBe(input);
    });

    it(`CCSID ${ccsid} round-trips 0-9`, () => {
      const conv = new CharConverter(ccsid);
      const input = '0123456789';
      const result = conv.byteArrayToString(conv.stringToByteArray(input));
      expect(result).toBe(input);
    });
  }
});
