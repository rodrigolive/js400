/**
 * Unit tests for password encryption (all levels) and EBCDIC conversion.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  encryptPassword,
  encryptPasswordDES,
  encryptPasswordSHA1,
  encryptPasswordSHA512,
  stringToEbcdic,
  ebcdicToString,
  protectPassword,
} from '../../src/auth/password-encrypt.js';
import { Trace } from '../../src/core/Trace.js';

beforeEach(() => {
  Trace.reset();
});

// ── EBCDIC Conversion ────────────────────────────────────────────────

describe('stringToEbcdic', () => {
  test('converts uppercase letters correctly', () => {
    const result = stringToEbcdic('MYUSER', true);
    expect(result.length).toBe(10);
    // M=0xD4, Y=0xE8, U=0xE4, S=0xE2, E=0xC5, R=0xD9
    expect(result[0]).toBe(0xD4);
    expect(result[1]).toBe(0xE8);
    expect(result[2]).toBe(0xE4);
    expect(result[3]).toBe(0xE2);
    expect(result[4]).toBe(0xC5);
    expect(result[5]).toBe(0xD9);
    // padding with 0x40
    expect(result[6]).toBe(0x40);
    expect(result[9]).toBe(0x40);
  });

  test('converts digits correctly', () => {
    const result = stringToEbcdic('USER01', true);
    // 0=0xF0, 1=0xF1
    expect(result[4]).toBe(0xF0);
    expect(result[5]).toBe(0xF1);
  });

  test('uppercases when requested', () => {
    const result = stringToEbcdic('myuser', true);
    // Should be same as uppercase
    expect(result[0]).toBe(0xD4); // M
    expect(result[1]).toBe(0xE8); // Y
  });

  test('preserves case when not uppercasing', () => {
    const result = stringToEbcdic('myPass', false);
    // m=0x94, y=0xA8 (lowercase)
    expect(result[0]).toBe(0x94);
    expect(result[1]).toBe(0xA8);
    // P=0xD7 (uppercase)
    expect(result[2]).toBe(0xD7);
  });

  test('pads to 10 bytes with EBCDIC blank (0x40)', () => {
    const result = stringToEbcdic('AB', true);
    expect(result.length).toBe(10);
    expect(result[0]).toBe(0xC1); // A
    expect(result[1]).toBe(0xC2); // B
    for (let i = 2; i < 10; i++) {
      expect(result[i]).toBe(0x40);
    }
  });

  test('handles special chars: $ _ # @', () => {
    const result = stringToEbcdic('$_#@', false);
    expect(result[0]).toBe(0x5B); // $
    expect(result[1]).toBe(0x6D); // _
    expect(result[2]).toBe(0x7B); // #
    expect(result[3]).toBe(0x7C); // @
  });

  test('throws on invalid character', () => {
    expect(() => stringToEbcdic('USER\u0001', false)).toThrow('Signon character not valid');
  });

  test('handles full 10-character user ID', () => {
    const result = stringToEbcdic('ABCDEFGHIJ', true);
    expect(result.length).toBe(10);
    expect(result[0]).toBe(0xC1); // A
    expect(result[9]).toBe(0xD1); // J
  });
});

describe('ebcdicToString', () => {
  test('converts back to string', () => {
    const ebcdic = stringToEbcdic('MYUSER', true);
    const str = ebcdicToString(ebcdic);
    expect(str).toBe('MYUSER');
  });

  test('stops at EBCDIC blank', () => {
    const ebcdic = stringToEbcdic('AB', true);
    const str = ebcdicToString(ebcdic);
    expect(str).toBe('AB');
  });

  test('round-trips special characters', () => {
    const ebcdic = stringToEbcdic('A$B#', false);
    const str = ebcdicToString(ebcdic);
    expect(str).toBe('A$B#');
  });
});

// ── DES Encryption (Level 0/1) ──────────────────────────────────────

describe('encryptPasswordDES', () => {
  test('produces 8-byte result', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const result = encryptPasswordDES('MYUSER', 'MYPASS', clientSeed, serverSeed);
    expect(result.length).toBe(8);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  test('different passwords produce different results', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const r1 = encryptPasswordDES('MYUSER', 'PASS1', clientSeed, serverSeed);
    const r2 = encryptPasswordDES('MYUSER', 'PASS2', clientSeed, serverSeed);

    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(false);
  });

  test('different seeds produce different results', () => {
    const clientSeed1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const clientSeed2 = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const r1 = encryptPasswordDES('MYUSER', 'MYPASS', clientSeed1, serverSeed);
    const r2 = encryptPasswordDES('MYUSER', 'MYPASS', clientSeed2, serverSeed);

    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(false);
  });

  test('same inputs produce same result (deterministic)', () => {
    const clientSeed = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22]);
    const serverSeed = new Uint8Array([0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00]);

    const r1 = encryptPasswordDES('TESTUSER', 'TESTPWD', clientSeed, serverSeed);
    const r2 = encryptPasswordDES('TESTUSER', 'TESTPWD', clientSeed, serverSeed);

    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(true);
  });

  test('handles user IDs longer than 8 chars (folding)', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const result = encryptPasswordDES('LONGUSRID1', 'MYPASS', clientSeed, serverSeed);
    expect(result.length).toBe(8);
  });

  test('handles passwords longer than 8 chars (splitting)', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const result = encryptPasswordDES('MYUSER', 'LONGPASSW9', clientSeed, serverSeed);
    expect(result.length).toBe(8);
  });
});

// ── SHA-1 Encryption (Level 2) ──────────────────────────────────────

describe('encryptPasswordSHA1', () => {
  test('produces 20-byte result', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const result = encryptPasswordSHA1('MYUSER', 'MYPASS', clientSeed, serverSeed);
    expect(result.length).toBe(20);
  });

  test('is deterministic', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const r1 = encryptPasswordSHA1('MYUSER', 'myPass', clientSeed, serverSeed);
    const r2 = encryptPasswordSHA1('MYUSER', 'myPass', clientSeed, serverSeed);

    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(true);
  });

  test('different passwords produce different results', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const r1 = encryptPasswordSHA1('MYUSER', 'PASS1', clientSeed, serverSeed);
    const r2 = encryptPasswordSHA1('MYUSER', 'PASS2', clientSeed, serverSeed);

    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(false);
  });
});

// ── SHA-512 Encryption (Level 3/4) ──────────────────────────────────

describe('encryptPasswordSHA512', () => {
  test('produces 64-byte result', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const result = encryptPasswordSHA512('MYUSER', 'MYPASS', clientSeed, serverSeed);
    expect(result.length).toBe(64);
  });

  test('is deterministic', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const r1 = encryptPasswordSHA512('MYUSER', 'myPass', clientSeed, serverSeed);
    const r2 = encryptPasswordSHA512('MYUSER', 'myPass', clientSeed, serverSeed);

    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(true);
  });

  test('different passwords produce different results', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const r1 = encryptPasswordSHA512('MYUSER', 'PASS1', clientSeed, serverSeed);
    const r2 = encryptPasswordSHA512('MYUSER', 'PASS2', clientSeed, serverSeed);

    expect(Buffer.from(r1).equals(Buffer.from(r2))).toBe(false);
  });
});

// ── encryptPassword (dispatch) ──────────────────────────────────────

describe('encryptPassword', () => {
  const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

  test('dispatches to DES for level 0', () => {
    const result = encryptPassword({
      userId: 'MYUSER', password: 'MYPASS',
      clientSeed, serverSeed, passwordLevel: 0,
    });
    expect(result.length).toBe(8);
  });

  test('dispatches to DES for level 1', () => {
    const result = encryptPassword({
      userId: 'MYUSER', password: 'MYPASS',
      clientSeed, serverSeed, passwordLevel: 1,
    });
    expect(result.length).toBe(8);
  });

  test('dispatches to SHA-1 for level 2', () => {
    const result = encryptPassword({
      userId: 'MYUSER', password: 'MYPASS',
      clientSeed, serverSeed, passwordLevel: 2,
    });
    expect(result.length).toBe(20);
  });

  test('dispatches to SHA-512 for level 3', () => {
    const result = encryptPassword({
      userId: 'MYUSER', password: 'MYPASS',
      clientSeed, serverSeed, passwordLevel: 3,
    });
    expect(result.length).toBe(64);
  });

  test('dispatches to SHA-512 for level 4', () => {
    const result = encryptPassword({
      userId: 'MYUSER', password: 'MYPASS',
      clientSeed, serverSeed, passwordLevel: 4,
    });
    expect(result.length).toBe(64);
  });
});

// ── protectPassword ─────────────────────────────────────────────────

describe('protectPassword', () => {
  test('DES level produces 8-byte XOR result', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const result = protectPassword('MYPASS', clientSeed, serverSeed, 0);
    expect(result.length).toBe(8);
  });

  test('SHA level returns UTF-16BE', () => {
    const clientSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverSeed = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

    const result = protectPassword('test', clientSeed, serverSeed, 2);
    expect(result.length).toBe(8); // 4 chars * 2 bytes each
    // UTF-16BE for 't' = 0x0074
    expect(result[0]).toBe(0x00);
    expect(result[1]).toBe(0x74);
  });
});
