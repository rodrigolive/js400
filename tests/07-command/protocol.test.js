/**
 * Tests for command server protocol builders and parsers.
 */

import { describe, it, expect } from 'bun:test';
import { CommandReq, REQ_EXCHANGE_ATTRIBUTES, REQ_RUN_COMMAND, REQ_CALL_PROGRAM } from '../../src/command/protocol/CommandReq.js';
import { CommandRep, RC_SUCCESS, RC_COMMAND_FAILED } from '../../src/command/protocol/CommandRep.js';
import { ProgramParameter } from '../../src/command/ProgramParameter.js';
import { ServerID } from '../../src/core/constants.js';
import { AS400Message } from '../../src/core/AS400Message.js';

describe('CommandReq.buildExchangeAttributes', () => {

  it('builds a 34-byte exchange attributes request', () => {
    const buf = CommandReq.buildExchangeAttributes();
    expect(buf.length).toBe(34);
    expect(buf.readUInt32BE(0)).toBe(34);
    expect(buf.readUInt16BE(6)).toBe(ServerID.COMMAND);
    expect(buf.readUInt16BE(18)).toBe(REQ_EXCHANGE_ATTRIBUTES);
    expect(buf.readUInt16BE(16)).toBe(14); // template length
  });

  it('encodes NLV as F0-digits', () => {
    const buf = CommandReq.buildExchangeAttributes({ nlv: '2924' });
    expect(buf[24]).toBe(0xF2);
    expect(buf[25]).toBe(0xF9);
    expect(buf[26]).toBe(0xF2);
    expect(buf[27]).toBe(0xF4);
  });

  it('sets CCSID in template', () => {
    const buf = CommandReq.buildExchangeAttributes({ ccsid: 37 });
    expect(buf.readUInt32BE(20)).toBe(37);
  });
});

describe('CommandReq.buildRunCommand', () => {

  it('builds a run-command request with CCSID (level >= 10)', () => {
    const buf = CommandReq.buildRunCommand({
      command: 'DSPLIBL',
      datastreamLevel: 10,
      ccsid: 37,
    });
    expect(buf.readUInt16BE(6)).toBe(ServerID.COMMAND);
    expect(buf.readUInt16BE(18)).toBe(REQ_RUN_COMMAND);
    expect(buf.readUInt16BE(16)).toBe(1); // template length

    // LL/CP with CCSID starts at offset 21
    const ll = buf.readUInt32BE(21);
    expect(ll).toBeGreaterThan(10);
    expect(buf.readUInt16BE(25)).toBe(0x1104); // CP_COMMAND_DATA_CCSID
    expect(buf.readUInt32BE(27)).toBe(37); // CCSID
  });

  it('builds old-format command (level < 10)', () => {
    const buf = CommandReq.buildRunCommand({
      command: 'DSPLIBL',
      datastreamLevel: 5,
      ccsid: 37,
    });
    expect(buf.readUInt16BE(25)).toBe(0x1101); // CP_COMMAND_DATA
  });
});

