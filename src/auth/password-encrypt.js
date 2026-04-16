/**
 * Password encryption helpers for all three IBM i password levels.
 *
 * Level 0/1: Custom DES-based encryption (8-byte result)
 * Level 2:   SHA-1 based encryption (20-byte result)
 * Level 3/4: SHA-512 based encryption (64-byte result)
 *
 * Upstream: EncryptPassword.java, SignonConverter.java
 * @module auth/password-encrypt
 */

import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { EBCDIC_BLANK } from './constants.js';

// ── EBCDIC Signon Converter ─────────────────────────────────────────

/**
 * Unicode → EBCDIC CCSID 37 mapping for valid signon characters.
 * Upstream: SignonConverter.java charArrayToByteArray()
 */
const UNICODE_TO_EBCDIC = new Map([
  [0x0020, 0x40], // space
  [0x0021, 0x5A], // !
  [0x0022, 0x7F], // "
  [0x0023, 0x7B], // #
  [0x0024, 0x5B], // $
  [0x0025, 0x6C], // %
  [0x0026, 0x50], // &
  [0x0027, 0x7D], // '
  [0x0028, 0x4D], // (
  [0x0029, 0x5D], // )
  [0x002A, 0x5C], // *
  [0x002B, 0x4E], // +
  [0x002C, 0x6B], // ,
  [0x002D, 0x60], // -
  [0x002E, 0x4B], // .
  [0x002F, 0x61], // /
  [0x0030, 0xF0], // 0
  [0x0031, 0xF1], // 1
  [0x0032, 0xF2], // 2
  [0x0033, 0xF3], // 3
  [0x0034, 0xF4], // 4
  [0x0035, 0xF5], // 5
  [0x0036, 0xF6], // 6
  [0x0037, 0xF7], // 7
  [0x0038, 0xF8], // 8
  [0x0039, 0xF9], // 9
  [0x003A, 0x7A], // :
  [0x003B, 0x5E], // ;
  [0x003C, 0x4C], // <
  [0x003D, 0x7E], // =
  [0x003E, 0x6E], // >
  [0x003F, 0x6F], // ?
  [0x0040, 0x7C], // @
  [0x0041, 0xC1], // A
  [0x0042, 0xC2], // B
  [0x0043, 0xC3], // C
  [0x0044, 0xC4], // D
  [0x0045, 0xC5], // E
  [0x0046, 0xC6], // F
  [0x0047, 0xC7], // G
  [0x0048, 0xC8], // H
  [0x0049, 0xC9], // I
  [0x004A, 0xD1], // J
  [0x004B, 0xD2], // K
  [0x004C, 0xD3], // L
  [0x004D, 0xD4], // M
  [0x004E, 0xD5], // N
  [0x004F, 0xD6], // O
  [0x0050, 0xD7], // P
  [0x0051, 0xD8], // Q
  [0x0052, 0xD9], // R
  [0x0053, 0xE2], // S
  [0x0054, 0xE3], // T
  [0x0055, 0xE4], // U
  [0x0056, 0xE5], // V
  [0x0057, 0xE6], // W
  [0x0058, 0xE7], // X
  [0x0059, 0xE8], // Y
  [0x005A, 0xE9], // Z
  [0x005F, 0x6D], // _
  [0x0061, 0x81], // a
  [0x0062, 0x82], // b
  [0x0063, 0x83], // c
  [0x0064, 0x84], // d
  [0x0065, 0x85], // e
  [0x0066, 0x86], // f
  [0x0067, 0x87], // g
  [0x0068, 0x88], // h
  [0x0069, 0x89], // i
  [0x006A, 0x91], // j
  [0x006B, 0x92], // k
  [0x006C, 0x93], // l
  [0x006D, 0x94], // m
  [0x006E, 0x95], // n
  [0x006F, 0x96], // o
  [0x0070, 0x97], // p
  [0x0071, 0x98], // q
  [0x0072, 0x99], // r
  [0x0073, 0xA2], // s
  [0x0074, 0xA3], // t
  [0x0075, 0xA4], // u
  [0x0076, 0xA5], // v
  [0x0077, 0xA6], // w
  [0x0078, 0xA7], // x
  [0x0079, 0xA8], // y
  [0x007A, 0xA9], // z
  // Special national characters mapped to #/$/@
  [0x00A3, 0x7B], // pound sterling → #
  [0x00A5, 0x5B], // yen sign → $
  [0x00A7, 0x7C], // section sign → @
  [0x00C4, 0x7B], // A with dieresis → #
  [0x00C5, 0x5B], // A with ring → $
  [0x00C6, 0x7B], // ligature AE → #
  [0x00D0, 0x7C], // D with stroke → @
  [0x00D1, 0x7B], // N with tilde → #
  [0x00D6, 0x7C], // O with dieresis → @
  [0x00D8, 0x7C], // O with stroke → @
  [0x00E0, 0x7C], // a with grave → @
  [0x0130, 0x5B], // I with over dot → $
  [0x015E, 0x7C], // S with cedilla → @
]);

