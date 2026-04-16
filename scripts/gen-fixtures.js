#!/usr/bin/env node
/**
 * Generate golden test fixture files for js400 test suite.
 * Run: node scripts/gen-fixtures.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

const FIXTURES = join(import.meta.dirname, '..', 'tests', 'fixtures');

// ── Protocol: Signon Exchange Request ────────────────────────────────

function genSignonExchangeReq() {
  const clientSeed = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  const totalLen = 52;
  const buf = Buffer.alloc(totalLen);

  // Header (20 bytes)
  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);    // headerID
  buf.writeUInt16BE(0xE009, 6);    // ServerID.SIGNON
  buf.writeUInt32BE(0, 8);         // csInstance
  buf.writeUInt32BE(1, 12);        // correlation
  buf.writeUInt16BE(0, 16);        // templateLen
  buf.writeUInt16BE(0x7003, 18);   // SIGNON_EXCHANGE_ATTR_REQ

  // LL/CP 0x1101: Client version = 1
  buf.writeUInt32BE(10, 20);
  buf.writeUInt16BE(0x1101, 24);
  buf.writeUInt32BE(1, 26);

  // LL/CP 0x1102: Client data stream level = 10
  buf.writeUInt32BE(8, 30);
  buf.writeUInt16BE(0x1102, 34);
  buf.writeUInt16BE(10, 36);

  // LL/CP 0x1103: Client seed (8 bytes)
  buf.writeUInt32BE(14, 38);
  buf.writeUInt16BE(0x1103, 42);
  clientSeed.copy(buf, 44);

  return buf;
}

// ── Protocol: Signon Exchange Reply ──────────────────────────────────

function genSignonExchangeRep() {
  const serverSeed = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
  const jobName = Buffer.from('QUSER     123456/QPADEV0001', 'ascii');

  // Fixed portion: header(20) + RC(4) + serverVersion LL/CP(10) + serverLevel LL/CP(8)
  // Variable: serverSeed LL/CP(14) + passwordLevel LL/CP(7) + jobName LL/CP(10+data) + AAF(7)
  const jobNameLL = 10 + jobName.length;
  const totalLen = 42 + 14 + 7 + jobNameLL + 7;
  const buf = Buffer.alloc(totalLen);

  // Header
  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);
  buf.writeUInt16BE(0xE009, 6);    // SIGNON
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(1, 12);        // correlation matches request
  buf.writeUInt16BE(0, 16);
  buf.writeUInt16BE(0xF003, 18);   // SIGNON_EXCHANGE_ATTR_REP

  // Return code = 0 (success)
  buf.writeUInt32BE(0, 20);

  // Server version: LL=10, CP=0x1101, value = 0x00070500 (V7R5)
  buf.writeUInt32BE(10, 24);
  buf.writeUInt16BE(0x1101, 28);
  buf.writeUInt32BE(0x00070500, 30);

  // Server level: LL=8, CP=0x1102, value = 10
  buf.writeUInt32BE(8, 34);
  buf.writeUInt16BE(0x1102, 38);
  buf.writeUInt16BE(10, 40);

  // Variable area starts at offset 42
  let offset = 42;

  // Server seed: LL=14, CP=0x1103
  buf.writeUInt32BE(14, offset);
  buf.writeUInt16BE(0x1103, offset + 4);
  serverSeed.copy(buf, offset + 6);
  offset += 14;

  // Password level: LL=7, CP=0x1119, value=2 (SHA-1)
  buf.writeUInt32BE(7, offset);
  buf.writeUInt16BE(0x1119, offset + 4);
  buf[offset + 6] = 2;
  offset += 7;

  // Job name: LL=10+len, CP=0x111F, CCSID=37, data
  buf.writeUInt32BE(jobNameLL, offset);
  buf.writeUInt16BE(0x111F, offset + 4);
  buf.writeUInt32BE(37, offset + 6);  // CCSID of job name
  jobName.copy(buf, offset + 10);
  offset += jobNameLL;

  // AAF indicator: LL=7, CP=0x112E, value=0x01 (yes)
  buf.writeUInt32BE(7, offset);
  buf.writeUInt16BE(0x112E, offset + 4);
  buf[offset + 6] = 0x01;

  return buf;
}

// ── Protocol: Command Request (exchange attributes) ──────────────────

function genCommandReq() {
  const buf = Buffer.alloc(34);
  buf.writeUInt32BE(34, 0);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(0xE008, 6);    // COMMAND
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(1, 12);
  buf.writeUInt16BE(14, 16);       // template length
  buf.writeUInt16BE(0x1001, 18);   // REQ_EXCHANGE_ATTRIBUTES

  buf.writeUInt32BE(37, 20);       // CCSID 37
  // NLV '2924' encoded
  buf[24] = 0xF2;
  buf[25] = 0xF9;
  buf[26] = 0xF2;
  buf[27] = 0xF4;
  buf.writeUInt32BE(1, 28);        // client version
  buf.writeUInt16BE(10, 32);       // datastream level

  return buf;
}

// ── Protocol: DB Exchange Attributes Request ─────────────────────────

function genDbExchangeReq() {
  // DB exchange uses consistency token + RPB template
  const totalLen = 40;  // 20 header + 20 template
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(0xE004, 6);    // DATABASE
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(1, 12);
  buf.writeUInt16BE(20, 16);       // template length
  buf.writeUInt16BE(0x1001, 18);   // EXCHANGE_ATTRIBUTES

  // Template: consistency(4) + RPB_ID(2) + returnORS(2) + opByte(2) +
  //           paramCount(2) + PMDescHandle(2) + resultDescHandle(2) + reserved(4)
  buf.writeUInt32BE(0x000D0006, 20); // consistency bytes
  buf.writeUInt16BE(0, 24);          // RPB ID
  buf.writeUInt16BE(0, 26);          // return ORS handle
  buf.writeUInt16BE(0, 28);          // op byte
  buf.writeUInt16BE(0, 30);          // param count
  buf.writeUInt16BE(0, 32);          // PM descriptor handle
  buf.writeUInt16BE(0, 34);          // result descriptor handle
  buf.writeUInt32BE(0, 36);          // reserved

  return buf;
}

// ── Protocol: DB SELECT Reply with rows ──────────────────────────────

function genDbSelectReply() {
  // Minimal reply with one row containing a single VARCHAR column "HELLO"
  // This is a simplified representation of the actual DB reply structure
  const resultData = Buffer.from('HELLO', 'utf16le'); // 10 bytes
  const resultLL = 6 + resultData.length; // LL(4) + CP(2) + data

  const totalLen = 40 + resultLL; // 20 header + 20 template + result
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(0xE004, 6);    // DATABASE
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(1, 12);
  buf.writeUInt16BE(20, 16);       // template length
  buf.writeUInt16BE(0x1807, 18);   // FETCH reply

  // Template
  buf.writeUInt32BE(0x000D0006, 20);
  buf.writeUInt16BE(0, 24);
  buf.writeUInt16BE(1, 26);        // ORS handle = 1
  buf.writeUInt16BE(0, 28);
  buf.writeUInt16BE(0, 30);
  buf.writeUInt16BE(0, 32);
  buf.writeUInt16BE(0, 34);
  buf.writeUInt32BE(0, 36);

  // Result data LL/CP
  let offset = 40;
  buf.writeUInt32BE(resultLL, offset);
  buf.writeUInt16BE(0x3814, offset + 4); // RESULT_DATA
  resultData.copy(buf, offset + 6);

  return buf;
}

// ── Protocol: Print spool list reply ─────────────────────────────────

function genPrintSpoolListReply() {
  // Minimal NPCP-style print reply
  const totalLen = 40;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(0xE003, 6);    // PRINT
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(1, 12);
  buf.writeUInt16BE(20, 16);
  buf.writeUInt16BE(0x0001, 18);   // list reply ID

  // Template area with return code and count
  buf.writeUInt32BE(0, 20);        // return code = 0
  buf.writeUInt32BE(1, 24);        // number of entries
  // Padded minimal entry data
  buf.writeUInt32BE(0, 28);
  buf.writeUInt32BE(0, 32);
  buf.writeUInt32BE(0, 36);

  return buf;
}

// ── Write binary fixtures ────────────────────────────────────────────

writeFileSync(join(FIXTURES, 'protocol', 'signon-exchange-req.bin'), genSignonExchangeReq());
writeFileSync(join(FIXTURES, 'protocol', 'signon-exchange-rep.bin'), genSignonExchangeRep());
writeFileSync(join(FIXTURES, 'protocol', 'command-req.bin'), genCommandReq());
writeFileSync(join(FIXTURES, 'protocol', 'db-exchange-req.bin'), genDbExchangeReq());
writeFileSync(join(FIXTURES, 'protocol', 'db-select-reply.bin'), genDbSelectReply());
writeFileSync(join(FIXTURES, 'print', 'spool-list-reply.bin'), genPrintSpoolListReply());

// ── CCSID 37 roundtrip vectors ───────────────────────────────────────

const ccsid37Vectors = {
  _source: 'Generated from js400 CCSID 37 mapping tables',
  _description: 'ASCII/Unicode to EBCDIC CCSID 37 round-trip test vectors',
  vectors: [
    { unicode: 'HELLO', ebcdic: [0xC8, 0xC5, 0xD3, 0xD3, 0xD6] },
    { unicode: 'WORLD', ebcdic: [0xE6, 0xD6, 0xD9, 0xD3, 0xC4] },
    { unicode: 'hello', ebcdic: [0x88, 0x85, 0x93, 0x93, 0x96] },
    { unicode: 'ABCDEFGHIJ', ebcdic: [0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xD1] },
    { unicode: '0123456789', ebcdic: [0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9] },
    { unicode: ' ', ebcdic: [0x40] },
    { unicode: '$#@', ebcdic: [0x5B, 0x7B, 0x7C] },
    { unicode: '+-*/=', ebcdic: [0x4E, 0x60, 0x5C, 0x61, 0x7E] },
    { unicode: 'A', ebcdic: [0xC1] },
    { unicode: 'Z', ebcdic: [0xE9] },
  ],
};
writeFileSync(join(FIXTURES, 'ccsid', 'ccsid37-roundtrip.json'),
  JSON.stringify(ccsid37Vectors, null, 2) + '\n');

