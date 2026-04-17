/**
 * Unit tests for signon protocol builders and parsers.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { SignonExchangeReq } from '../../src/auth/protocol/SignonExchangeReq.js';
import { SignonExchangeRep } from '../../src/auth/protocol/SignonExchangeRep.js';
import { GenAuthTokenReq } from '../../src/auth/protocol/GenAuthTokenReq.js';
import { GenAuthTokenRep } from '../../src/auth/protocol/GenAuthTokenRep.js';
import { ChangePasswordReq } from '../../src/auth/protocol/ChangePasswordReq.js';
import { ChangePasswordRep } from '../../src/auth/protocol/ChangePasswordRep.js';
import { ServerID } from '../../src/core/constants.js';
import { CP, AUTH_BYTES_TYPE, TOKEN_TYPE, SIGNON_EXCHANGE_ATTR_REQ } from '../../src/auth/constants.js';
import { Trace } from '../../src/core/Trace.js';

beforeEach(() => {
  Trace.reset();
});

// ── SignonExchangeReq ────────────────────────────────────────────────

describe('SignonExchangeReq', () => {
  test('builds 52-byte request for signon service', () => {
    const { buffer, clientSeed } = SignonExchangeReq.build({
      serverId: ServerID.SIGNON,
    });

    expect(buffer.length).toBe(52);
    // Total length
    expect(buffer.readUInt32BE(0)).toBe(52);
    // Server ID
    expect(buffer.readUInt16BE(6)).toBe(ServerID.SIGNON);
    // Req/Rep ID = 0x7003
    expect(buffer.readUInt16BE(18)).toBe(SIGNON_EXCHANGE_ATTR_REQ);
    // Client seed is 8 bytes
    expect(clientSeed.length).toBe(8);
  });

  test('uses provided client seed', () => {
    const seed = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22]);
    const { buffer, clientSeed } = SignonExchangeReq.build({
      serverId: ServerID.SIGNON,
      clientSeed: seed,
    });

    expect(clientSeed).toEqual(seed);
    // Seed should be at offset 44
    expect(buffer[44]).toBe(0xAA);
    expect(buffer[45]).toBe(0xBB);
  });

  test('includes client version LL/CP at offset 20', () => {
    const { buffer } = SignonExchangeReq.build({ serverId: ServerID.SIGNON });
    // LL = 10
    expect(buffer.readUInt32BE(20)).toBe(10);
    // CP = 0x1101
    expect(buffer.readUInt16BE(24)).toBe(CP.CLIENT_VERSION);
    // Version = 1
    expect(buffer.readUInt32BE(26)).toBe(1);
  });

  test('includes client level LL/CP at offset 30', () => {
    const { buffer } = SignonExchangeReq.build({ serverId: ServerID.SIGNON });
    // LL = 8
    expect(buffer.readUInt32BE(30)).toBe(8);
    // CP = 0x1102
    expect(buffer.readUInt16BE(34)).toBe(CP.CLIENT_LEVEL);
    // Level = 10 for signon
    expect(buffer.readUInt16BE(36)).toBe(10);
  });

  test('includes client seed LL/CP at offset 38', () => {
    const { buffer } = SignonExchangeReq.build({ serverId: ServerID.SIGNON });
    // LL = 14
    expect(buffer.readUInt32BE(38)).toBe(14);
    // CP = 0x1103
    expect(buffer.readUInt16BE(42)).toBe(CP.CLIENT_SEED);
  });
});

// ── SignonExchangeRep ────────────────────────────────────────────────

describe('SignonExchangeRep', () => {
  function buildMockReply(opts = {}) {
    const {
      returnCode = 0,
      serverVersion = 0x00070400,
      serverLevel = 18,
      serverSeed = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      passwordLevel = 2,
      aafIndicator = false,
    } = opts;

    // Fixed structure: header(20) + RC(4) + version LL/CP(10) + level LL/CP(8) = 42
    // Variable: seed(14) + pwdLevel(7) + optional AAF(7)
    const variableSize = 14 + 7 + (aafIndicator ? 7 : 0);
    const totalLen = 42 + variableSize;
    const buf = Buffer.alloc(totalLen);

    // Header
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(ServerID.SIGNON, 6);
    buf.writeUInt16BE(0xF003, 18);

    // Return code at offset 20
    buf.writeUInt32BE(returnCode, 20);

    // Server version LL/CP at offset 24
    buf.writeUInt32BE(10, 24);
    buf.writeUInt16BE(CP.CLIENT_VERSION, 28);
    buf.writeUInt32BE(serverVersion, 30);

    // Server level LL/CP at offset 34
    buf.writeUInt32BE(8, 34);
    buf.writeUInt16BE(CP.CLIENT_LEVEL, 38);
    buf.writeUInt16BE(serverLevel, 40);

    let offset = 42;

    // Server seed: LL=14, CP=0x1103
    buf.writeUInt32BE(14, offset);
    buf.writeUInt16BE(CP.CLIENT_SEED, offset + 4);
    serverSeed.copy(buf, offset + 6, 0, 8);
    offset += 14;

    // Password level: LL=7, CP=0x1119
    buf.writeUInt32BE(7, offset);
    buf.writeUInt16BE(CP.PASSWORD_LEVEL, offset + 4);
    buf[offset + 6] = passwordLevel;
    offset += 7;

    // AAF indicator: LL=7, CP=0x112E
    if (aafIndicator) {
      buf.writeUInt32BE(7, offset);
      buf.writeUInt16BE(CP.AAF_INDICATOR, offset + 4);
      buf[offset + 6] = 0x01;
      offset += 7;
    }

    return buf;
  }

  test('parses successful reply', () => {
    const buf = buildMockReply();
    const result = SignonExchangeRep.parse(buf);

    expect(result.returnCode).toBe(0);
    expect(result.serverVersion).toBe(0x00070400);
    expect(result.serverLevel).toBe(18);
    expect(result.passwordLevel).toBe(2);
    expect(result.serverSeed).not.toBeNull();
    expect(result.serverSeed.length).toBe(8);
    expect(result.aafIndicator).toBe(false);
  });

  test('extracts server seed correctly', () => {
    const seed = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22]);
    const result = SignonExchangeRep.parse(buildMockReply({ serverSeed: seed }));

    expect(result.serverSeed[0]).toBe(0xAA);
    expect(result.serverSeed[7]).toBe(0x22);
  });

  test('detects AAF indicator', () => {
    const result = SignonExchangeRep.parse(buildMockReply({ aafIndicator: true }));
    expect(result.aafIndicator).toBe(true);
  });

  test('throws on non-zero return code', () => {
    expect(() => {
      SignonExchangeRep.parse(buildMockReply({ returnCode: 0x00010001 }));
    }).toThrow(/Exchange attributes failed/);
  });

  test('throws on short buffer', () => {
    expect(() => {
      SignonExchangeRep.parse(Buffer.alloc(20));
    }).toThrow(/too short/);
  });
});

// ── GenAuthTokenReq ──────────────────────────────────────────────────

describe('GenAuthTokenReq', () => {
  test('builds request with all required fields', () => {
    const authBytes = new Uint8Array(20); // SHA-1 length
    const userIdBytes = new Uint8Array(10);
    userIdBytes.fill(0x40);

    const buf = GenAuthTokenReq.build({
      serverId: ServerID.SIGNON,
      authenticationBytes: authBytes,
      authBytesType: AUTH_BYTES_TYPE.SHA1,
      tokenType: TOKEN_TYPE.MULTIPLE_USE_RENEWABLE,
      timeoutInterval: 3600,
      userIdBytes,
    });

    expect(buf.length).toBeGreaterThan(20);
    // Header total length
    expect(buf.readUInt32BE(0)).toBe(buf.length);
    // Server ID
    expect(buf.readUInt16BE(6)).toBe(ServerID.SIGNON);
    // Template: auth bytes type
    expect(buf[20]).toBe(AUTH_BYTES_TYPE.SHA1);
  });
});

// ── GenAuthTokenRep ──────────────────────────────────────────────────

describe('GenAuthTokenRep', () => {
  test('parses successful reply with profile token', () => {
    const buf = Buffer.alloc(62);
    buf.writeUInt32BE(62, 0);
    buf.writeUInt16BE(ServerID.SIGNON, 6);
    buf.writeUInt32BE(0, 20); // RC = 0
    // Profile token at offset 30, 32 bytes
    for (let i = 0; i < 32; i++) {
      buf[30 + i] = 0xAA + i;
    }

    const result = GenAuthTokenRep.parse(buf);
    expect(result.returnCode).toBe(0);
    expect(result.profileToken).not.toBeNull();
    expect(result.profileToken.length).toBe(32);
    expect(result.profileToken[0]).toBe(0xAA);
  });

  test('throws on non-zero return code', () => {
    const buf = Buffer.alloc(62);
    buf.writeUInt32BE(62, 0);
    buf.writeUInt32BE(0x0001000E, 20); // TOKEN_NOT_VALID

    expect(() => GenAuthTokenRep.parse(buf)).toThrow(/Generate auth token failed/);
  });

  test('throws on short buffer', () => {
    expect(() => GenAuthTokenRep.parse(Buffer.alloc(20))).toThrow(/too short/);
  });
});

// ── ChangePasswordRep ────────────────────────────────────────────────

describe('ChangePasswordRep', () => {
  test('parses successful reply', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.writeUInt32BE(0, 20); // RC = 0

    const result = ChangePasswordRep.parse(buf);
    expect(result.returnCode).toBe(0);
  });

  test('throws on non-zero return code', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.writeUInt32BE(0x00030001, 20); // OLD_NOT_VALID

    expect(() => ChangePasswordRep.parse(buf)).toThrow(/Change password failed/);
  });

  test('throws on short buffer', () => {
    expect(() => ChangePasswordRep.parse(Buffer.alloc(20))).toThrow(/too short/);
  });
});

// ── ChangePasswordReq ────────────────────────────────────────────────

describe('ChangePasswordReq', () => {
  test('builds DES-level request', () => {
    const userIdBytes = new Uint8Array(10);
    userIdBytes.fill(0x40);
    const encryptedPw = new Uint8Array(8);
    const protectedOld = new Uint8Array(8);
    const protectedNew = new Uint8Array(8);

    const buf = ChangePasswordReq.build({
      serverId: ServerID.SIGNON,
      userIdBytes,
      encryptedPassword: encryptedPw,
      protectedOldPassword: protectedOld,
      protectedNewPassword: protectedNew,
      passwordLevel: 0,
    });

    expect(buf.length).toBeGreaterThan(20);
    expect(buf.readUInt32BE(0)).toBe(buf.length);
    expect(buf[20]).toBe(AUTH_BYTES_TYPE.DES);
  });

  test('builds SHA-1-level request with length/CCSID fields', () => {
    const userIdBytes = new Uint8Array(10);
    userIdBytes.fill(0x40);
    const encryptedPw = new Uint8Array(20);
    const protectedOld = new Uint8Array(16); // UTF-16BE for 8-char password
    const protectedNew = new Uint8Array(20); // UTF-16BE for 10-char password

    const buf = ChangePasswordReq.build({
      serverId: ServerID.SIGNON,
      userIdBytes,
      encryptedPassword: encryptedPw,
      protectedOldPassword: protectedOld,
      protectedNewPassword: protectedNew,
      passwordLevel: 2,
      oldPasswordLength: 8,
      newPasswordLength: 10,
    });

    expect(buf.length).toBeGreaterThan(20);
    // SHA-1 auth type byte
    expect(buf[20]).toBe(AUTH_BYTES_TYPE.SHA1);
  });
});
