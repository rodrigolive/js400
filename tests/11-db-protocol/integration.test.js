/**
 * Integration tests for the database protocol stack.
 *
 * These tests wire together multiple layers using a mock connection
 * that replays synthetic server replies, validating the full flow
 * from request building through reply parsing and data decoding.
 */
import { describe, test, expect } from 'bun:test';
import { DBRequestDS, RequestID, CodePoint } from '../../src/db/protocol/DBRequestDS.js';
import {
  parseReply, parseSQLCA, parseOperationReply,
  parseFetchReply, throwIfError, SQLCA_LENGTH,
} from '../../src/db/protocol/DBReplyDS.js';
import { parseColumnDescriptors, SqlType } from '../../src/db/protocol/DBDescriptors.js';
import { decodeRows, encodeValue, getTypeHandler } from '../../src/db/types/factory.js';
import { DataStream } from '../../src/transport/DataStream.js';

/** Build a synthetic server reply buffer. */
function buildServerReply({
  reqRepId = 0x1001,
  sqlCode = 0,
  sqlState = '00000',
  rowCount = 0,
  templateExtra = null,
  codePoints = [],
} = {}) {
  // Build SQLCA (124 bytes)
  const sqlca = Buffer.alloc(SQLCA_LENGTH, 0);
  sqlca.writeInt32BE(sqlCode, 0);
  // SQLERRD[2] = rowCount
  sqlca.writeInt32BE(rowCount, 84 + 2 * 4);
  // SQLSTATE at offset 119 (5 bytes, ASCII)
  for (let i = 0; i < Math.min(sqlState.length, 5); i++) {
    sqlca[119 + i] = sqlState.charCodeAt(i);
  }

  const template = templateExtra
    ? Buffer.concat([sqlca, templateExtra])
    : sqlca;

  let cpLen = 0;
  for (const cp of codePoints) cpLen += cp.length;

  const totalLen = 20 + template.length + cpLen;
  const buf = Buffer.alloc(totalLen);
  buf.writeInt32BE(totalLen, 0);
  buf.writeUInt16BE(0xE004, 6);
  buf.writeInt16BE(template.length, 16);
  buf.writeUInt16BE(reqRepId, 18);
  template.copy(buf, 20);

  let offset = 20 + template.length;
  for (const cp of codePoints) {
    cp.copy(buf, offset);
    offset += cp.length;
  }

  return buf;
}

function buildCP(cp, data) {
  const ll = 6 + data.length;
  const buf = Buffer.alloc(ll);
  buf.writeInt32BE(ll, 0);
  buf.writeUInt16BE(cp, 4);
  data.copy(buf, 6);
  return buf;
}

describe('request → reply round-trip', () => {
  test('exchange attributes request and reply', () => {
    // Build request
    const reqBuf = DBRequestDS.buildExchangeAttributes({
      ccsid: 13488,
      datastreamLevel: 5,
    });

    // Verify request
    expect(reqBuf.readUInt16BE(6)).toBe(0xE004);
    expect(reqBuf.readUInt16BE(18)).toBe(RequestID.EXCHANGE_ATTRIBUTES);

    // Build synthetic reply
    const template = Buffer.alloc(18, 0);
    template.writeUInt16BE(0x0F, 0);   // attributes
    template.writeInt32BE(37, 2);      // server CCSID
    template.writeInt32BE(10, 6);      // DS level
    template.writeUInt16BE(3, 10);     // access level

    const replyBuf = Buffer.alloc(20 + 18);
    replyBuf.writeInt32BE(20 + 18, 0);
    replyBuf.writeUInt16BE(0xE004, 6);
    replyBuf.writeInt16BE(18, 16);
    replyBuf.writeUInt16BE(RequestID.EXCHANGE_ATTRIBUTES, 18);
    template.copy(replyBuf, 20);

    const reply = parseReply(replyBuf);
    expect(reply.template.length).toBe(18);
    expect(reply.template.readInt32BE(2)).toBe(37);
  });

  test('execute immediate request and success reply', () => {
    const reqBuf = DBRequestDS.buildExecuteImmediate({
      rpbId: 0,
      sqlText: 'SET SCHEMA "MYLIB"',
    });

    // Verify SQL text is in the request
    const reply = parseReply(reqBuf);
    expect(reply.codePoints.has(CodePoint.SQL_STATEMENT_TEXT)).toBe(true);

    // Build success reply
    const replyBuf = buildServerReply({
      reqRepId: RequestID.EXECUTE_IMMEDIATE,
      sqlCode: 0,
      rowCount: 0,
    });

    const opReply = parseOperationReply(replyBuf);
    expect(opReply.sqlca.sqlCode).toBe(0);
    expect(opReply.sqlca.isSuccess).toBe(true);
  });

  test('execute immediate with SQL error', () => {
    const replyBuf = buildServerReply({
      reqRepId: RequestID.EXECUTE_IMMEDIATE,
      sqlCode: -204,
      sqlState: '42704',
    });

    const opReply = parseOperationReply(replyBuf);
    expect(opReply.sqlca.sqlCode).toBe(-204);
    expect(opReply.sqlca.isError).toBe(true);
    expect(() => throwIfError(opReply.sqlca, 'Test')).toThrow();
  });
});