// ── CCSID 1208 (UTF-8) vectors ──────────────────────────────────────

const ccsid1208Vectors = {
  _source: 'Standard UTF-8 encoding test vectors',
  _description: 'UTF-8 round-trip test vectors for CCSID 1208',
  vectors: [
    { unicode: 'Hello', utf8: [0x48, 0x65, 0x6C, 0x6C, 0x6F] },
    { unicode: '\u00E9', utf8: [0xC3, 0xA9], description: 'e-acute (2-byte UTF-8)' },
    { unicode: '\u20AC', utf8: [0xE2, 0x82, 0xAC], description: 'Euro sign (3-byte UTF-8)' },
    { unicode: '\uD83D\uDE00', utf8: [0xF0, 0x9F, 0x98, 0x80], description: 'Grinning face emoji (4-byte UTF-8)' },
  ],
};
writeFileSync(join(FIXTURES, 'ccsid', 'ccsid1208-roundtrip.json'),
  JSON.stringify(ccsid1208Vectors, null, 2) + '\n');

// ── CCSID 5035 (Japanese EBCDIC) vectors ─────────────────────────────

const ccsid5035Vectors = {
  _source: 'Japanese EBCDIC CCSID 5035 test vectors',
  _description: 'Japanese EBCDIC test vectors — basic Latin subset that maps similarly to CCSID 37',
  vectors: [
    { unicode: 'A', ebcdic: [0xC1], description: 'Latin A maps same as CCSID 37' },
    { unicode: '0', ebcdic: [0xF0], description: 'Digit 0' },
    { unicode: ' ', ebcdic: [0x40], description: 'Space' },
  ],
};
writeFileSync(join(FIXTURES, 'ccsid', 'ccsid5035-roundtrip.json'),
  JSON.stringify(ccsid5035Vectors, null, 2) + '\n');