/**
 * Convert a Unicode string to a 10-byte EBCDIC buffer, padded with 0x40.
 * User IDs are uppercased before conversion.
 *
 * @param {string} str - Unicode string
 * @param {boolean} [upperCase=false] - Whether to uppercase before conversion
 * @returns {Uint8Array} 10-byte EBCDIC buffer
 */
export function stringToEbcdic(str, upperCase = false) {
  const src = upperCase ? str.toUpperCase() : str;
  const buf = new Uint8Array(10);
  buf.fill(EBCDIC_BLANK);
  for (let i = 0; i < src.length && i < 10; i++) {
    const code = src.charCodeAt(i);
    const eb = UNICODE_TO_EBCDIC.get(code);
    if (eb === undefined) {
      throw new Error(`Signon character not valid: U+${code.toString(16).padStart(4, '0')}`);
    }
    buf[i] = eb;
  }
  return buf;
}

/**
 * Convert a 10-byte EBCDIC buffer back to a Unicode string, trimmed.
 *
 * @param {Uint8Array} buf - 10-byte EBCDIC buffer
 * @returns {string}
 */
export function ebcdicToString(buf) {
  // Build reverse map on first call
  if (!ebcdicToString._reverseMap) {
    ebcdicToString._reverseMap = new Map();
    for (const [uni, ebc] of UNICODE_TO_EBCDIC) {
      if (!ebcdicToString._reverseMap.has(ebc)) {
        ebcdicToString._reverseMap.set(ebc, uni);
      }
    }
  }
  const chars = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] & 0xFF;
    if (b === EBCDIC_BLANK) break;
    const uni = ebcdicToString._reverseMap.get(b);
    if (uni !== undefined) {
      chars.push(String.fromCharCode(uni));
    }
  }
  return chars.join('');
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Encrypt a password for the given password level.
 *
 * @param {object} opts
 * @param {string} opts.userId - User ID string
 * @param {string} opts.password - Password string
 * @param {Uint8Array} opts.clientSeed - 8-byte client seed
 * @param {Uint8Array} opts.serverSeed - 8-byte server seed
 * @param {number} opts.passwordLevel - 0, 1, 2, 3, or 4
 * @returns {Uint8Array} Encrypted password (8, 20, or 64 bytes)
 */
export function encryptPassword(opts) {
  const { userId, password, clientSeed, serverSeed, passwordLevel } = opts;

  if (passwordLevel <= 1) {
    return encryptPasswordDES(userId, password, clientSeed, serverSeed);
  }
  // Levels 2 AND 3 both use SHA-1 (per JTOpen: passwordLevel_ < 4)
  if (passwordLevel < 4) {
    return encryptPasswordSHA1(userId, password, clientSeed, serverSeed);
  }
  // Only level 4 uses PBKDF2 + SHA-512
  return encryptPasswordSHA512(userId, password, clientSeed, serverSeed);
}

// ── SHA-1 (Level 2/3) ────────────────────────────────────────────────

