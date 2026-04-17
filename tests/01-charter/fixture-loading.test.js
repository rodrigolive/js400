/**
 * Fixture loading tests — verify golden fixture files can be loaded
 * and contain valid, parseable data.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStream } from '../../src/transport/datastream.js';
import { SignonExchangeRep } from '../../src/auth/protocol/SignonExchangeRep.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

describe('protocol binary fixtures', () => {
  test('signon-exchange-req.bin has valid header', () => {
    const buf = readFileSync(join(FIXTURES, 'protocol', 'signon-exchange-req.bin'));
    expect(buf.length).toBe(52);

    const header = DataStream.parseHeader(buf);
    expect(header.totalLength).toBe(52);
    expect(header.serverId).toBe(0xE009);    // SIGNON
    expect(header.reqRepId).toBe(0x7003);    // SIGNON_EXCHANGE_ATTR_REQ
    expect(DataStream.isValidHeader(buf)).toBe(true);
  });

  test('signon-exchange-rep.bin parses correctly', () => {
    const buf = readFileSync(join(FIXTURES, 'protocol', 'signon-exchange-rep.bin'));
    const header = DataStream.parseHeader(buf);

    expect(header.serverId).toBe(0xE009);
    expect(header.reqRepId).toBe(0xF003);    // SIGNON_EXCHANGE_ATTR_REP

    const reply = SignonExchangeRep.parse(buf);
    expect(reply.returnCode).toBe(0);
    expect(reply.serverVersion).toBe(0x00070500);
    expect(reply.serverLevel).toBe(10);
    expect(reply.passwordLevel).toBe(2);
    expect(reply.serverSeed).not.toBeNull();
    expect(reply.serverSeed.length).toBe(8);
    expect(reply.aafIndicator).toBe(true);
  });

  test('command-req.bin has valid command header', () => {
    const buf = readFileSync(join(FIXTURES, 'protocol', 'command-req.bin'));
    const header = DataStream.parseHeader(buf);

    expect(header.serverId).toBe(0xE008);    // COMMAND
    expect(header.reqRepId).toBe(0x1001);    // EXCHANGE_ATTRIBUTES
    expect(header.templateLen).toBe(14);
    expect(header.totalLength).toBe(34);
  });

  test('db-exchange-req.bin has valid database header', () => {
    const buf = readFileSync(join(FIXTURES, 'protocol', 'db-exchange-req.bin'));
    const header = DataStream.parseHeader(buf);

    expect(header.serverId).toBe(0xE004);    // DATABASE
    expect(header.reqRepId).toBe(0x1001);    // EXCHANGE_ATTRIBUTES
    expect(header.templateLen).toBe(20);

    // Check consistency bytes
    expect(buf.readUInt32BE(20)).toBe(0x000D0006);
  });

  test('db-select-reply.bin has valid fetch reply header', () => {
    const buf = readFileSync(join(FIXTURES, 'protocol', 'db-select-reply.bin'));
    const header = DataStream.parseHeader(buf);

    expect(header.serverId).toBe(0xE004);
    expect(header.reqRepId).toBe(0x1807);    // FETCH reply
  });

  test('spool-list-reply.bin has valid print header', () => {
    const buf = readFileSync(join(FIXTURES, 'print', 'spool-list-reply.bin'));
    const header = DataStream.parseHeader(buf);

    expect(header.serverId).toBe(0xE003);    // PRINT
    expect(header.totalLength).toBe(40);
  });
});

describe('CCSID JSON fixtures', () => {
  test('ccsid37-roundtrip.json loads and has vectors', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'ccsid', 'ccsid37-roundtrip.json'), 'utf8'));
    expect(data.vectors).toBeInstanceOf(Array);
    expect(data.vectors.length).toBeGreaterThan(0);

    for (const v of data.vectors) {
      expect(typeof v.unicode).toBe('string');
      expect(v.ebcdic).toBeInstanceOf(Array);
      expect(v.ebcdic.length).toBe(v.unicode.length);
    }
  });

  test('ccsid1208-roundtrip.json loads and has vectors', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'ccsid', 'ccsid1208-roundtrip.json'), 'utf8'));
    expect(data.vectors).toBeInstanceOf(Array);
    expect(data.vectors.length).toBeGreaterThan(0);
  });
});

describe('datatype JSON fixtures', () => {
  test('packed-decimal.json loads with correct structure', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'datatypes', 'packed-decimal.json'), 'utf8'));
    expect(data.vectors).toBeInstanceOf(Array);
    expect(data.vectors.length).toBeGreaterThan(0);

    for (const v of data.vectors) {
      expect(typeof v.numDigits).toBe('number');
      expect(typeof v.numDecimalPositions).toBe('number');
      expect(typeof v.value).toBe('string');
      expect(v.bytes).toBeInstanceOf(Array);
    }
  });

  test('zoned-decimal.json loads with correct structure', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'datatypes', 'zoned-decimal.json'), 'utf8'));
    expect(data.vectors).toBeInstanceOf(Array);
    expect(data.vectors.length).toBeGreaterThan(0);
  });
});

describe('auth JSON fixtures', () => {
  test('password-level0-vector.json has DES test data', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'auth', 'password-level0-vector.json'), 'utf8'));
    expect(data.userId).toBe('TESTUSER');
    expect(data.passwordLevel).toBe(0);
    expect(data.expected.length).toBe(8);
    expect(data.clientSeed.length).toBe(8);
    expect(data.serverSeed.length).toBe(8);
  });

  test('password-level2-vector.json has SHA-1 test data', () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'auth', 'password-level2-vector.json'), 'utf8'));
    expect(data.userId).toBe('MYUSER');
    expect(data.passwordLevel).toBe(2);
    expect(data.expected.length).toBe(20);
  });
});

describe('PCML fixtures', () => {
  test('QUSRJOBI.pcml loads as valid XML', () => {
    const content = readFileSync(join(FIXTURES, 'pcml', 'QUSRJOBI.pcml'), 'utf8');
    expect(content).toContain('<pcml');
    expect(content).toContain('name="QUSRJOBI"');
    expect(content).toContain('JOBI0100');
    expect(content).toContain('qualifiedJobName');
  });
});
