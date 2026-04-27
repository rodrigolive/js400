/**
 * Tests for DBReplyDS reply parsers, SQLCA parsing, and text decoding.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseReply, parseSQLCA, parseExchangeAttributes,
  parseOperationReply, parseFetchReply, throwIfError,
  getCodePointData, decodeTextCodePoint, SQLCA_LENGTH,
} from '../../src/db/protocol/DBReplyDS.js';
import { DataStream } from '../../src/transport/DataStream.js';
import { SqlError, DatastreamError } from '../../src/core/errors.js';

/** Build a minimal valid reply buffer. */
function buildReplyBuf({ serverId = 0xE004, reqRepId = 0x1001, templateLen = 0, template, codePoints = [] } = {}) {
  let cpLen = 0;
  for (const cp of codePoints) cpLen += cp.length;

  const totalLen = 20 + templateLen + cpLen;
  const buf = Buffer.alloc(totalLen);
  buf.writeInt32BE(totalLen, 0);
  buf.writeUInt16BE(serverId, 6);
  buf.writeInt16BE(templateLen, 16);
  buf.writeUInt16BE(reqRepId, 18);

  if (template) template.copy(buf, 20);

  let offset = 20 + templateLen;
  for (const cp of codePoints) {
    cp.copy(buf, offset);
    offset += cp.length;
  }

  return buf;
}

/** Build an LL/CP buffer. */
function buildCP(cp, data) {
  const ll = 6 + data.length;
  const buf = Buffer.alloc(ll);
  buf.writeInt32BE(ll, 0);
  buf.writeUInt16BE(cp, 4);
  data.copy(buf, 6);
  return buf;
}

describe('parseReply', () => {
  test('parses header, template, and code points', () => {
    const template = Buffer.alloc(4);
    template.writeInt32BE(0xDEAD, 0);
    const cpData = Buffer.from([0x01, 0x02]);
    const cpBuf = buildCP(0x3801, cpData);
    const buf = buildReplyBuf({ templateLen: 4, template, codePoints: [cpBuf] });

    const reply = parseReply(buf);
    expect(reply.header.serverId).toBe(0xE004);
    expect(reply.template.length).toBe(4);
    expect(reply.codePoints.has(0x3801)).toBe(true);
    expect(reply.codePoints.get(0x3801)[0]).toEqual(cpData);
  });

  test('handles multiple code points with same ID', () => {
    const d1 = Buffer.from([0x0A]);
    const d2 = Buffer.from([0x0B]);
    const buf = buildReplyBuf({
      codePoints: [buildCP(0x380E, d1), buildCP(0x380E, d2)],
    });
    const reply = parseReply(buf);
    expect(reply.codePoints.get(0x380E).length).toBe(2);
  });

  test('throws on short buffer', () => {
    expect(() => parseReply(Buffer.alloc(10))).toThrow();
  });

  test('throws on null buffer', () => {
    expect(() => parseReply(null)).toThrow();
  });
});