/**
 * SHA-1 password encryption for password level 2 or 3.
 * Produces a 20-byte encrypted password.
 *
 * Per JTOpen (AS400ImplRemote.java), both levels 2 and 3 use SHA-1.
 * The user ID and password are both in UTF-16BE encoding for the hash.
 *
 * Algorithm:
 *   token = SHA1(userID_UTF16BE + password_UTF16BE)
 *   result = SHA1(token + serverSeed + clientSeed + userID_UTF16BE + [0,0,0,0,0,0,0,1])
 *
 * @param {string} userId
 * @param {string} password
 * @param {Uint8Array} clientSeed
 * @param {Uint8Array} serverSeed
 * @returns {Uint8Array}
 */
export function encryptPasswordSHA1(userId, password, clientSeed, serverSeed) {
  const userIdUtf16 = toUserIdUTF16BE(userId);
  const passwordUtf16 = toUTF16BE(password);
  const sequence = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);

  const md1 = createHash('sha1');
  md1.update(userIdUtf16);
  md1.update(passwordUtf16);
  const token = md1.digest();

  const md2 = createHash('sha1');
  md2.update(token);
  md2.update(Buffer.from(serverSeed));
  md2.update(Buffer.from(clientSeed));
  md2.update(userIdUtf16);
  md2.update(sequence);
  return new Uint8Array(md2.digest());
}

// ── SHA-512 / PBKDF2 (Level 4) ──────────────────────────────────────

/**
 * SHA-512 password encryption for password level 4 (QPWDLVL 4).
 * Produces a 64-byte encrypted password.
 *
 * Per JTOpen (AS400ImplRemote.java generatePwdTokenForPasswordLevel4):
 *   1. Build salt: SHA-256 of 28-byte buffer (10-char userId + last 4 chars password, UTF-16BE)
 *   2. Token: PBKDF2-HMAC-SHA512(password, salt, 10022 iterations, 64 bytes)
 *   3. Result: SHA-512(token + serverSeed + clientSeed + userId_UTF16BE + sequence)
 *
 * @param {string} userId
 * @param {string} password
 * @param {Uint8Array} clientSeed
 * @param {Uint8Array} serverSeed
 * @returns {Uint8Array}
 */
export function encryptPasswordSHA512(userId, password, clientSeed, serverSeed) {
  const sequence = Buffer.alloc(8);
  sequence[7] = 0x01;

  const token = generatePwdTokenLevel4(userId, password);
  return generateSha512Substitute(userId, token, serverSeed, clientSeed, sequence);
}

/**
 * Generate PBKDF2-based password token for level 4.
 * Upstream: AS400ImplRemote.generatePwdTokenForPasswordLevel4()
 */
function generatePwdTokenLevel4(userId, password) {
  const salt = generateSaltLevel4(userId, password);
  const passwordUtf16 = toUTF16BE(password);
  return pbkdf2Sync(passwordUtf16, salt, 10022, 64, 'sha512');
}

/**
 * Generate salt for level 4 password encryption.
 * Upstream: AS400ImplRemote.generateSaltForPasswordLevel4()
 *
 * Builds a 14-character (28-byte UTF-16BE) buffer:
 *   - First 10 chars: userId uppercased, blank-padded to 10
 *   - Last 4 chars: last 4 chars of password, blank-padded to 4
 * Then SHA-256 hashes it to produce a 32-byte salt.
 */
function generateSaltLevel4(userId, password) {
  // 14 characters = 28 bytes UTF-16BE
  const saltChars = new Array(14);
  const upper = userId.toUpperCase();
  // First 10: userId padded with spaces
  for (let i = 0; i < 10; i++) {
    saltChars[i] = i < upper.length ? upper.charCodeAt(i) : 0x0020;
  }
  // Last 4: last 4 chars of password, padded with spaces
  const pwEnd = password.length;
  const pwStart = Math.max(pwEnd - 4, 0);
  let idx = 10;
  for (let i = pwStart; i < pwEnd; i++) {
    saltChars[idx++] = password.charCodeAt(i);
  }
  while (idx < 14) {
    saltChars[idx++] = 0x0020;
  }
  // Convert to UTF-16BE bytes
  const saltBuf = Buffer.alloc(28);
  for (let i = 0; i < 14; i++) {
    saltBuf.writeUInt16BE(saltChars[i], i * 2);
  }
  return createHash('sha256').update(saltBuf).digest();
}

