/**
 * Tests for DBRequestDS request builders.
 * Validates buffer layout, header fields, template structure, and code points.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  DBRequestDS, RequestID, CodePoint, DescribeOption,
  PrepareOption, FetchScroll, OpenAttributes,
} from '../../src/db/protocol/DBRequestDS.js';
import { DataStream } from '../../src/transport/DataStream.js';

beforeEach(() => {
  DataStream.resetCorrelation();
});

const HEADER_LEN = 20;
const TEMPLATE_LEN = 20;
const EXCH_TEMPLATE_LEN = 14;
const SERVER_ID = 0xE004;

function parseHeader(buf) {
  return {
    totalLength: buf.readInt32BE(0),
    serverId: buf.readUInt16BE(6),
    templateLen: buf.readInt16BE(16),
    reqRepId: buf.readUInt16BE(18),
  };
}

function parseCodePoints(buf, templateLen) {
  const cps = [];
  let offset = HEADER_LEN + templateLen;
  while (offset + 6 <= buf.length) {
    const ll = buf.readInt32BE(offset);
    if (ll < 6) break;
    const cp = buf.readUInt16BE(offset + 4);
    const data = buf.subarray(offset + 6, offset + ll);
    cps.push({ ll, cp, data });
    offset += ll;
  }
  return cps;
}

describe('DBRequestDS', () => {

  describe('buildExchangeAttributes', () => {
    test('produces correct header', () => {
      const buf = DBRequestDS.buildExchangeAttributes();
      const h = parseHeader(buf);
      expect(h.serverId).toBe(SERVER_ID);
      expect(h.reqRepId).toBe(RequestID.EXCHANGE_ATTRIBUTES);
      expect(h.templateLen).toBe(EXCH_TEMPLATE_LEN);
    });

    test('template contains client CCSID 13488', () => {
      const buf = DBRequestDS.buildExchangeAttributes({ ccsid: 13488 });
      const template = buf.subarray(HEADER_LEN, HEADER_LEN + EXCH_TEMPLATE_LEN);
      expect(template.readInt32BE(6)).toBe(13488);
    });

    test('includes CLIENT_DATASTREAM_LEVEL code point', () => {
      const buf = DBRequestDS.buildExchangeAttributes({ datastreamLevel: 7 });
      const cps = parseCodePoints(buf, EXCH_TEMPLATE_LEN);
      expect(cps.length).toBe(1);
      expect(cps[0].cp).toBe(CodePoint.CLIENT_DATASTREAM_LEVEL);
      expect(cps[0].data.readInt32BE(0)).toBe(7);
    });

    test('default datastream level is 5', () => {
      const buf = DBRequestDS.buildExchangeAttributes();
      const cps = parseCodePoints(buf, EXCH_TEMPLATE_LEN);
      expect(cps[0].data.readInt32BE(0)).toBe(5);
    });
  });

  describe('buildCreateRPB', () => {
    test('uses correct request ID', () => {
      const buf = DBRequestDS.buildCreateRPB({ rpbId: 1 });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.CREATE_RPB);
      expect(h.templateLen).toBe(TEMPLATE_LEN);
    });

    test('template carries RPB ID', () => {
      const buf = DBRequestDS.buildCreateRPB({ rpbId: 42 });
      const template = buf.subarray(HEADER_LEN, HEADER_LEN + TEMPLATE_LEN);
      expect(template.readInt16BE(4)).toBe(42);
    });

    test('includes translate indicator CP', () => {
      const buf = DBRequestDS.buildCreateRPB({ rpbId: 1, translateIndicator: 1 });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const tiCp = cps.find(c => c.cp === CodePoint.TRANSLATE_INDICATOR);
      expect(tiCp).toBeDefined();
      expect(tiCp.data[0]).toBe(1);
    });

    test('includes blocking factor CP', () => {
      const buf = DBRequestDS.buildCreateRPB({ rpbId: 1, blockingFactor: 200 });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const bfCp = cps.find(c => c.cp === CodePoint.BLOCKING_FACTOR);
      expect(bfCp).toBeDefined();
      expect(bfCp.data.readInt32BE(0)).toBe(200);
    });

    test('no CPs when no optional params', () => {
      const buf = DBRequestDS.buildCreateRPB({ rpbId: 1 });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      expect(cps.length).toBe(0);
    });
  });

  describe('buildDeleteRPB', () => {
    test('uses DELETE_RPB request ID', () => {
      const buf = DBRequestDS.buildDeleteRPB({ rpbId: 5 });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.DELETE_RPB);
    });

    test('total length is header + template', () => {
      const buf = DBRequestDS.buildDeleteRPB({ rpbId: 5 });
      expect(buf.length).toBe(HEADER_LEN + TEMPLATE_LEN);
    });
  });

  describe('buildPrepareAndDescribe', () => {
    test('includes SQL text code point', () => {
      const buf = DBRequestDS.buildPrepareAndDescribe({
        rpbId: 1,
        sqlText: 'SELECT 1',
      });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const sqlCp = cps.find(c => c.cp === CodePoint.SQL_STATEMENT_TEXT);
      expect(sqlCp).toBeDefined();
      // Text CP has 4-byte CCSID prefix then UTF-16BE text
      expect(sqlCp.data.readInt32BE(0)).toBe(13488);
    });

    test('uses correct request ID', () => {
      const buf = DBRequestDS.buildPrepareAndDescribe({ rpbId: 1, sqlText: 'SELECT 1' });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.PREPARE_AND_DESCRIBE);
    });

    test('encodes SQL text as UTF-16BE', () => {
      const buf = DBRequestDS.buildPrepareAndDescribe({ rpbId: 1, sqlText: 'AB' });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const sqlCp = cps.find(c => c.cp === CodePoint.SQL_STATEMENT_TEXT);
      // After 4-byte CCSID, UTF-16BE for 'A' = 0x0041, 'B' = 0x0042
      expect(sqlCp.data.readUInt16BE(4)).toBe(0x0041);
      expect(sqlCp.data.readUInt16BE(6)).toBe(0x0042);
    });

    test('includes describe option CP when specified', () => {
      const buf = DBRequestDS.buildPrepareAndDescribe({
        rpbId: 1, sqlText: 'SELECT 1',
        describeOption: DescribeOption.BOTH,
      });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const doCp = cps.find(c => c.cp === CodePoint.DESCRIBE_OPTION);
      expect(doCp).toBeDefined();
      expect(doCp.data.readInt16BE(0)).toBe(DescribeOption.BOTH);
    });
  });

  describe('buildExecuteImmediate', () => {
    test('uses EXECUTE_IMMEDIATE request ID', () => {
      const buf = DBRequestDS.buildExecuteImmediate({ rpbId: 0, sqlText: 'SET PATH X' });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.EXECUTE_IMMEDIATE);
    });

    test('has SQL text code point', () => {
      const sql = 'CREATE TABLE T(A INT)';
      const buf = DBRequestDS.buildExecuteImmediate({ rpbId: 0, sqlText: sql });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      expect(cps.find(c => c.cp === CodePoint.SQL_STATEMENT_TEXT)).toBeDefined();
    });
  });

  describe('buildFetch', () => {
    test('uses FETCH request ID', () => {
      const buf = DBRequestDS.buildFetch({ rpbId: 1, fetchCount: 100 });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.FETCH);
    });

    test('places fetch count in operation byte of template', () => {
      const buf = DBRequestDS.buildFetch({ rpbId: 1, fetchCount: 50 });
      const template = buf.subarray(HEADER_LEN, HEADER_LEN + TEMPLATE_LEN);
      expect(template.readInt16BE(8)).toBe(50);
    });

    test('default fetch count is 1', () => {
      const buf = DBRequestDS.buildFetch({ rpbId: 1 });
      const template = buf.subarray(HEADER_LEN, HEADER_LEN + TEMPLATE_LEN);
      expect(template.readInt16BE(8)).toBe(1);
    });
  });

  describe('buildCloseCursor', () => {
    test('uses CLOSE_CURSOR request ID', () => {
      const buf = DBRequestDS.buildCloseCursor({ rpbId: 3 });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.CLOSE_CURSOR);
    });

    test('no code points', () => {
      const buf = DBRequestDS.buildCloseCursor({ rpbId: 3 });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      expect(cps.length).toBe(0);
    });
  });

  describe('buildCommit', () => {
    test('uses COMMIT request ID', () => {
      const buf = DBRequestDS.buildCommit();
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.COMMIT);
    });

    test('total length is 40 (header + template)', () => {
      const buf = DBRequestDS.buildCommit();
      expect(buf.length).toBe(40);
    });
  });

  describe('buildRollback', () => {
    test('uses ROLLBACK request ID', () => {
      const buf = DBRequestDS.buildRollback();
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.ROLLBACK);
    });

    test('total length is 40', () => {
      const buf = DBRequestDS.buildRollback();
      expect(buf.length).toBe(40);
    });
  });

  describe('buildExecuteOrOpenDescribe', () => {
    test('uses correct request ID', () => {
      const buf = DBRequestDS.buildExecuteOrOpenDescribe({ rpbId: 1 });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.EXECUTE_OR_OPEN_DESCRIBE);
    });

    test('includes blocking factor CP', () => {
      const buf = DBRequestDS.buildExecuteOrOpenDescribe({
        rpbId: 1, blockingFactor: 64,
      });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const bfCp = cps.find(c => c.cp === CodePoint.BLOCKING_FACTOR);
      expect(bfCp).toBeDefined();
      expect(bfCp.data.readInt32BE(0)).toBe(64);
    });

    test('includes parameter marker data CP', () => {
      const paramData = Buffer.from([0x01, 0x02, 0x03]);
      const buf = DBRequestDS.buildExecuteOrOpenDescribe({
        rpbId: 1, parameterMarkerData: paramData,
      });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const pmCp = cps.find(c => c.cp === CodePoint.PARAMETER_MARKER_DATA);
      expect(pmCp).toBeDefined();
      expect(pmCp.data).toEqual(paramData);
    });
  });

  describe('buildRetrieveLobData', () => {
    test('uses RETRIEVE_LOB_DATA request ID', () => {
      const buf = DBRequestDS.buildRetrieveLobData({
        rpbId: 1, locatorHandle: 100, offset: 0, length: 1024,
      });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.RETRIEVE_LOB_DATA);
    });

    test('LOB locator CP contains handle, offset, length', () => {
      const buf = DBRequestDS.buildRetrieveLobData({
        rpbId: 1, locatorHandle: 42, offset: 512, length: 2048,
      });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const lobCp = cps.find(c => c.cp === CodePoint.LOB_LOCATOR_HANDLE);
      expect(lobCp).toBeDefined();
      expect(lobCp.data.readInt32BE(0)).toBe(42);
      expect(lobCp.data.readInt32BE(4)).toBe(512);
      expect(lobCp.data.readInt32BE(8)).toBe(2048);
    });
  });

  describe('buildFreeLob', () => {
    test('uses FREE_LOB request ID', () => {
      const buf = DBRequestDS.buildFreeLob({ rpbId: 1, locatorHandle: 99 });
      const h = parseHeader(buf);
      expect(h.reqRepId).toBe(RequestID.FREE_LOB);
    });

    test('contains locator handle', () => {
      const buf = DBRequestDS.buildFreeLob({ rpbId: 1, locatorHandle: 77 });
      const cps = parseCodePoints(buf, TEMPLATE_LEN);
      const lobCp = cps.find(c => c.cp === CodePoint.LOB_LOCATOR_HANDLE);
      expect(lobCp.data.readInt32BE(0)).toBe(77);
    });
  });

  describe('template consistency bytes', () => {
    test('all standard templates start with 0x000D0006', () => {
      const bufs = [
        DBRequestDS.buildCreateRPB({ rpbId: 1 }),
        DBRequestDS.buildDeleteRPB({ rpbId: 1 }),
        DBRequestDS.buildCommit(),
        DBRequestDS.buildRollback(),
        DBRequestDS.buildFetch({ rpbId: 1 }),
        DBRequestDS.buildCloseCursor({ rpbId: 1 }),
      ];
      for (const buf of bufs) {
        const template = buf.subarray(HEADER_LEN, HEADER_LEN + 4);
        expect(template.readInt32BE(0)).toBe(0x000D0006);
      }
    });
  });

  describe('RequestID constants', () => {
    test('expected values', () => {
      expect(RequestID.CREATE_RPB).toBe(0x1D00);
      expect(RequestID.PREPARE_AND_DESCRIBE).toBe(0x1803);
      expect(RequestID.EXECUTE_OR_OPEN_DESCRIBE).toBe(0x1812);
      expect(RequestID.COMMIT).toBe(0x1807);
      expect(RequestID.ROLLBACK).toBe(0x1808);
      expect(RequestID.FETCH).toBe(0x180B);
      expect(RequestID.CLOSE_CURSOR).toBe(0x180A);
      expect(RequestID.EXECUTE_IMMEDIATE).toBe(0x1806);
      expect(RequestID.RETRIEVE_LOB_DATA).toBe(0x1816);
      expect(RequestID.FREE_LOB).toBe(0x1819);
    });
  });

  describe('CodePoint constants', () => {
    test('expected values', () => {
      expect(CodePoint.SQL_STATEMENT_TEXT).toBe(0x3807);
      expect(CodePoint.PARAMETER_MARKER_DATA).toBe(0x3811);
      expect(CodePoint.STATEMENT_TYPE).toBe(0x3812);
      expect(CodePoint.BLOCKING_FACTOR).toBe(0x380C);
      expect(CodePoint.DESCRIBE_OPTION).toBe(0x380A);
      expect(CodePoint.TRANSLATE_INDICATOR).toBe(0x3805);
      expect(CodePoint.CLIENT_DATASTREAM_LEVEL).toBe(0x3A01);
    });
  });
});