describe('parseSQLCA', () => {
  test('SQLCA_LENGTH is 124', () => {
    expect(SQLCA_LENGTH).toBe(124);
  });

  test('parses SQLCODE correctly', () => {
    const buf = Buffer.alloc(124, 0);
    buf.writeInt32BE(-204, 0);
    const sqlca = parseSQLCA(buf);
    expect(sqlca.sqlCode).toBe(-204);
    expect(sqlca.isError).toBe(true);
    expect(sqlca.isSuccess).toBe(false);
  });

  test('parses positive SQLCODE as warning', () => {
    const buf = Buffer.alloc(124, 0);
    buf.writeInt32BE(100, 0);
    const sqlca = parseSQLCA(buf);
    expect(sqlca.sqlCode).toBe(100);
    expect(sqlca.isWarning).toBe(true);
    expect(sqlca.isError).toBe(false);
  });

  test('parses zero SQLCODE as success', () => {
    const buf = Buffer.alloc(124, 0);
    const sqlca = parseSQLCA(buf);
    expect(sqlca.sqlCode).toBe(0);
    expect(sqlca.isSuccess).toBe(true);
  });

  test('parses SQLERRD array (6 int32 values)', () => {
    const buf = Buffer.alloc(124, 0);
    for (let i = 0; i < 6; i++) {
      buf.writeInt32BE(i * 100 + 1, 84 + i * 4);
    }
    const sqlca = parseSQLCA(buf);
    expect(sqlca.sqlerrd[0]).toBe(1);
    expect(sqlca.sqlerrd[1]).toBe(101);
    expect(sqlca.sqlerrd[2]).toBe(201);
    expect(sqlca.sqlerrd[5]).toBe(501);
    expect(sqlca.rowCount).toBe(201); // sqlerrd[2]
  });

  test('parses SQLWARN array (11 bytes)', () => {
    const buf = Buffer.alloc(124, 0);
    buf[108] = 0x57; // 'W' in ASCII
    buf[110] = 0x57;
    const sqlca = parseSQLCA(buf);
    expect(sqlca.sqlwarn[0]).toBe(0x57);
    expect(sqlca.sqlwarn[1]).toBe(0);
    expect(sqlca.sqlwarn[2]).toBe(0x57);
  });

  test('returns empty SQLCA on short buffer', () => {
    const sqlca = parseSQLCA(Buffer.alloc(10));
    expect(sqlca.sqlCode).toBe(0);
    expect(sqlca.isSuccess).toBe(true);
    expect(sqlca.sqlState).toBe('00000');
  });

  test('parses SQLERRML and message tokens', () => {
    const buf = Buffer.alloc(124, 0);
    const msg = 'TESTMSG';
    buf.writeUInt16BE(msg.length, 4);
    // Write ASCII-compatible bytes at offset 6
    for (let i = 0; i < msg.length; i++) {
      buf[6 + i] = msg.charCodeAt(i);
    }
    // parseSQLCA attempts CharConverter, then falls back to latin1
    const sqlca = parseSQLCA(buf, 0, 37);
    // The message tokens should contain the text (either via EBCDIC or fallback)
    expect(sqlca.messageTokens.length).toBeGreaterThan(0);
  });
});

describe('parseExchangeAttributes', () => {
  test('parses server CCSID and datastream level', () => {
    const template = Buffer.alloc(18, 0);
    template.writeUInt16BE(0x0F, 0); // server attributes
    template.writeInt32BE(37, 2);    // server CCSID
    template.writeInt32BE(10, 6);    // server datastream level
    template.writeUInt16BE(3, 10);   // access level

    const buf = buildReplyBuf({ templateLen: 18, template });
    const result = parseExchangeAttributes(buf);

    expect(result.serverAttributes).toBe(0x0F);
    expect(result.serverCCSID).toBe(37);
    expect(result.serverDatastreamLevel).toBe(10);
    expect(result.accessLevel).toBe(3);
  });

  test('throws on too-short template', () => {
    const template = Buffer.alloc(8, 0);
    const buf = buildReplyBuf({ templateLen: 8, template });
    expect(() => parseExchangeAttributes(buf)).toThrow('too short');
  });
});

