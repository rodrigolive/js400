/**
 * Tests for DDM protocol request builders and reply parsers.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DDMReq, CP } from '../../src/record/protocol/DDMReq.js';
import { DDMRep } from '../../src/record/protocol/DDMRep.js';
import { CharConverter } from '../../src/ccsid/CharConverter.js';

beforeEach(() => {
  DDMReq.resetCorrelation();
});

describe('DDM DSS header', () => {
  it('builds a 6-byte header', () => {
    const hdr = DDMReq.buildDSSHeader(42, 0x01, 1, 5);
    expect(hdr.length).toBe(6);
    expect(hdr.readUInt16BE(0)).toBe(42);   // length
    expect(hdr[2]).toBe(0x01);               // flags
    expect(hdr[3]).toBe(1);                  // type (request)
    expect(hdr.readUInt16BE(4)).toBe(5);     // correlation
  });
});

describe('DDM object builder', () => {
  it('builds a 4-byte empty DDM object', () => {
    const obj = DDMReq.buildDDMObject(0xD011);
    expect(obj.length).toBe(4);
    expect(obj.readUInt16BE(0)).toBe(4);     // length
    expect(obj.readUInt16BE(2)).toBe(0xD011); // code point
  });

  it('builds a DDM object with parameters', () => {
    const param = DDMReq.buildParam(0x1234, Buffer.from([0x01, 0x02]));
    const obj = DDMReq.buildDDMObject(0xD005, [param]);
    expect(obj.readUInt16BE(0)).toBe(4 + param.length); // obj header + param
    expect(obj.readUInt16BE(2)).toBe(0xD005);
  });
});

describe('DDM parameter builder', () => {
  it('builds a parameter with 4-byte LL/CP header', () => {
    const data = Buffer.from([0xAA, 0xBB]);
    const param = DDMReq.buildParam(0x5678, data);
    expect(param.length).toBe(6); // 4 header + 2 data
    expect(param.readUInt16BE(0)).toBe(6);    // LL
    expect(param.readUInt16BE(2)).toBe(0x5678); // CP
    expect(param[4]).toBe(0xAA);
    expect(param[5]).toBe(0xBB);
  });

  it('builds a 16-bit value parameter', () => {
    const param = DDMReq.buildParam16(0x11A2, 3);
    expect(param.length).toBe(6);
    expect(param.readUInt16BE(4)).toBe(3);
  });
});

describe('DDM EBCDIC encoding', () => {
  it('encodes ASCII string to EBCDIC', () => {
    const encoded = DDMReq.encodeEBCDIC('HELLO');
    const conv = new CharConverter(37);
    expect(conv.byteArrayToString(encoded, 0, encoded.length)).toBe('HELLO');
  });

  it('pads to specified length', () => {
    const encoded = DDMReq.encodeEBCDIC('AB', 10);
    expect(encoded.length).toBe(10);
    // Remaining bytes should be EBCDIC space (0x40)
    expect(encoded[2]).toBe(0x40);
    expect(encoded[9]).toBe(0x40);
  });
});

describe('DDMReq.buildExchangeAttributes', () => {
  it('builds a valid EXCSAT request', () => {
    const buf = DDMReq.buildExchangeAttributes();
    expect(buf.length).toBeGreaterThan(6);
    // DSS header
    expect(buf[3]).toBe(1); // type = request
    // DDM object code point at offset 8
    expect(buf.readUInt16BE(8)).toBe(CP.EXCSAT);
  });
});

describe('DDMReq.buildAccessSecurity', () => {
  it('builds a valid ACCSEC request', () => {
    const buf = DDMReq.buildAccessSecurity({
      securityMechanism: 3,
      rdbName: 'MYHOST',
    });
    expect(buf.readUInt16BE(8)).toBe(CP.ACCSEC);
  });
});

describe('DDMReq.buildSecurityCheck', () => {
  it('builds a valid SECCHK request', () => {
    const buf = DDMReq.buildSecurityCheck({
      securityMechanism: 3,
      userId: 'MYUSER',
      password: Buffer.from('secret'),
    });
    expect(buf.readUInt16BE(8)).toBe(CP.SECCHK);
  });
});

describe('DDMReq.buildOpen', () => {
  it('builds an S38OPEN request', () => {
    const buf = DDMReq.buildOpen({
      fileName: 'MYLIB/CUSTMAS',
      openType: 'READ',
    });
    expect(buf.readUInt16BE(8)).toBe(CP.S38OPEN);
    // Should contain S38CTLL parameter
    expect(buf.length).toBeGreaterThan(40);
  });

  it('parses library/file from compound name', () => {
    const buf = DDMReq.buildOpen({
      fileName: 'TESTLIB/ORDERS',
      openType: 'READWRITE',
      keyed: true,
    });
    expect(buf.readUInt16BE(8)).toBe(CP.S38OPEN);
  });

  it('handles single file name (no library)', () => {
    const buf = DDMReq.buildOpen({
      fileName: 'CUSTMAS',
      openType: 'READ',
    });
    expect(buf.readUInt16BE(8)).toBe(CP.S38OPEN);
  });
});

describe('DDMReq.buildGet', () => {
  it('builds a sequential get request', () => {
    const buf = DDMReq.buildGet({ direction: 1, recordCount: 1 });
    expect(buf.readUInt16BE(8)).toBe(CP.S38GET);
  });

  it('builds with lock option', () => {
    const buf = DDMReq.buildGet({ direction: 1, lockRecord: true });
    expect(buf.readUInt16BE(8)).toBe(CP.S38GET);
  });
});

describe('DDMReq.buildGetByRRN', () => {
  it('builds a get-by-RRN request', () => {
    const buf = DDMReq.buildGetByRRN({ recordNumber: 42 });
    expect(buf.readUInt16BE(8)).toBe(CP.S38GETD);
  });
});

describe('DDMReq.buildGetByKey', () => {
  it('builds a keyed get request', () => {
    const key = Buffer.alloc(4);
    key.writeInt32BE(100, 0);
    const buf = DDMReq.buildGetByKey({
      key,
      searchType: 0,
      direction: 0,
    });
    expect(buf.readUInt16BE(8)).toBe(CP.S38GETK);
  });
});

describe('DDMReq.buildPut', () => {
  it('builds a put (write) request', () => {
    const data = Buffer.alloc(20, 0x40);
    const buf = DDMReq.buildPut({ data });
    expect(buf.readUInt16BE(8)).toBe(CP.S38PUT);
  });

  it('includes null map when provided', () => {
    const data = Buffer.alloc(20, 0x40);
    const nullMap = Buffer.from([0xF0, 0xF1]);
    const buf = DDMReq.buildPut({ data, nullMap });
    expect(buf.readUInt16BE(8)).toBe(CP.S38PUT);
    expect(buf.length).toBeGreaterThan(data.length + nullMap.length);
  });
});

describe('DDMReq.buildUpdate', () => {
  it('builds an update request', () => {
    const buf = DDMReq.buildUpdate({ data: Buffer.alloc(10) });
    expect(buf.readUInt16BE(8)).toBe(CP.S38UPD);
  });
});

describe('DDMReq.buildDelete', () => {
  it('builds a delete request', () => {
    const buf = DDMReq.buildDelete();
    expect(buf.readUInt16BE(8)).toBe(CP.S38DEL);
  });
});

describe('DDMReq.buildClose', () => {
  it('builds a close request', () => {
    const buf = DDMReq.buildClose();
    expect(buf.readUInt16BE(8)).toBe(CP.S38CLOSE);
  });
});

describe('DDMReq.buildForceEndOfData', () => {
  it('builds a force-end-of-data request', () => {
    const buf = DDMReq.buildForceEndOfData();
    expect(buf.readUInt16BE(8)).toBe(CP.S38FEOD);
  });
});

// DDM Reply parser tests

function buildReply(codePoint, params = []) {
  let paramsLen = 0;
  for (const p of params) paramsLen += p.length;
  const objLen = 4 + paramsLen;
  const totalLen = 6 + objLen;

  const buf = Buffer.alloc(totalLen);
  // DSS header
  buf.writeUInt16BE(totalLen, 0);
  buf[2] = 0x01; // flags (end)
  buf[3] = 2;    // type (reply)
  buf.writeUInt16BE(1, 4); // correlation

  // DDM object
  buf.writeUInt16BE(objLen, 6);
  buf.writeUInt16BE(codePoint, 8);

  let offset = 10;
  for (const p of params) {
    p.copy(buf, offset);
    offset += p.length;
  }

  return buf;
}

function buildLLCP(cp, data) {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt16BE(4 + data.length, 0);
  buf.writeUInt16BE(cp, 2);
  data.copy(buf, 4);
  return buf;
}

describe('DDMRep.parseDSSHeader', () => {
  it('parses a 6-byte DSS header', () => {
    const buf = Buffer.alloc(6);
    buf.writeUInt16BE(100, 0);
    buf[2] = 0x01;
    buf[3] = 2;
    buf.writeUInt16BE(5, 4);

    const hdr = DDMRep.parseDSSHeader(buf);
    expect(hdr.length).toBe(100);
    expect(hdr.flags).toBe(0x01);
    expect(hdr.type).toBe(2);
    expect(hdr.correlation).toBe(5);
  });

  it('throws on short buffer', () => {
    expect(() => DDMRep.parseDSSHeader(Buffer.alloc(3))).toThrow(/too short/);
  });
});

describe('DDMRep.parseParams', () => {
  it('parses LL/CP pairs', () => {
    const p1 = buildLLCP(0x1234, Buffer.from([0x01]));
    const p2 = buildLLCP(0x5678, Buffer.from([0x02, 0x03]));
    const combined = Buffer.concat([p1, p2]);
    const params = DDMRep.parseParams(combined, 0, combined.length);
    expect(params.size).toBe(2);
    expect(params.get(0x1234)[0]).toEqual(Buffer.from([0x01]));
    expect(params.get(0x5678)[0]).toEqual(Buffer.from([0x02, 0x03]));
  });
});

describe('DDMRep.getReplyCodePoint', () => {
  it('returns the code point from a reply', () => {
    const reply = buildReply(0xD443);
    expect(DDMRep.getReplyCodePoint(reply)).toBe(0xD443);
  });

  it('returns 0 for short buffer', () => {
    expect(DDMRep.getReplyCodePoint(Buffer.alloc(5))).toBe(0);
  });
});

describe('DDMRep.parse', () => {
  it('parses a complete reply', () => {
    const data = Buffer.from([0xAA]);
    const param = buildLLCP(0x1111, data);
    const reply = buildReply(0xD005, [param]);

    const parsed = DDMRep.parse(reply);
    expect(parsed.codePoint).toBe(0xD005);
    expect(parsed.params.get(0x1111)[0]).toEqual(Buffer.from([0xAA]));
  });
});

describe('DDMRep.parseGet', () => {
  it('parses a successful get reply with data', () => {
    const recordData = Buffer.alloc(10, 0x40);
    const dataBuf = buildLLCP(CP.S38BUF, recordData);
    const recnb = Buffer.alloc(4);
    recnb.writeUInt32BE(7, 0);
    const recnbParam = buildLLCP(CP.S38RECNB, recnb);

    const reply = buildReply(CP.S38GET, [dataBuf, recnbParam]);
    const parsed = DDMRep.parseGet(reply);
    expect(parsed.success).toBe(true);
    expect(parsed.data.length).toBe(10);
    expect(parsed.recordNumber).toBe(7);
    expect(parsed.endOfFile).toBe(false);
  });

  it('detects end-of-file via CPF5001 message', () => {
    const conv = new CharConverter(37);
    const msgBytes = conv.stringToByteArray('CPF5001');
    const msgParam = buildLLCP(CP.S38MSGID, msgBytes);

    const reply = buildReply(CP.S38GET, [msgParam]);
    const parsed = DDMRep.parseGet(reply);
    expect(parsed.success).toBe(false);
    expect(parsed.endOfFile).toBe(true);
    expect(parsed.messageId).toBe('CPF5001');
  });
});

describe('DDMRep.parsePut', () => {
  it('parses a successful put reply', () => {
    const recnb = Buffer.alloc(4);
    recnb.writeUInt32BE(42, 0);
    const recnbParam = buildLLCP(CP.S38RECNB, recnb);

    const reply = buildReply(CP.S38PUT, [recnbParam]);
    const parsed = DDMRep.parsePut(reply);
    expect(parsed.success).toBe(true);
    expect(parsed.recordNumber).toBe(42);
  });

  it('detects put failure', () => {
    const conv = new CharConverter(37);
    const msgBytes = conv.stringToByteArray('CPF5003');
    const msgParam = buildLLCP(CP.S38MSGID, msgBytes);

    const reply = buildReply(CP.S38PUT, [msgParam]);
    const parsed = DDMRep.parsePut(reply);
    expect(parsed.success).toBe(false);
    expect(parsed.messageId).toBe('CPF5003');
  });
});

describe('DDMRep.parseUpdate / parseDelete / parseClose', () => {
  it('parses a success update reply', () => {
    const reply = buildReply(CP.S38UPD, []);
    expect(DDMRep.parseUpdate(reply).success).toBe(true);
  });

  it('parses a success delete reply', () => {
    const reply = buildReply(CP.S38DEL, []);
    expect(DDMRep.parseDelete(reply).success).toBe(true);
  });

  it('parses a success close reply', () => {
    const reply = buildReply(CP.S38CLOSE, []);
    expect(DDMRep.parseClose(reply).success).toBe(true);
  });
});

describe('DDMRep.parseOpen', () => {
  it('parses a successful open reply with I/O feedback', () => {
    const iofb = Buffer.alloc(12);
    iofb.writeUInt32BE(100, 0);  // record length
    iofb.writeUInt32BE(500, 4);  // record count
    iofb.writeUInt16BE(0, 8);    // access type (sequential)
    iofb.writeUInt16BE(4, 10);   // key length
    const iofbParam = buildLLCP(CP.S38IOFB, iofb);

    const reply = buildReply(CP.S38OPEN, [iofbParam]);
    const parsed = DDMRep.parseOpen(reply);
    expect(parsed.success).toBe(true);
    expect(parsed.recordLength).toBe(100);
    expect(parsed.recordCount).toBe(500);
    expect(parsed.keyLength).toBe(4);
  });

  it('detects open failure', () => {
    const conv = new CharConverter(37);
    const msgBytes = conv.stringToByteArray('CPF4101');
    const msgParam = buildLLCP(CP.S38MSGID, msgBytes);

    const reply = buildReply(CP.S38OPEN, [msgParam]);
    const parsed = DDMRep.parseOpen(reply);
    expect(parsed.success).toBe(false);
    expect(parsed.messageId).toBe('CPF4101');
  });
});

describe('DDM correlation counter', () => {
  it('increments across requests', () => {
    DDMReq.resetCorrelation();
    const buf1 = DDMReq.buildClose();
    const buf2 = DDMReq.buildClose();
    const corr1 = buf1.readUInt16BE(4);
    const corr2 = buf2.readUInt16BE(4);
    expect(corr2).toBe(corr1 + 1);
  });
});