describe('SELECT flow simulation', () => {
  test('prepare-and-describe → execute-or-open → decode rows', () => {
    // 1) Build prepare request
    const prepReq = DBRequestDS.buildPrepareAndDescribe({
      rpbId: 1,
      sqlText: 'SELECT CUSNUM, CUSNAME FROM CUSTOMERS',
      describeOption: 2,
    });
    expect(prepReq.readUInt16BE(18)).toBe(RequestID.PREPARE_AND_DESCRIBE);

    // 2) Simulate prepare reply with column descriptors
    // Two columns: INTEGER CUSNUM, VARCHAR(50) CUSNAME
    const colDescBuf = Buffer.alloc(32);
    // Column 1: INTEGER
    colDescBuf.writeInt16BE(496, 0);   // sqlType
    colDescBuf.writeInt32BE(4, 2);     // length
    colDescBuf.writeInt16BE(0, 6);     // scale
    colDescBuf.writeInt16BE(10, 8);    // precision
    colDescBuf.writeUInt16BE(0, 10);   // ccsid
    colDescBuf.writeUInt16BE(0, 12);   // joinRef
    colDescBuf.writeUInt16BE(0, 14);   // flags
    // Column 2: VARCHAR(50)
    colDescBuf.writeInt16BE(449, 16);  // sqlType (nullable)
    colDescBuf.writeInt32BE(100, 18);  // length (50 chars × 2 bytes for UTF-16)
    colDescBuf.writeInt16BE(0, 22);    // scale
    colDescBuf.writeInt16BE(0, 24);    // precision
    colDescBuf.writeUInt16BE(13488, 26); // ccsid
    colDescBuf.writeUInt16BE(0, 28);   // joinRef
    colDescBuf.writeUInt16BE(0x0001, 30); // flags (nullable)

    const descriptors = parseColumnDescriptors(colDescBuf, 2);
    expect(descriptors.length).toBe(2);
    expect(descriptors[0].typeName).toBe('INTEGER');
    expect(descriptors[1].typeName).toBe('VARCHAR');
    expect(descriptors[1].nullable).toBe(true);

    // 3) Build execute-or-open request
    const execReq = DBRequestDS.buildExecuteOrOpenDescribe({
      rpbId: 1,
      blockingFactor: 100,
      describeOption: 1,
    });
    expect(execReq.readUInt16BE(18)).toBe(RequestID.EXECUTE_OR_OPEN_DESCRIBE);

    // 4) Build synthetic row data
    // Row 1: CUSNUM=12345, CUSNAME='Smith' (nullable, so null indicator + data)
    // Row 2: CUSNUM=67890, CUSNAME=null
    const cusname1 = 'Smith';
    const cusname1Bytes = cusname1.length * 2;
    // Row 1: INT(4) + nullind(2) + VARCHAR(2+100)
    const row1Size = 4 + 2 + 2 + 100;
    // Row 2: INT(4) + nullind(2) + VARCHAR(2+100)
    const row2Size = 4 + 2 + 2 + 100;
    const rowBuf = Buffer.alloc(row1Size + row2Size, 0);

    let off = 0;
    // Row 1
    rowBuf.writeInt32BE(12345, off); off += 4;
    rowBuf.writeInt16BE(0, off); off += 2; // not null
    rowBuf.writeUInt16BE(cusname1Bytes, off); off += 2; // varchar len
    for (let i = 0; i < cusname1.length; i++) {
      rowBuf.writeUInt16BE(cusname1.charCodeAt(i), off + i * 2);
    }
    off += 100;

    // Row 2
    rowBuf.writeInt32BE(67890, off); off += 4;
    rowBuf.writeInt16BE(-1, off); off += 2; // null
    rowBuf.writeUInt16BE(0, off); off += 2; // varchar len (0 for null, but data still present)
    off += 100;

    // Add column names for decoding
    descriptors[0].name = 'CUSNUM';
    descriptors[1].name = 'CUSNAME';

    // 5) Decode rows
    const rows = decodeRows(rowBuf, 0, descriptors, 2, 37);
    expect(rows.length).toBe(2);
    expect(rows[0].CUSNUM).toBe(12345);
    expect(rows[0].CUSNAME).toBe('Smith');
    expect(rows[1].CUSNUM).toBe(67890);
    expect(rows[1].CUSNAME).toBeNull();
  });
});

describe('parameterized DML flow simulation', () => {
  test('encode parameters and verify buffer structure', () => {
    // Simulate: INSERT INTO T(ID, NAME) VALUES (?, ?)
    const paramDescs = [
      { index: 0, sqlType: 496, length: 4, scale: 0, precision: 10, ccsid: 0, nullable: false },
      { index: 1, sqlType: 448, length: 50, scale: 0, precision: 0, ccsid: 13488, nullable: false },
    ];

    // Encode parameter 1: INTEGER = 42
    const intBuf = encodeValue(42, paramDescs[0]);
    expect(intBuf.length).toBe(4);
    expect(intBuf.readInt32BE(0)).toBe(42);

    // Encode parameter 2: VARCHAR = 'Hello'
    const strBuf = encodeValue('Hello', paramDescs[1]);
    expect(strBuf.length).toBe(12); // 2-byte prefix + 10 bytes of UTF-16BE data
    const strDataLen = strBuf.readUInt16BE(0);
    expect(strDataLen).toBe(10); // 5 chars × 2 bytes
  });
});