// ── Packed Decimal vectors ───────────────────────────────────────────

const packedDecimalVectors = {
  _source: 'Generated from AS400PackedDecimal encoding rules',
  _description: 'Packed decimal edge cases: numDigits, numDecimalPositions, value, expected bytes',
  vectors: [
    {
      numDigits: 5, numDecimalPositions: 2,
      value: '123.45',
      bytes: [0x12, 0x34, 0x5F],
      description: 'Simple positive with decimals',
    },
    {
      numDigits: 5, numDecimalPositions: 2,
      value: '-123.45',
      bytes: [0x12, 0x34, 0x5D],
      description: 'Simple negative with decimals',
    },
    {
      numDigits: 5, numDecimalPositions: 0,
      value: '0',
      bytes: [0x00, 0x00, 0x0F],
      description: 'Zero with no decimals',
    },
    {
      numDigits: 1, numDecimalPositions: 0,
      value: '9',
      bytes: [0x9F],
      description: 'Single digit max',
    },
    {
      numDigits: 1, numDecimalPositions: 0,
      value: '0',
      bytes: [0x0F],
      description: 'Single digit zero',
    },
    {
      numDigits: 7, numDecimalPositions: 2,
      value: '12345.67',
      bytes: [0x01, 0x23, 0x45, 0x6F],
      description: '7-digit packed decimal (4 bytes)',
    },
    {
      numDigits: 9, numDecimalPositions: 2,
      value: '0.01',
      bytes: [0x00, 0x00, 0x00, 0x01, 0x0F],
      description: 'Small fractional value',
    },
    {
      numDigits: 9, numDecimalPositions: 2,
      value: '-0.01',
      bytes: [0x00, 0x00, 0x00, 0x01, 0x0D],
      description: 'Small negative fractional',
    },
  ],
};
writeFileSync(join(FIXTURES, 'datatypes', 'packed-decimal.json'),
  JSON.stringify(packedDecimalVectors, null, 2) + '\n');