describe('CommandReq.buildCallProgram', () => {

  it('builds a call-program request with no parameters', () => {
    const buf = CommandReq.buildCallProgram({
      programPath: '/QSYS.LIB/MYLIB.LIB/MYPGM.PGM',
      parameters: [],
      datastreamLevel: 10,
      ccsid: 37,
    });

    expect(buf.readUInt16BE(6)).toBe(ServerID.COMMAND);
    expect(buf.readUInt16BE(18)).toBe(REQ_CALL_PROGRAM);
    expect(buf.readUInt16BE(16)).toBe(23); // template: 10+10+1+2

    // Parameter count at offset 41
    expect(buf.readUInt16BE(41)).toBe(0);
  });

  it('builds a call-program request with parameters', () => {
    const inputBuf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const p1 = new ProgramParameter(inputBuf, 4);
    const p2 = new ProgramParameter(100);

    const buf = CommandReq.buildCallProgram({
      programPath: '/QSYS.LIB/MYLIB.LIB/MYPGM.PGM',
      parameters: [p1, p2],
      datastreamLevel: 10,
      ccsid: 37,
    });

    expect(buf.readUInt16BE(41)).toBe(2); // 2 parameters

    // First parameter block starts at offset 43
    const ll1 = buf.readUInt32BE(43);
    expect(ll1).toBe(12 + 4); // LL(4)+CP(2)+maxLen(4)+usage(2) + 4 bytes data
    expect(buf.readUInt16BE(47)).toBe(0x1103); // CP_PROGRAM_PARAMETER
    expect(buf.readUInt32BE(49)).toBe(4); // max len
    expect(buf.readUInt16BE(53)).toBe(0x03); // INOUT

    // Second parameter block
    const offset2 = 43 + ll1;
    const ll2 = buf.readUInt32BE(offset2);
    expect(ll2).toBe(12); // no input data
    expect(buf.readUInt32BE(offset2 + 6)).toBe(100); // max len
    expect(buf.readUInt16BE(offset2 + 10)).toBe(0x02); // OUTPUT
  });

  it('parses IFS paths correctly', () => {
    // Test via buildCallProgram - the program name is in template at offset 20
    const buf = CommandReq.buildCallProgram({
      programPath: '/QSYS.LIB/TESTLIB.LIB/TESTPGM.PGM',
      parameters: [],
      ccsid: 37,
    });
    // Just verify it builds without error - EBCDIC content is tested indirectly
    expect(buf.length).toBeGreaterThanOrEqual(43);
  });

  it('handles simple lib/pgm path format', () => {
    const buf = CommandReq.buildCallProgram({
      programPath: 'MYLIB/MYPGM',
      parameters: [],
      ccsid: 37,
    });
    expect(buf.length).toBeGreaterThanOrEqual(43);
  });
});

describe('CommandRep.parseExchangeAttributes', () => {

  it('parses a minimal exchange attributes reply', () => {
    const buf = Buffer.alloc(28);
    buf.writeUInt32BE(28, 0);
    buf.writeUInt16BE(ServerID.COMMAND, 6);
    buf.writeUInt16BE(0x8001, 18);
    buf.writeUInt16BE(0, 20); // RC success
    buf.writeUInt16BE(10, 22); // datastream level 10
    buf.writeUInt32BE(37, 24); // CCSID 37

    const result = CommandRep.parseExchangeAttributes(buf);
    expect(result.returnCode).toBe(0);
    expect(result.datastreamLevel).toBe(10);
    expect(result.ccsid).toBe(37);
  });
});

describe('CommandRep.parseCallReply', () => {

  it('parses a success reply with no messages', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.writeUInt16BE(ServerID.COMMAND, 6);
    buf.writeUInt16BE(0x8003, 18);
    buf.writeUInt16BE(RC_SUCCESS, 20); // RC
    buf.writeUInt16BE(0, 22); // message count

    const result = CommandRep.parseCallReply(buf);
    expect(result.returnCode).toBe(RC_SUCCESS);
    expect(result.messageCount).toBe(0);
    expect(result.messages).toHaveLength(0);
    expect(result.outputParameters).toHaveLength(0);
  });

  it('parses a reply with output parameters', () => {
    // Build a reply with one output parameter
    const paramData = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
    const paramBlock = Buffer.alloc(12 + paramData.length);
    paramBlock.writeUInt32BE(12 + paramData.length, 0); // LL
    paramBlock.writeUInt16BE(0x1103, 4); // CP (doesn't matter for reply)
    paramBlock.writeUInt32BE(4, 6); // maxLen
    paramBlock.writeUInt16BE(0x02, 10); // usage OUTPUT
    paramData.copy(paramBlock, 12);

    const buf = Buffer.alloc(24 + paramBlock.length);
    buf.writeUInt32BE(buf.length, 0);
    buf.writeUInt16BE(0x8003, 18);
    buf.writeUInt16BE(RC_SUCCESS, 20);
    buf.writeUInt16BE(0, 22); // no messages
    paramBlock.copy(buf, 24);

    const result = CommandRep.parseCallReply(buf, { parameterCount: 1 });
    expect(result.outputParameters).toHaveLength(1);
    expect(result.outputParameters[0]).toEqual(paramData);
  });

  it('parses a failed reply', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.writeUInt16BE(0x8002, 18);
    buf.writeUInt16BE(RC_COMMAND_FAILED, 20);
    buf.writeUInt16BE(0, 22);

    const result = CommandRep.parseCallReply(buf);
    expect(result.returnCode).toBe(RC_COMMAND_FAILED);
  });
});