describe('commit/rollback flow simulation', () => {
  test('commit request structure', () => {
    const buf = DBRequestDS.buildCommit();
    const h = DataStream.parseHeader(buf);
    expect(h.reqRepId).toBe(RequestID.COMMIT);
    expect(h.serverId).toBe(0xE004);
    expect(buf.length).toBe(40);

    // Simulate success reply
    const replyBuf = buildServerReply({
      reqRepId: RequestID.COMMIT,
      sqlCode: 0,
    });
    const reply = parseOperationReply(replyBuf);
    expect(reply.sqlca.isSuccess).toBe(true);
  });

  test('rollback request structure', () => {
    const buf = DBRequestDS.buildRollback();
    const h = DataStream.parseHeader(buf);
    expect(h.reqRepId).toBe(RequestID.ROLLBACK);

    const replyBuf = buildServerReply({
      reqRepId: RequestID.ROLLBACK,
      sqlCode: 0,
    });
    const reply = parseOperationReply(replyBuf);
    expect(reply.sqlca.isSuccess).toBe(true);
  });
});

describe('fetch flow simulation', () => {
  test('fetch request carries RPB ID and count', () => {
    const buf = DBRequestDS.buildFetch({ rpbId: 5, fetchCount: 50 });
    const h = DataStream.parseHeader(buf);
    expect(h.reqRepId).toBe(RequestID.FETCH);

    // Verify template RPB ID
    const template = buf.subarray(20, 20 + 20);
    expect(template.readInt16BE(4)).toBe(5); // rpbId
    expect(template.readInt16BE(8)).toBe(50); // operationByte (fetchCount)
  });

  test('end-of-data reply (SQLCODE 100)', () => {
    const replyBuf = buildServerReply({
      reqRepId: RequestID.FETCH,
      sqlCode: 100,
    });
    const reply = parseFetchReply(replyBuf);
    expect(reply.endOfData).toBe(true);
    expect(reply.sqlca.sqlCode).toBe(100);
    expect(reply.sqlca.isWarning).toBe(true);
    expect(reply.sqlca.isError).toBe(false);
  });

  test('fetch with row data', () => {
    // Build row data as code point 0x380E
    const rowData = Buffer.alloc(8);
    rowData.writeInt32BE(100, 0);
    rowData.writeInt32BE(200, 4);

    const replyBuf = buildServerReply({
      reqRepId: RequestID.FETCH,
      sqlCode: 0,
      codePoints: [buildCP(0x380E, rowData)],
    });

    const reply = parseFetchReply(replyBuf);
    expect(reply.rowDataBuffers.length).toBe(1);
    expect(reply.rowDataBuffers[0].readInt32BE(0)).toBe(100);
    expect(reply.endOfData).toBe(false);
  });
});

describe('type handler coverage', () => {
  const typeKeys = [500, 496, 492, 480, 484, 488, 996, 452, 448, 456, 468, 464, 472, 912, 908, 384, 388, 392];

  for (const key of typeKeys) {
    test(`handler exists for type ${key}`, () => {
      const handler = getTypeHandler(key);
      expect(handler).not.toBeNull();
      expect(typeof handler.decode).toBe('function');
      expect(typeof handler.encode).toBe('function');
      expect(typeof handler.name).toBe('string');
    });
  }
});

describe('SQLCA warning and error fidelity', () => {
  test('SQLCODE -204 = object not found error', () => {
    const replyBuf = buildServerReply({
      sqlCode: -204,
      sqlState: '42704',
    });
    const reply = parseOperationReply(replyBuf);
    expect(reply.sqlca.sqlCode).toBe(-204);
    expect(reply.sqlca.isError).toBe(true);
    expect(reply.sqlca.isWarning).toBe(false);
    expect(reply.sqlca.isSuccess).toBe(false);
  });

  test('SQLCODE 100 = end of data warning', () => {
    const replyBuf = buildServerReply({ sqlCode: 100 });
    const reply = parseOperationReply(replyBuf);
    expect(reply.sqlca.sqlCode).toBe(100);
    expect(reply.sqlca.isWarning).toBe(true);
    expect(reply.sqlca.isError).toBe(false);
  });

  test('SQLCODE 0 = success', () => {
    const replyBuf = buildServerReply({ sqlCode: 0 });
    const reply = parseOperationReply(replyBuf);
    expect(reply.sqlca.isSuccess).toBe(true);
  });

  test('rowCount comes from SQLERRD[2]', () => {
    const replyBuf = buildServerReply({ sqlCode: 0, rowCount: 42 });
    const reply = parseOperationReply(replyBuf);
    expect(reply.sqlca.rowCount).toBe(42);
  });
});