// ── Zoned Decimal vectors ────────────────────────────────────────────

const zonedDecimalVectors = {
  _source: 'Generated from AS400ZonedDecimal encoding rules',
  _description: 'Zoned decimal edge cases: numDigits, numDecimalPositions, value, expected bytes',
  vectors: [
    {
      numDigits: 5, numDecimalPositions: 2,
      value: '123.45',
      bytes: [0xF1, 0xF2, 0xF3, 0xF4, 0xF5],
      description: 'Simple positive (zone=0xF on all including last)',
    },
    {
      numDigits: 5, numDecimalPositions: 2,
      value: '-123.45',
      bytes: [0xF1, 0xF2, 0xF3, 0xF4, 0xD5],
      description: 'Negative: last byte zone=0xD',
    },
    {
      numDigits: 3, numDecimalPositions: 0,
      value: '0',
      bytes: [0xF0, 0xF0, 0xF0],
      description: 'Zero integer',
    },
    {
      numDigits: 1, numDecimalPositions: 0,
      value: '9',
      bytes: [0xF9],
      description: 'Single digit max',
    },
    {
      numDigits: 3, numDecimalPositions: 0,
      value: '-1',
      bytes: [0xF0, 0xF0, 0xD1],
      description: 'Negative one padded',
    },
    {
      numDigits: 7, numDecimalPositions: 3,
      value: '9999.999',
      bytes: [0xF9, 0xF9, 0xF9, 0xF9, 0xF9, 0xF9, 0xF9],
      description: 'Max value for 7 digits',
    },
  ],
};
writeFileSync(join(FIXTURES, 'datatypes', 'zoned-decimal.json'),
  JSON.stringify(zonedDecimalVectors, null, 2) + '\n');

// ── Auth: Password Level 0 (DES) vector ──────────────────────────────

// We use the actual encrypt function to record the expected output
import {
  encryptPasswordDES,
  encryptPasswordSHA1,
  stringToEbcdic,
} from '../src/auth/password-encrypt.js';

const desClientSeed = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22]);
const desServerSeed = new Uint8Array([0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00]);
const desResult = encryptPasswordDES('TESTUSER', 'TESTPWD', desClientSeed, desServerSeed);

const passwordLevel0Vector = {
  _source: 'Generated using encryptPasswordDES from auth/password-encrypt.js',
  _description: 'DES password encryption test vector (Level 0/1)',
  userId: 'TESTUSER',
  password: 'TESTPWD',
  clientSeed: Array.from(desClientSeed),
  serverSeed: Array.from(desServerSeed),
  passwordLevel: 0,
  expectedLength: 8,
  expected: Array.from(desResult),
  userIdEbcdic: Array.from(stringToEbcdic('TESTUSER', true)),
};
writeFileSync(join(FIXTURES, 'auth', 'password-level0-vector.json'),
  JSON.stringify(passwordLevel0Vector, null, 2) + '\n');