/**
 * Generate SHA-512 substitute (final encrypted password).
 * Upstream: AS400ImplRemote.generateSha512Substitute()
 *
 * PW_SUB = SHA-512(PW_TOKEN + serverSeed + clientSeed + userID_UTF16BE + sequence)
 */
function generateSha512Substitute(userId, token, serverSeed, clientSeed, sequence) {
  const userIdUtf16 = toUserIdUTF16BE(userId);
  const md = createHash('sha512');
  md.update(token);
  md.update(Buffer.from(serverSeed));
  md.update(Buffer.from(clientSeed));
  md.update(userIdUtf16);
  md.update(sequence);
  return new Uint8Array(md.digest());
}

// ── DES (Level 0/1) ─────────────────────────────────────────────────

/**
 * DES-based password encryption for password level 0 or 1.
 * Produces an 8-byte encrypted password.
 *
 * Algorithm: see EncryptPassword.java in JTOpen/jtopenlite
 *
 * @param {string} userId
 * @param {string} password
 * @param {Uint8Array} clientSeed
 * @param {Uint8Array} serverSeed
 * @returns {Uint8Array}
 */
export function encryptPasswordDES(userId, password, clientSeed, serverSeed) {
  const userIdEbcdic = stringToEbcdic(userId, true);
  const passwordEbcdic = stringToEbcdic(password, false);
  const sequenceNumber = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]);

  const token = generateToken(userIdEbcdic, passwordEbcdic);
  return generatePasswordSubstitute(userIdEbcdic, token, sequenceNumber, clientSeed, serverSeed);
}

// ── Password protection for change-password flow ─────────────────────

/**
 * Protect a password for the change-password datastream.
 * For DES level: XOR first 8 bytes of password with seeds.
 * For SHA levels: Return the UTF-16BE bytes.
 *
 * @param {string} password
 * @param {Uint8Array} clientSeed
 * @param {Uint8Array} serverSeed
 * @param {number} passwordLevel
 * @returns {Uint8Array}
 */
export function protectPassword(password, clientSeed, serverSeed, passwordLevel) {
  if (passwordLevel <= 1) {
    const pwEbcdic = stringToEbcdic(password, false);
    const result = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      result[i] = pwEbcdic[i] ^ clientSeed[i % 8] ^ serverSeed[i % 8];
    }
    return result;
  }
  // SHA levels: return UTF-16BE encoded password
  return toUTF16BE(password);
}

// ── Internal: UTF-16BE ───────────────────────────────────────────────

/**
 * Convert a JS string to UTF-16BE bytes.
 * @param {string} str
 * @returns {Buffer}
 */
function toUTF16BE(str) {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  return buf;
}

/**
 * Convert a user ID to a 20-byte UTF-16BE buffer, uppercased and
 * blank-padded (0x0020) to 10 characters.
 *
 * Used for SHA-1 and SHA-512 password encryption where the user ID
 * must be in Unicode (CCSID 13488) format, not EBCDIC.
 *
 * Upstream: HostServerConnection.getUserBytes() for level >= 2
 *           AS400ImplRemote: BinaryConverter.charArrayToByteArray(
 *             SignonConverter.byteArrayToCharArray(userIdEbcdic))
 *
 * @param {string} userId
 * @returns {Buffer} 20-byte UTF-16BE buffer
 */
function toUserIdUTF16BE(userId) {
  const upper = userId.toUpperCase();
  const buf = Buffer.alloc(20); // 10 chars × 2 bytes
  for (let i = 0; i < 10; i++) {
    buf.writeUInt16BE(i < upper.length ? upper.charCodeAt(i) : 0x0020, i * 2);
  }
  return buf;
}

// ── Internal: DES implementation ─────────────────────────────────────
// Faithfully ported from EncryptPassword.java in jtopenlite.
// Uses a bit-per-byte expansion approach matching the original code.

function ebcdicStrLen(buf, maxLen) {
  let i = 0;
  while (i < maxLen && buf[i] !== EBCDIC_BLANK && buf[i] !== 0) i++;
  return i;
}

