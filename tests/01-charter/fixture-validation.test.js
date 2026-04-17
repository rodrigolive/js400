/**
 * Fixture validation tests — verify that fixture data matches
 * actual encoder/decoder output from the library.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AS400PackedDecimal, AS400ZonedDecimal } from '../../src/datatypes/index.js';
import {
  encryptPasswordDES,
  encryptPasswordSHA1,
  stringToEbcdic,
} from '../../src/auth/password-encrypt.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

describe('packed decimal fixture validation', () => {
  const data = JSON.parse(readFileSync(join(FIXTURES, 'datatypes', 'packed-decimal.json'), 'utf8'));

  for (const v of data.vectors) {
    test(`packed(${v.numDigits},${v.numDecimalPositions}) value=${v.value}`, () => {
      const pd = new AS400PackedDecimal(v.numDigits, v.numDecimalPositions);
      const buf = pd.toBuffer(v.value);
      const expectedBuf = Buffer.from(v.bytes);

      expect(buf.length).toBe(expectedBuf.length);
      expect(Buffer.from(buf).equals(expectedBuf)).toBe(true);

      // Also verify round-trip decode
      const decoded = pd.fromBuffer(buf);
      const normalizedValue = v.value.replace(/^(-?)0+(?=\d)/, '$1');
      expect(decoded).toBe(normalizedValue);
    });
  }
});

describe('zoned decimal fixture validation', () => {
  const data = JSON.parse(readFileSync(join(FIXTURES, 'datatypes', 'zoned-decimal.json'), 'utf8'));

  for (const v of data.vectors) {
    test(`zoned(${v.numDigits},${v.numDecimalPositions}) value=${v.value}`, () => {
      const zd = new AS400ZonedDecimal(v.numDigits, v.numDecimalPositions);
      const buf = zd.toBuffer(v.value);
      const expectedBuf = Buffer.from(v.bytes);

      expect(buf.length).toBe(expectedBuf.length);
      expect(Buffer.from(buf).equals(expectedBuf)).toBe(true);

      // Verify round-trip
      const decoded = zd.fromBuffer(buf);
      const normalizedValue = v.value.replace(/^(-?)0+(?=\d)/, '$1');
      expect(decoded).toBe(normalizedValue);
    });
  }
});

describe('password encryption fixture validation', () => {
  test('DES (Level 0) matches fixture vector', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'auth', 'password-level0-vector.json'), 'utf8'));

    const result = encryptPasswordDES(
      data.userId,
      data.password,
      new Uint8Array(data.clientSeed),
      new Uint8Array(data.serverSeed),
    );

    expect(result.length).toBe(data.expectedLength);
    expect(Array.from(result)).toEqual(data.expected);
  });

  test('SHA-1 (Level 2) matches fixture vector', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'auth', 'password-level2-vector.json'), 'utf8'));

    const result = encryptPasswordSHA1(
      data.userId,
      data.password,
      new Uint8Array(data.clientSeed),
      new Uint8Array(data.serverSeed),
    );

    expect(result.length).toBe(data.expectedLength);
    expect(Array.from(result)).toEqual(data.expected);
  });

  test('EBCDIC user ID matches fixture', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'auth', 'password-level0-vector.json'), 'utf8'));
    const ebcdic = stringToEbcdic(data.userId, true);
    expect(Array.from(ebcdic)).toEqual(data.userIdEbcdic);
  });
});

describe('CCSID 37 fixture validation', () => {
  test('EBCDIC signon converter matches fixture vectors', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'ccsid', 'ccsid37-roundtrip.json'), 'utf8'));

    // stringToEbcdic only handles the signon character subset and pads to 10
    // We test the vectors that fit within 10 chars
    for (const v of data.vectors) {
      if (v.unicode.length <= 10) {
        const ebcdic = stringToEbcdic(v.unicode, false);
        for (let i = 0; i < v.ebcdic.length; i++) {
          expect(ebcdic[i]).toBe(v.ebcdic[i]);
        }
      }
    }
  });
});