// ── Auth: Password Level 2 (SHA-1) vector ────────────────────────────

const sha1ClientSeed = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
const sha1ServerSeed = new Uint8Array([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
const sha1Result = encryptPasswordSHA1('MYUSER', 'myPass', sha1ClientSeed, sha1ServerSeed);

const passwordLevel2Vector = {
  _source: 'Generated using encryptPasswordSHA1 from auth/password-encrypt.js',
  _description: 'SHA-1 password encryption test vector (Level 2)',
  userId: 'MYUSER',
  password: 'myPass',
  clientSeed: Array.from(sha1ClientSeed),
  serverSeed: Array.from(sha1ServerSeed),
  passwordLevel: 2,
  expectedLength: 20,
  expected: Array.from(sha1Result),
  userIdEbcdic: Array.from(stringToEbcdic('MYUSER', true)),
};
writeFileSync(join(FIXTURES, 'auth', 'password-level2-vector.json'),
  JSON.stringify(passwordLevel2Vector, null, 2) + '\n');

// ── PCML: QUSRJOBI ───────────────────────────────────────────────────

const pcmlQUSRJOBI = `<?xml version="1.0" encoding="UTF-8"?>
<pcml version="6.0">
  <program name="QUSRJOBI" path="/QSYS.LIB/QUSRJOBI.PGM">
    <data name="receiver" type="struct" struct="JOBI0100" usage="output"
          outputsize="receiverLength" />
    <data name="receiverLength" type="int" length="4" usage="input"
          init="86" />
    <data name="formatName" type="char" length="8" usage="input"
          init="JOBI0100" />
    <data name="qualifiedJobName" type="char" length="26" usage="input"
          init="*" />
    <data name="internalJobId" type="byte" length="16" usage="input"
          init="" />
    <data name="errorCode" type="struct" struct="errorCode" usage="input" />
  </program>

  <struct name="JOBI0100">
    <data name="bytesReturned" type="int" length="4" />
    <data name="bytesAvailable" type="int" length="4" />
    <data name="jobName" type="char" length="10" />
    <data name="userName" type="char" length="10" />
    <data name="jobNumber" type="char" length="6" />
    <data name="internalJobId" type="byte" length="16" />
    <data name="jobStatus" type="char" length="10" />
    <data name="jobType" type="char" length="1" />
    <data name="jobSubtype" type="char" length="1" />
    <data name="reserved" type="byte" length="2" />
    <data name="runPriority" type="int" length="4" />
    <data name="timeSlice" type="int" length="4" />
    <data name="defaultWait" type="int" length="4" />
    <data name="purge" type="char" length="10" />
  </struct>

  <struct name="errorCode">
    <data name="bytesProvided" type="int" length="4" init="0" />
    <data name="bytesAvailable" type="int" length="4" init="0" />
  </struct>
</pcml>
`;
writeFileSync(join(FIXTURES, 'pcml', 'QUSRJOBI.pcml'), pcmlQUSRJOBI);

console.log('Golden fixture files generated successfully.');
console.log('Binary fixtures:');
console.log('  tests/fixtures/protocol/signon-exchange-req.bin');
console.log('  tests/fixtures/protocol/signon-exchange-rep.bin');
console.log('  tests/fixtures/protocol/command-req.bin');
console.log('  tests/fixtures/protocol/db-exchange-req.bin');
console.log('  tests/fixtures/protocol/db-select-reply.bin');
console.log('  tests/fixtures/print/spool-list-reply.bin');
console.log('JSON fixtures:');
console.log('  tests/fixtures/ccsid/ccsid37-roundtrip.json');
console.log('  tests/fixtures/ccsid/ccsid1208-roundtrip.json');
console.log('  tests/fixtures/ccsid/ccsid5035-roundtrip.json');
console.log('  tests/fixtures/datatypes/packed-decimal.json');
console.log('  tests/fixtures/datatypes/zoned-decimal.json');
console.log('  tests/fixtures/auth/password-level0-vector.json');
console.log('  tests/fixtures/auth/password-level2-vector.json');
console.log('  tests/fixtures/pcml/QUSRJOBI.pcml');