function xorArrays(a, b, out) {
  for (let i = 0; i < 8; i++) out[i] = a[i] ^ b[i];
}

function addArrays(a, b, result, length) {
  let carry = 0;
  for (let i = length - 1; i >= 0; i--) {
    const temp = (a[i] & 0xFF) + (b[i] & 0xFF) + carry;
    carry = temp >>> 8;
    result[i] = temp & 0xFF;
  }
}

function xorWith0x55andLshift(bytes) {
  for (let i = 0; i < 8; i++) bytes[i] ^= 0x55;
  for (let i = 0; i < 7; i++) {
    bytes[i] = ((bytes[i] << 1) | ((bytes[i + 1] & 0x80) >>> 7)) & 0xFF;
  }
  bytes[7] = (bytes[7] << 1) & 0xFF;
}

function generateToken(userID, password) {
  const workBuffer1 = new Uint8Array(10);
  workBuffer1.set(userID);

  const length = ebcdicStrLen(userID, 10);
  if (length > 8) {
    workBuffer1[0] ^= (workBuffer1[8] & 0xC0);
    workBuffer1[1] ^= (workBuffer1[8] & 0x30) << 2;
    workBuffer1[2] ^= (workBuffer1[8] & 0x0C) << 4;
    workBuffer1[3] ^= (workBuffer1[8] & 0x03) << 6;
    workBuffer1[4] ^= (workBuffer1[9] & 0xC0);
    workBuffer1[5] ^= (workBuffer1[9] & 0x30) << 2;
    workBuffer1[6] ^= (workBuffer1[9] & 0x0C) << 4;
    workBuffer1[7] ^= (workBuffer1[9] & 0x03) << 6;
  }

  const pwdLen = ebcdicStrLen(password, 10);

  if (pwdLen > 8) {
    const workBuffer2 = new Uint8Array(10);
    workBuffer2.fill(EBCDIC_BLANK);
    workBuffer2.set(password.subarray(0, 8));

    const workBuffer3 = new Uint8Array(10);
    workBuffer3.fill(EBCDIC_BLANK);
    workBuffer3.set(password.subarray(8, 8 + (pwdLen - 8)));

    xorWith0x55andLshift(workBuffer2);
    const token1 = encDes(workBuffer2, workBuffer1);

    xorWith0x55andLshift(workBuffer3);
    const token2 = encDes(workBuffer3, workBuffer1);

    const token = new Uint8Array(8);
    xorArrays(token1, token2, token);
    return token;
  }

  const workBuffer2 = new Uint8Array(10);
  workBuffer2.fill(EBCDIC_BLANK);
  workBuffer2.set(password.subarray(0, pwdLen));

  xorWith0x55andLshift(workBuffer2);
  return encDes(workBuffer2, workBuffer1);
}

function generatePasswordSubstitute(userID, token, sequenceNumber, clientSeed, serverSeed) {
  const RDrSEQ = new Uint8Array(8);
  const nextData = new Uint8Array(8);

  addArrays(sequenceNumber, serverSeed, RDrSEQ, 8);

  let nextEncryptedData = encDes(token, RDrSEQ);

  xorArrays(nextEncryptedData, clientSeed, nextData);

  nextEncryptedData = encDes(token, nextData);

  // third data = userID[0:8] XOR RDrSEQ XOR nextEncryptedData
  const data3 = new Uint8Array(8);
  xorArrays(userID, RDrSEQ, data3);
  xorArrays(data3, nextEncryptedData, data3);

  nextEncryptedData = encDes(token, data3);

  // fourth data: pad userID[8:10] to 8 bytes with 0x40, XOR RDrSEQ, XOR nextEncryptedData
  const data4 = new Uint8Array(8);
  data4.fill(EBCDIC_BLANK);
  data4[0] = userID[8];
  data4[1] = userID[9];
  xorArrays(RDrSEQ, data4, data4);
  xorArrays(data4, nextEncryptedData, data4);

  nextEncryptedData = encDes(token, data4);

  // fifth data = sequenceNumber XOR nextEncryptedData
  const data5 = new Uint8Array(8);
  xorArrays(sequenceNumber, nextEncryptedData, data5);

  return encDes(token, data5);
}

