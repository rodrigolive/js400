/**
 * Tests for IFS protocol request builders and reply parsers.
 */

import { describe, it, expect } from 'bun:test';
import { IFSReq, REQ_OPEN, REQ_CLOSE, REQ_READ, REQ_WRITE,
  REQ_LIST_ATTRS, REQ_LOOKUP, REQ_DELETE_FILE, REQ_CREATE_DIR,
  REQ_DELETE_DIR, REQ_RENAME, REQ_COPY, REQ_CHANGE_ATTRS,
  REQ_LOCK_BYTES, REQ_UNLOCK_BYTES,
  ACCESS_READ, ACCESS_WRITE, SHARE_DENY_NONE,
  OPEN_FAIL_OPEN, OPEN_CREATE_REPLACE,
  CP_FILE_NAME, CP_DIR_NAME, CP_SOURCE_NAME, CP_TARGET_NAME,
  CP_FILE_DATA, OA_LEVEL1 } from '../../src/ifs/protocol/IFSReq.js';
import { IFSRep, REP_OPEN, REP_READ, REP_WRITE,
  RC_SUCCESS, RC_FILE_NOT_FOUND, RC_NO_MORE_FILES } from '../../src/ifs/protocol/IFSRep.js';
import { ServerID } from '../../src/core/constants.js';

function extractHeader(buf) {
  return {
    totalLen: buf.readUInt32BE(0),
    serverId: buf.readUInt16BE(6),
    templateLen: buf.readUInt16BE(16),
    reqRepId: buf.readUInt16BE(18),
  };
}

function findCodePoint(buf, startOffset, cp) {
  let off = startOffset;
  while (off + 6 <= buf.length) {
    const ll = buf.readUInt32BE(off);
    if (ll < 6 || off + ll > buf.length) return null;
    const cpVal = buf.readUInt16BE(off + 4);
    if (cpVal === cp) {
      return buf.subarray(off + 6, off + ll);
    }
    off += ll;
  }
  return null;
}

describe('IFSReq.buildOpen', () => {

  it('builds a valid open request with file server ID', () => {
    const buf = IFSReq.buildOpen({
      fileName: '/tmp/test.txt',
      accessIntent: ACCESS_READ,
      openOption: OPEN_FAIL_OPEN,
    });
    const h = extractHeader(buf);
    expect(h.serverId).toBe(ServerID.FILE);
    expect(h.reqRepId).toBe(REQ_OPEN);
    expect(h.totalLen).toBe(buf.length);
    expect(h.templateLen).toBe(44); // DSL >= 16
  });

  it('includes file name LL/CP with UCS-2 encoding', () => {
    const buf = IFSReq.buildOpen({
      fileName: '/a.txt',
      accessIntent: ACCESS_READ,
    });
    const nameCP = findCodePoint(buf, 20 + 44, CP_FILE_NAME);
    expect(nameCP).not.toBeNull();
    expect(nameCP.length).toBeGreaterThan(0);
  });

  it('encodes access intent correctly', () => {
    const buf = IFSReq.buildOpen({
      fileName: '/a.txt',
      accessIntent: ACCESS_WRITE,
      openOption: OPEN_CREATE_REPLACE,
    });
    // Access intent is at offset 20 + 2(chain) + 2(ccsid) + 4(wdh) + 2(fdccsid) = 30
    const access = buf.readUInt16BE(30);
    expect(access).toBe(ACCESS_WRITE);
  });

  it('uses small template when DSL < 16', () => {
    const buf = IFSReq.buildOpen({
      fileName: '/a.txt',
      datastreamLevel: 8,
    });
    const h = extractHeader(buf);
    expect(h.templateLen).toBe(36);
  });
});

describe('IFSReq.buildClose', () => {

  it('builds a close request with file handle', () => {
    const buf = IFSReq.buildClose({ fileHandle: 42 });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_CLOSE);
    expect(h.serverId).toBe(ServerID.FILE);
    // File handle at offset 22 (20 + 2 chain indicator)
    const handle = buf.readUInt32BE(22);
    expect(handle).toBe(42);
  });
});