describe('parseOperationReply', () => {
  test('extracts SQLCA from template', () => {
    const template = Buffer.alloc(SQLCA_LENGTH, 0);
    template.writeInt32BE(-802, 0); // SQLCODE = -802 (data conversion error)
    const buf = buildReplyBuf({ templateLen: SQLCA_LENGTH, template });

    const reply = parseOperationReply(buf);
    expect(reply.sqlca.sqlCode).toBe(-802);
    expect(reply.sqlca.isError).toBe(true);
  });

  test('extracts code points alongside SQLCA', () => {
    const template = Buffer.alloc(SQLCA_LENGTH, 0);
    const cpData = Buffer.from([0xFF]);
    const buf = buildReplyBuf({
      templateLen: SQLCA_LENGTH, template,
      codePoints: [buildCP(0x3812, cpData)],
    });

    const reply = parseOperationReply(buf);
    expect(getCodePointData(reply, 0x3812)).toEqual(cpData);
  });

  test('enriches SQLCA with message text from 0x3801/0x3802/0x3803 code points', () => {
    // Build a reply with SQLCA (in 0x3807) + message code points.
    // SQLCA: 12-byte header (SQLCAID+SQLCABC) + 124-byte body
    const sqlcaBody = Buffer.alloc(124, 0);
    sqlcaBody.writeInt32BE(-803, 0); // SQLCODE -803
    // SQLSTATE at offset 119: write ASCII "23505"
    Buffer.from('23505').copy(sqlcaBody, 119);
    const sqlcaCp = Buffer.alloc(12 + 124, 0);
    sqlcaBody.copy(sqlcaCp, 12);

    // MESSAGE_ID (0x3801): CCSID(2) + text
    // Use CCSID 819 (latin1) for easy ASCII encoding
    const msgIdText = 'SQL0803';
    const msgIdPayload = Buffer.alloc(2 + msgIdText.length);
    msgIdPayload.writeUInt16BE(819, 0);
    Buffer.from(msgIdText, 'latin1').copy(msgIdPayload, 2);

    // FIRST_LEVEL_TEXT (0x3802): CCSID(2) + length(2) + text
    const firstText = 'Duplicate key value specified.';
    const firstPayload = Buffer.alloc(4 + firstText.length);
    firstPayload.writeUInt16BE(819, 0);
    firstPayload.writeUInt16BE(firstText.length, 2);
    Buffer.from(firstText, 'latin1').copy(firstPayload, 4);

    // SECOND_LEVEL_TEXT (0x3803): CCSID(2) + length(2) + text
    const secondText = 'Cause: A unique index exists.';
    const secondPayload = Buffer.alloc(4 + secondText.length);
    secondPayload.writeUInt16BE(819, 0);
    secondPayload.writeUInt16BE(secondText.length, 2);
    Buffer.from(secondText, 'latin1').copy(secondPayload, 4);

    const template = Buffer.alloc(20, 0); // 20-byte reply template
    const buf = buildReplyBuf({
      templateLen: 20,
      template,
      codePoints: [
        buildCP(0x3807, sqlcaCp),
        buildCP(0x3801, msgIdPayload),
        buildCP(0x3802, firstPayload),
        buildCP(0x3803, secondPayload),
      ],
    });

    const reply = parseOperationReply(buf);
    expect(reply.sqlca.sqlCode).toBe(-803);
    expect(reply.sqlca.isError).toBe(true);
    expect(reply.sqlca.messageText).toContain('SQL0803');
    expect(reply.sqlca.messageText).toContain('Duplicate key');
    expect(reply.sqlca.secondLevelText).toContain('unique index');
  });

});

describe('parseFetchReply', () => {
  test('extracts row data buffers from 0x380E code point', () => {
    const template = Buffer.alloc(SQLCA_LENGTH, 0);
    const rowData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const buf = buildReplyBuf({
      templateLen: SQLCA_LENGTH, template,
      codePoints: [buildCP(0x380E, rowData)],
    });

    const reply = parseFetchReply(buf);
    expect(reply.rowDataBuffers.length).toBe(1);
    expect(reply.rowDataBuffers[0]).toEqual(rowData);
    expect(reply.endOfData).toBe(false);
  });

  test('detects end of data (SQLCODE 100)', () => {
    const template = Buffer.alloc(SQLCA_LENGTH, 0);
    template.writeInt32BE(100, 0); // SQLCODE 100 = end of data
    const buf = buildReplyBuf({ templateLen: SQLCA_LENGTH, template });

    const reply = parseFetchReply(buf);
    expect(reply.endOfData).toBe(true);
  });

  test('extracts extended descriptors from 0x3812 code point', () => {
    const template = Buffer.alloc(SQLCA_LENGTH, 0);
    const descData = Buffer.from([0xAA, 0xBB]);
    const buf = buildReplyBuf({
      templateLen: SQLCA_LENGTH, template,
      codePoints: [buildCP(0x3812, descData)],
    });

    const reply = parseFetchReply(buf);
    expect(reply.extDescriptors.length).toBe(1);
    expect(reply.extDescriptors[0]).toEqual(descData);
  });
});