// ── DES cipher tables ────────────────────────────────────────────────

const EPERM = [
  32,  1,  2,  3,  4,  5,  4,  5,  6,  7,  8,  9,
   8,  9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32,  1,
];

const INITPERM = [
  58, 50, 42, 34, 26, 18, 10,  2, 60, 52, 44, 36, 28, 20, 12,  4,
  62, 54, 46, 38, 30, 22, 14,  6, 64, 56, 48, 40, 32, 24, 16,  8,
  57, 49, 41, 33, 25, 17,  9,  1, 59, 51, 43, 35, 27, 19, 11,  3,
  61, 53, 45, 37, 29, 21, 13,  5, 63, 55, 47, 39, 31, 23, 15,  7,
];

const OUTPERM = [
  40,  8, 48, 16, 56, 24, 64, 32, 39,  7, 47, 15, 55, 23, 63, 31,
  38,  6, 46, 14, 54, 22, 62, 30, 37,  5, 45, 13, 53, 21, 61, 29,
  36,  4, 44, 12, 52, 20, 60, 28, 35,  3, 43, 11, 51, 19, 59, 27,
  34,  2, 42, 10, 50, 18, 58, 26, 33,  1, 41,  9, 49, 17, 57, 25,
];

const PPERM = [
  16,  7, 20, 21, 29, 12, 28, 17,  1, 15, 23, 26,
   5, 18, 31, 10,  2,  8, 24, 14, 32, 27,  3,  9,
  19, 13, 30,  6, 22, 11,  4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17,  9,  1, 58, 50, 42, 34, 26, 18,
  10,  2, 59, 51, 43, 35, 27, 19, 11,  3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15,  7, 62, 54, 46, 38, 30, 22,
  14,  6, 61, 53, 45, 37, 29, 21, 13,  5, 28, 20, 12,  4,
];