describe('IFSReq.buildRead', () => {

  it('builds a read request with offset and length (DSL >= 16)', () => {
    const buf = IFSReq.buildRead({
      fileHandle: 100,
      offset: 1024,
      length: 512,
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_READ);
    expect(h.templateLen).toBe(38);
    // File handle at offset 22
    expect(buf.readUInt32BE(22)).toBe(100);
    // Read length at offset 34
    expect(buf.readUInt32BE(34)).toBe(512);
  });

  it('uses small template when DSL < 16', () => {
    const buf = IFSReq.buildRead({
      fileHandle: 1,
      offset: 0,
      length: 100,
      datastreamLevel: 8,
    });
    expect(buf.readUInt16BE(16)).toBe(22);
  });
});

describe('IFSReq.buildWrite', () => {

  it('builds a write request with data LL/CP', () => {
    const data = Buffer.from('Hello');
    const buf = IFSReq.buildWrite({
      fileHandle: 50,
      offset: 0,
      data,
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_WRITE);
    expect(h.serverId).toBe(ServerID.FILE);

    // File data should be at the end
    const dataCP = findCodePoint(buf, 20 + h.templateLen, CP_FILE_DATA);
    expect(dataCP).not.toBeNull();
    expect(dataCP.toString()).toBe('Hello');
  });

  it('sets sync flag when requested', () => {
    const buf = IFSReq.buildWrite({
      fileHandle: 1,
      offset: 0,
      data: Buffer.from('x'),
      sync: true,
    });
    // Data flags: offset 20 + 2(chain) + 4(handle) + 4(base) + 4(reloff) = 34
    const dataFlags = buf.readUInt16BE(34);
    expect(dataFlags).toBe(3); // 3 = sync write
  });
});

describe('IFSReq.buildListAttrs', () => {

  it('builds a list attrs request', () => {
    const buf = IFSReq.buildListAttrs({
      fileName: '/home/test/*',
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_LIST_ATTRS);
    expect(h.templateLen).toBe(20);
    const nameCP = findCodePoint(buf, 20 + 20, CP_FILE_NAME);
    expect(nameCP).not.toBeNull();
  });
});

describe('IFSReq.buildLookup', () => {

  it('builds a lookup request', () => {
    const buf = IFSReq.buildLookup({
      fileName: '/home/test.txt',
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_LOOKUP);
    expect(h.templateLen).toBe(22);
  });
});

describe('IFSReq.buildDeleteFile', () => {

  it('builds a delete file request', () => {
    const buf = IFSReq.buildDeleteFile({ fileName: '/tmp/old.txt' });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_DELETE_FILE);
    expect(h.templateLen).toBe(8);
  });
});

describe('IFSReq.buildCreateDir', () => {

  it('builds a create directory request', () => {
    const buf = IFSReq.buildCreateDir({ dirName: '/tmp/newdir' });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_CREATE_DIR);
    const nameCP = findCodePoint(buf, 20 + 8, CP_DIR_NAME);
    expect(nameCP).not.toBeNull();
  });
});

describe('IFSReq.buildDeleteDir', () => {

  it('builds a delete directory request', () => {
    const buf = IFSReq.buildDeleteDir({ dirName: '/tmp/olddir' });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_DELETE_DIR);
    expect(h.templateLen).toBe(10);
  });
});

describe('IFSReq.buildRename', () => {

  it('builds a rename request with source and target', () => {
    const buf = IFSReq.buildRename({
      sourceName: '/tmp/a.txt',
      targetName: '/tmp/b.txt',
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_RENAME);
    expect(h.templateLen).toBe(16);

    // Should have both source and target code points
    const srcCP = findCodePoint(buf, 20 + 16, CP_SOURCE_NAME);
    expect(srcCP).not.toBeNull();
    // Target follows source in the buffer
    const srcLL = buf.readUInt32BE(20 + 16);
    const tgtCP = findCodePoint(buf, 20 + 16 + srcLL, CP_TARGET_NAME);
    expect(tgtCP).not.toBeNull();
  });
});

describe('IFSReq.buildCopy', () => {

  it('builds a copy request', () => {
    const buf = IFSReq.buildCopy({
      sourceName: '/tmp/a.txt',
      targetName: '/tmp/b.txt',
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_COPY);
    expect(h.templateLen).toBe(16);
  });
});

describe('IFSReq.buildChangeAttrs', () => {

  it('builds a change attrs request', () => {
    const buf = IFSReq.buildChangeAttrs({
      fileName: '/tmp/test.txt',
      modifyDate: new Date('2024-01-15T12:00:00Z'),
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_CHANGE_ATTRS);
  });
});

describe('IFSReq.buildLockBytes', () => {

  it('builds a lock bytes request', () => {
    const buf = IFSReq.buildLockBytes({
      fileHandle: 10,
      offset: 0,
      length: 1024,
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_LOCK_BYTES);
  });
});

describe('IFSReq.buildUnlockBytes', () => {

  it('builds an unlock bytes request', () => {
    const buf = IFSReq.buildUnlockBytes({
      fileHandle: 10,
      offset: 0,
      length: 1024,
    });
    const h = extractHeader(buf);
    expect(h.reqRepId).toBe(REQ_UNLOCK_BYTES);
  });
});

// --- Reply parsing tests ---

describe('IFSRep.parseReturnCode', () => {

  it('parses a success return code', () => {
    const buf = Buffer.alloc(22);
    buf.writeUInt32BE(22, 0);
    buf.writeUInt16BE(2, 16); // template len = 2
    buf.writeUInt16BE(0x8009, 18); // close reply
    buf.writeUInt16BE(0, 20); // RC = 0
    const result = IFSRep.parseReturnCode(buf);
    expect(result.returnCode).toBe(RC_SUCCESS);
  });

  it('parses a file-not-found return code', () => {
    const buf = Buffer.alloc(22);
    buf.writeUInt32BE(22, 0);
    buf.writeUInt16BE(2, 16);
    buf.writeUInt16BE(0x800C, 18);
    buf.writeUInt16BE(2, 20); // RC = FILE_NOT_FOUND
    const result = IFSRep.parseReturnCode(buf);
    expect(result.returnCode).toBe(RC_FILE_NOT_FOUND);
  });

  it('throws on short buffer', () => {
    expect(() => IFSRep.parseReturnCode(Buffer.alloc(10))).toThrow();
  });
});

describe('IFSRep.parseOpen', () => {

  it('parses an open reply with file handle', () => {
    // Build a synthetic open reply
    const templateLen = 70;
    const totalLen = 20 + templateLen;
    const buf = Buffer.alloc(totalLen);
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REP_OPEN, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2; // chain
    buf.writeUInt32BE(0x00001234, off); off += 4; // file handle
    buf.writeUInt32BE(0x00005678, off); off += 4; // file id
    buf.writeUInt32BE(0, off); off += 4; // additional file ID
    buf.writeUInt16BE(819, off); off += 2; // file data ccsid
    buf.writeUInt16BE(1, off); off += 2; // action taken

    // Dates: 3 x 8 bytes
    const testDate = new Date('2024-06-01T00:00:00Z');
    const secs = Math.floor(testDate.getTime() / 1000);
    for (let i = 0; i < 3; i++) {
      buf.writeUInt32BE(secs, off); off += 4;
      buf.writeUInt32BE(0, off); off += 4;
    }

    buf.writeUInt32BE(1024, off); off += 4; // file size (4-byte)
    buf.writeUInt32BE(0x20, off); off += 4; // fixed attrs (archive)

    const result = IFSRep.parseOpen(buf);
    expect(result.returnCode).toBe(0);
    expect(result.fileHandle).toBe(0x1234);
    expect(result.fileId).toBe(0x5678);
    expect(result.fileDataCCSID).toBe(819);
    expect(result.fileSize).toBe(1024);
  });

  it('handles error reply (small template)', () => {
    const buf = Buffer.alloc(22);
    buf.writeUInt32BE(22, 0);
    buf.writeUInt16BE(2, 16);
    buf.writeUInt16BE(REP_OPEN, 18);
    buf.writeUInt16BE(2, 20); // RC = FILE_NOT_FOUND
    const result = IFSRep.parseOpen(buf);
    expect(result.returnCode).toBe(2);
    expect(result.fileHandle).toBe(0);
  });
});

describe('IFSRep.parseRead', () => {

  it('parses a read reply with file data', () => {
    const fileData = Buffer.from('Hello World');
    const dataLL = 6 + fileData.length;
    const templateLen = 4; // chain(2) + ccsid(2)
    const totalLen = 20 + templateLen + dataLL;
    const buf = Buffer.alloc(totalLen);

    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REP_READ, 18);
    buf.writeUInt16BE(0, 20); // chain
    buf.writeUInt16BE(819, 22); // ccsid

    // File data LL/CP
    let off = 24;
    buf.writeUInt32BE(dataLL, off);
    buf.writeUInt16BE(0x0020, off + 4); // CP_FILE_DATA
    fileData.copy(buf, off + 6);

    const result = IFSRep.parseRead(buf);
    expect(result.returnCode).toBe(0);
    expect(result.ccsid).toBe(819);
    expect(result.data.toString()).toBe('Hello World');
  });

  it('handles end-of-file reply', () => {
    const buf = Buffer.alloc(22);
    buf.writeUInt32BE(22, 0);
    buf.writeUInt16BE(2, 16); // small template = return code
    buf.writeUInt16BE(REP_READ, 18);
    buf.writeUInt16BE(22, 20); // RC_NO_MORE_DATA
    const result = IFSRep.parseRead(buf);
    expect(result.returnCode).toBe(22);
    expect(result.data.length).toBe(0);
  });
});

describe('IFSRep.parseWrite', () => {

  it('parses a successful write reply', () => {
    const buf = Buffer.alloc(32);
    buf.writeUInt32BE(32, 0);
    buf.writeUInt16BE(12, 16); // template len
    buf.writeUInt16BE(REP_WRITE, 18);
    buf.writeUInt16BE(0, 20); // chain
    buf.writeUInt16BE(0, 22); // return code
    buf.writeUInt32BE(500, 24); // previous file size
    buf.writeUInt32BE(0, 28); // bytes not written

    const result = IFSRep.parseWrite(buf);
    expect(result.returnCode).toBe(0);
    expect(result.previousFileSize).toBe(500);
    expect(result.bytesNotWritten).toBe(0);
  });
});

describe('IFSRep.parseListAttrs', () => {

  it('handles no-more-files terminator', () => {
    const buf = Buffer.alloc(22);
    buf.writeUInt32BE(22, 0);
    buf.writeUInt16BE(2, 16);
    buf.writeUInt16BE(0x800A, 18);
    buf.writeUInt16BE(RC_NO_MORE_FILES, 20);
    const result = IFSRep.parseListAttrs(buf);
    expect(result.returnCode).toBe(RC_NO_MORE_FILES);
    expect(result.entry).toBeNull();
  });
});

describe('IFSRep.getReplyId', () => {

  it('extracts reply ID from buffer', () => {
    const buf = Buffer.alloc(20);
    buf.writeUInt16BE(0x8002, 18);
    expect(IFSRep.getReplyId(buf)).toBe(0x8002);
  });

  it('returns 0 for short buffer', () => {
    expect(IFSRep.getReplyId(Buffer.alloc(5))).toBe(0);
  });
});

describe('IFSRep.returnCodeMessage', () => {

  it('returns meaningful messages', () => {
    expect(IFSRep.returnCodeMessage(0)).toBe('Success');
    expect(IFSRep.returnCodeMessage(2)).toBe('File not found');
    expect(IFSRep.returnCodeMessage(5)).toBe('Access denied');
    expect(IFSRep.returnCodeMessage(999)).toContain('Unknown');
  });
});