describe('throwIfError', () => {
  test('throws SqlError for negative SQLCODE', () => {
    const sqlca = {
      sqlCode: -204, sqlState: '42704', isError: true,
      messageTokens: 'MYTABLE', rowCount: 0, sqlerrd: [0, 0, 0, 0, 0, 0],
    };
    expect(() => throwIfError(sqlca, 'Test')).toThrow(SqlError);
  });

  test('does not throw for zero SQLCODE', () => {
    const sqlca = { sqlCode: 0, isError: false };
    expect(() => throwIfError(sqlca)).not.toThrow();
  });

  test('does not throw for warning SQLCODE (positive)', () => {
    const sqlca = { sqlCode: 100, isError: false };
    expect(() => throwIfError(sqlca)).not.toThrow();
  });

  test('error message includes context', () => {
    const sqlca = {
      sqlCode: -501, sqlState: '24501', isError: true,
      messageTokens: 'cursor not open', rowCount: 0, sqlerrd: [0, 0, 0, 0, 0, 0],
    };
    try {
      throwIfError(sqlca, 'Close cursor');
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e.message).toContain('Close cursor');
      expect(e.message).toContain('-501');
      expect(e.message).toContain('24501');
    }
  });

  test('uses messageText over messageTokens when available', () => {
    const sqlca = {
      sqlCode: -803, sqlState: '23505', isError: true,
      messageTokens: 'FSD001_PK GIG4001',
      messageText: '[SQL0803] Duplicate key value specified.',
      secondLevelText: 'Cause: A unique index exists.',
      rowCount: 0, sqlerrd: [0, 0, 0, 0, 0, 0],
    };
    try {
      throwIfError(sqlca, 'Execute batch');
      expect(true).toBe(false);
    } catch (e) {
      expect(e.message).toContain('[SQL0803]');
      expect(e.message).toContain('Duplicate key');
      expect(e.message).toContain('Execute batch');
      expect(e.requestMetadata.messageText).toContain('SQL0803');
      expect(e.requestMetadata.secondLevelText).toContain('unique index');
    }
  });

  test('falls back to messageTokens when messageText is absent', () => {
    const sqlca = {
      sqlCode: -204, sqlState: '42704', isError: true,
      messageTokens: 'MYTABLE', rowCount: 0, sqlerrd: [0, 0, 0, 0, 0, 0],
    };
    try {
      throwIfError(sqlca, 'Execute');
      expect(true).toBe(false);
    } catch (e) {
      expect(e.message).toContain('MYTABLE');
      expect(e.message).not.toContain('[SQL');
    }
  });
});

describe('decodeTextCodePoint', () => {
  test('decodes UTF-16BE text with CCSID 13488 prefix', () => {
    const text = 'Hello';
    const textBuf = Buffer.alloc(4 + text.length * 2);
    textBuf.writeInt32BE(13488, 0);
    for (let i = 0; i < text.length; i++) {
      textBuf.writeUInt16BE(text.charCodeAt(i), 4 + i * 2);
    }
    expect(decodeTextCodePoint(textBuf)).toBe('Hello');
  });

  test('returns empty string for null/short data', () => {
    expect(decodeTextCodePoint(null)).toBe('');
    expect(decodeTextCodePoint(Buffer.alloc(2))).toBe('');
  });

  test('handles CCSID 1200 as UTF-16BE', () => {
    const text = 'AB';
    const textBuf = Buffer.alloc(4 + text.length * 2);
    textBuf.writeInt32BE(1200, 0);
    textBuf.writeUInt16BE(0x0041, 4);
    textBuf.writeUInt16BE(0x0042, 6);
    expect(decodeTextCodePoint(textBuf)).toBe('AB');
  });
});

describe('getCodePointData', () => {
  test('returns first buffer for existing CP', () => {
    const reply = { codePoints: new Map([[0x380E, [Buffer.from([1, 2])]]]) };
    expect(getCodePointData(reply, 0x380E)).toEqual(Buffer.from([1, 2]));
  });

  test('returns null for missing CP', () => {
    const reply = { codePoints: new Map() };
    expect(getCodePointData(reply, 0x380E)).toBeNull();
  });
});