const PC2 = [
  14, 17, 11, 24,  1,  5,  3, 28, 15,  6, 21, 10,
  23, 19, 12,  4, 26,  8, 16,  7, 27, 20, 13,  2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SBOXES = [
  // S1
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  // S2
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  // S3
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  // S4
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  // S5
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  // S6
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  // S7
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  // S8
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

// Key schedule: 1=lshift1, 2=lshift2
const KEY_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

/**
 * DES encryption: encrypt data with key.
 * Faithfully follows EncryptPassword.enc_des(key, data) from JTOpen.
 * Note: the Java code has enc_des(key, data) where key encrypts data.
 *
 * @param {Uint8Array} key - 8-byte key
 * @param {Uint8Array} data - 8-byte data to encrypt
 * @returns {Uint8Array} 8-byte encrypted result
 */
function encDes(key, data) {
  // Expand data and key to 1-bit-per-byte arrays (1-indexed, size 65)
  const e1 = new Uint8Array(65); // expanded data
  const e2 = new Uint8Array(65); // expanded key

  for (let i = 0; i < 8; i++) {
    e1[8 * i + 1] = (data[i] & 0x80) ? 0x31 : 0x30;
    e1[8 * i + 2] = (data[i] & 0x40) ? 0x31 : 0x30;
    e1[8 * i + 3] = (data[i] & 0x20) ? 0x31 : 0x30;
    e1[8 * i + 4] = (data[i] & 0x10) ? 0x31 : 0x30;
    e1[8 * i + 5] = (data[i] & 0x08) ? 0x31 : 0x30;
    e1[8 * i + 6] = (data[i] & 0x04) ? 0x31 : 0x30;
    e1[8 * i + 7] = (data[i] & 0x02) ? 0x31 : 0x30;
    e1[8 * i + 8] = (data[i] & 0x01) ? 0x31 : 0x30;
  }

  for (let i = 0; i < 8; i++) {
    e2[8 * i + 1] = (key[i] & 0x80) ? 0x31 : 0x30;
    e2[8 * i + 2] = (key[i] & 0x40) ? 0x31 : 0x30;
    e2[8 * i + 3] = (key[i] & 0x20) ? 0x31 : 0x30;
    e2[8 * i + 4] = (key[i] & 0x10) ? 0x31 : 0x30;
    e2[8 * i + 5] = (key[i] & 0x08) ? 0x31 : 0x30;
    e2[8 * i + 6] = (key[i] & 0x04) ? 0x31 : 0x30;
    e2[8 * i + 7] = (key[i] & 0x02) ? 0x31 : 0x30;
    e2[8 * i + 8] = (key[i] & 0x01) ? 0x31 : 0x30;
  }

  // Generate Cn from key using PC1
  const Cn = new Uint8Array(58);
  for (let n = 1; n <= 56; n++) {
    Cn[n] = e2[PC1[n - 1]];
  }

  // Generate 16 subkeys
  const keys = new Array(16);
  for (let round = 0; round < 16; round++) {
    if (KEY_SHIFTS[round] === 1) {
      lshift1(Cn);
    } else {
      lshift2(Cn);
    }
    const k = new Uint8Array(49);
    for (let n = 1; n <= 48; n++) {
      k[n] = Cn[PC2[n - 1]];
    }
    keys[round] = k;
  }

  // Initial permutation
  const Ln = new Uint8Array(33);
  const Rn = new Uint8Array(33);
  for (let n = 1; n <= 32; n++) {
    Ln[n] = e1[INITPERM[n - 1]];
    Rn[n] = e1[INITPERM[n + 31]];
  }

  // 16 rounds
  for (let round = 0; round < 16; round++) {
    cipher(keys[round], Ln, Rn);
  }

  // Create preout by interposing R16 and L16
  const preout = new Uint8Array(65);
  for (let i = 1; i <= 32; i++) {
    preout[i] = Rn[i];
    preout[i + 32] = Ln[i];
  }

  // Output permutation
  const e3 = new Uint8Array(65);
  for (let n = 1; n <= 64; n++) {
    e3[n] = preout[OUTPERM[n - 1]];
  }

  // Compress back to 8 bytes
  const result = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    if (e3[8 * i + 1] === 0x31) result[i] |= 0x80;
    if (e3[8 * i + 2] === 0x31) result[i] |= 0x40;
    if (e3[8 * i + 3] === 0x31) result[i] |= 0x20;
    if (e3[8 * i + 4] === 0x31) result[i] |= 0x10;
    if (e3[8 * i + 5] === 0x31) result[i] |= 0x08;
    if (e3[8 * i + 6] === 0x31) result[i] |= 0x04;
    if (e3[8 * i + 7] === 0x31) result[i] |= 0x02;
    if (e3[8 * i + 8] === 0x31) result[i] |= 0x01;
  }
  return result;
}

function cipher(key, Ln, Rn) {
  const temp1 = new Uint8Array(49);
  const temp2 = new Uint8Array(49);
  const temp3 = new Uint8Array(33);
  const fkn = new Uint8Array(33);
  const si = new Int32Array(9);
  const so = new Int32Array(9);

  for (let n = 1; n <= 48; n++) {
    temp1[n] = Rn[EPERM[n - 1]];
  }

  for (let n = 1; n <= 48; n++) {
    temp2[n] = (temp1[n] !== key[n]) ? 0x31 : 0x30;
  }

  // S-box input computation
  si[1] = ((temp2[1]  === 0x31) ? 0x20 : 0) | ((temp2[6]  === 0x31) ? 0x10 : 0) |
          ((temp2[2]  === 0x31) ? 0x08 : 0) | ((temp2[3]  === 0x31) ? 0x04 : 0) |
          ((temp2[4]  === 0x31) ? 0x02 : 0) | ((temp2[5]  === 0x31) ? 0x01 : 0);
  si[2] = ((temp2[7]  === 0x31) ? 0x20 : 0) | ((temp2[12] === 0x31) ? 0x10 : 0) |
          ((temp2[8]  === 0x31) ? 0x08 : 0) | ((temp2[9]  === 0x31) ? 0x04 : 0) |
          ((temp2[10] === 0x31) ? 0x02 : 0) | ((temp2[11] === 0x31) ? 0x01 : 0);
  si[3] = ((temp2[13] === 0x31) ? 0x20 : 0) | ((temp2[18] === 0x31) ? 0x10 : 0) |
          ((temp2[14] === 0x31) ? 0x08 : 0) | ((temp2[15] === 0x31) ? 0x04 : 0) |
          ((temp2[16] === 0x31) ? 0x02 : 0) | ((temp2[17] === 0x31) ? 0x01 : 0);
  si[4] = ((temp2[19] === 0x31) ? 0x20 : 0) | ((temp2[24] === 0x31) ? 0x10 : 0) |
          ((temp2[20] === 0x31) ? 0x08 : 0) | ((temp2[21] === 0x31) ? 0x04 : 0) |
          ((temp2[22] === 0x31) ? 0x02 : 0) | ((temp2[23] === 0x31) ? 0x01 : 0);
  si[5] = ((temp2[25] === 0x31) ? 0x20 : 0) | ((temp2[30] === 0x31) ? 0x10 : 0) |
          ((temp2[26] === 0x31) ? 0x08 : 0) | ((temp2[27] === 0x31) ? 0x04 : 0) |
          ((temp2[28] === 0x31) ? 0x02 : 0) | ((temp2[29] === 0x31) ? 0x01 : 0);
  si[6] = ((temp2[31] === 0x31) ? 0x20 : 0) | ((temp2[36] === 0x31) ? 0x10 : 0) |
          ((temp2[32] === 0x31) ? 0x08 : 0) | ((temp2[33] === 0x31) ? 0x04 : 0) |
          ((temp2[34] === 0x31) ? 0x02 : 0) | ((temp2[35] === 0x31) ? 0x01 : 0);
  si[7] = ((temp2[37] === 0x31) ? 0x20 : 0) | ((temp2[42] === 0x31) ? 0x10 : 0) |
          ((temp2[38] === 0x31) ? 0x08 : 0) | ((temp2[39] === 0x31) ? 0x04 : 0) |
          ((temp2[40] === 0x31) ? 0x02 : 0) | ((temp2[41] === 0x31) ? 0x01 : 0);
  si[8] = ((temp2[43] === 0x31) ? 0x20 : 0) | ((temp2[48] === 0x31) ? 0x10 : 0) |
          ((temp2[44] === 0x31) ? 0x08 : 0) | ((temp2[45] === 0x31) ? 0x04 : 0) |
          ((temp2[46] === 0x31) ? 0x02 : 0) | ((temp2[47] === 0x31) ? 0x01 : 0);

  for (let box = 1; box <= 8; box++) {
    so[box] = SBOXES[box - 1][si[box]];
  }

  // Decimal to binary
  for (let box = 1; box <= 8; box++) {
    const offset = (box - 1) * 4 + 1;
    temp3[offset]     = (so[box] & 0x08) ? 0x31 : 0x30;
    temp3[offset + 1] = (so[box] & 0x04) ? 0x31 : 0x30;
    temp3[offset + 2] = (so[box] & 0x02) ? 0x31 : 0x30;
    temp3[offset + 3] = (so[box] & 0x01) ? 0x31 : 0x30;
  }

  // P-permutation
  for (let n = 1; n <= 32; n++) {
    fkn[n] = temp3[PPERM[n - 1]];
  }

  // Update Ln and Rn
  const oldRn = new Uint8Array(33);
  oldRn.set(Rn);
  for (let n = 1; n <= 32; n++) {
    Rn[n] = (Ln[n] === fkn[n]) ? 0x30 : 0x31;
  }
  Ln.set(oldRn);
}

function lshift1(Cn) {
  const hold0 = Cn[1];
  const hold1 = Cn[29];
  Cn.copyWithin(1, 2, 29);
  Cn.copyWithin(29, 30, 57);
  Cn[28] = hold0;
  Cn[56] = hold1;
}

function lshift2(Cn) {
  const hold0 = Cn[1];
  const hold1 = Cn[2];
  const hold2 = Cn[29];
  const hold3 = Cn[30];
  Cn.copyWithin(1, 3, 29);
  Cn.copyWithin(29, 31, 57);
  Cn[27] = hold0;
  Cn[28] = hold1;
  Cn[55] = hold2;
  Cn[56] = hold3;
}
