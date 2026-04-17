/**
 * Seed exchange request layout verification.
 */
import { describe, test, expect } from 'bun:test';
import { SeedExchange } from '../../src/transport/SeedExchange.js';
import { ServerID, EXCHANGE_SEED_REQ, EXCHANGE_SEED_REP } from '../../src/core/constants.js';

describe('SeedExchange', () => {
  test('buildRequest creates 28-byte buffer', () => {
    const { buffer, clientSeed } = SeedExchange.buildRequest(ServerID.SIGNON);
    expect(buffer.length).toBe(28);
    expect(clientSeed.length).toBe(8);
  });

  test('buildRequest header layout is correct', () => {
    const seed = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const { buffer } = SeedExchange.buildRequest(ServerID.SIGNON, seed);

    // Total length
    expect(buffer.readUInt32BE(0)).toBe(28);
    // Client attributes
    expect(buffer[4]).toBe(0x03);
    // Server attributes
    expect(buffer[5]).toBe(0x00);
    // Server ID
    expect(buffer.readUInt16BE(6)).toBe(ServerID.SIGNON);
    // CS instance
    expect(buffer.readUInt32BE(8)).toBe(0);
    // Correlation
    expect(buffer.readUInt32BE(12)).toBe(0);
    // Template length = 8
    expect(buffer.readUInt16BE(16)).toBe(8);
    // Request/Reply ID = 0x7001
    expect(buffer.readUInt16BE(18)).toBe(EXCHANGE_SEED_REQ);
    // Client seed at offset 20
    expect(buffer[20]).toBe(0x01);
    expect(buffer[27]).toBe(0x08);
  });

  test('buildRequest for different server IDs', () => {
    const servers = [
      ServerID.CENTRAL,
      ServerID.FILE,
      ServerID.PRINT,
      ServerID.DATABASE,
      ServerID.DATAQUEUE,
      ServerID.COMMAND,
      ServerID.SIGNON,
      ServerID.HOSTCNN,
    ];

    for (const sid of servers) {
      const { buffer } = SeedExchange.buildRequest(sid);
      expect(buffer.readUInt16BE(6)).toBe(sid);
      expect(buffer.readUInt16BE(18)).toBe(EXCHANGE_SEED_REQ);
    }
  });

  test('buildRequest generates random seed when not provided', () => {
    const { clientSeed: s1 } = SeedExchange.buildRequest(ServerID.SIGNON);
    const { clientSeed: s2 } = SeedExchange.buildRequest(ServerID.SIGNON);
    // Extremely unlikely to be equal
    expect(Buffer.compare(s1, s2)).not.toBe(0);
  });

  test('parseReply extracts server seed and attributes', () => {
    // Build a minimal reply (32 bytes)
    const reply = Buffer.alloc(32);
    reply.writeUInt32BE(32, 0);           // total length
    reply.writeUInt16BE(0x0000, 4);       // header ID
    reply.writeUInt16BE(ServerID.SIGNON, 6);
    reply.writeUInt32BE(0, 8);            // CS instance
    reply.writeUInt32BE(0, 12);           // correlation
    reply.writeUInt16BE(12, 16);          // template length
    reply.writeUInt16BE(EXCHANGE_SEED_REP, 18); // req/rep ID
    reply.writeUInt32BE(0, 20);           // return code = 0 (success)
    // Server seed at offset 24
    reply[24] = 0xAA;
    reply[25] = 0xBB;
    reply[26] = 0xCC;
    reply[27] = 0xDD;
    reply[28] = 0x11;
    reply[29] = 0x22;
    reply[30] = 0x33;
    reply[31] = 0x44;
    // Server attributes
    reply[5] = 0x03; // password level >= 2

    const result = SeedExchange.parseReply(reply);
    expect(result.returnCode).toBe(0);
    expect(result.serverSeed.length).toBe(8);
    expect(result.serverSeed[0]).toBe(0xAA);
    expect(result.serverSeed[7]).toBe(0x44);
    expect(result.serverAttributes).toBe(0x03);
    expect(result.aafIndicator).toBe(false);
  });

  test('parseReply throws on short buffer', () => {
    expect(() => SeedExchange.parseReply(Buffer.alloc(10))).toThrow();
  });

  test('parseReply throws on non-zero return code', () => {
    const reply = Buffer.alloc(32);
    reply.writeUInt32BE(32, 0);
    reply.writeUInt16BE(ServerID.SIGNON, 6);
    reply.writeUInt16BE(EXCHANGE_SEED_REP, 18);
    reply.writeUInt32BE(1, 20); // RC=1 => failure
    expect(() => SeedExchange.parseReply(reply)).toThrow(/Seed exchange failed/);
  });

  test('parseReply detects AAF indicator code point', () => {
    // Build reply with AAF code point at offset 32
    const llcpLen = 7; // LL(4) + CP(2) + data(1)
    const reply = Buffer.alloc(32 + llcpLen);
    reply.writeUInt32BE(32 + llcpLen, 0);
    reply.writeUInt16BE(ServerID.SIGNON, 6);
    reply.writeUInt16BE(EXCHANGE_SEED_REP, 18);
    reply.writeUInt32BE(0, 20); // RC=0
    // LL/CP at offset 32
    reply.writeUInt32BE(llcpLen, 32);
    reply.writeUInt16BE(0x112E, 36);
    reply[38] = 0x01; // AAF = true

    const result = SeedExchange.parseReply(reply);
    expect(result.aafIndicator).toBe(true);
  });
});
