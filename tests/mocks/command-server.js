/**
 * Lightweight mock command server for contract testing.
 *
 * Responds to:
 *   - Exchange Seed (0x7001) -> seed reply
 *   - Start Server (0x7002) -> start reply
 *   - Exchange Attributes (0x1001) -> attributes reply
 *   - Run Command (0x1002) -> command completion reply
 *   - Call Program (0x1003) -> program call reply
 *
 * Usage:
 *   import { createMockCommandServer } from './command-server.js';
 *   const server = await createMockCommandServer();
 *   // ... connect client to server.port ...
 *   server.close();
 *
 * Source-trace: validates CommandReq, CommandRep protocol
 */

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

const HEADER_LENGTH = 20;
const CMD_SERVER_ID = 0xE008;

/**
 * Build a seed exchange reply.
 */
function buildSeedExchangeReply(reqBuf) {
  const serverSeed = randomBytes(8);
  const totalLen = 32;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);
  buf.writeUInt16BE(reqBuf.readUInt16BE(6), 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(reqBuf.readUInt32BE(12), 12);
  buf.writeUInt16BE(8, 16);
  buf.writeUInt16BE(0xF001, 18);

  buf.writeUInt32BE(0, 20);
  serverSeed.copy(buf, 24);

  return buf;
}

/**
 * Build a start server reply (success).
 */
function buildStartServerReply(reqBuf) {
  const totalLen = 24;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);
  buf.writeUInt16BE(reqBuf.readUInt16BE(6), 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(reqBuf.readUInt32BE(12), 12);
  buf.writeUInt16BE(4, 16);
  buf.writeUInt16BE(0xF002, 18);

  buf.writeUInt32BE(0, 20); // return code = success

  return buf;
}

/**
 * Build a command exchange attributes reply.
 */
function buildExchangeAttrReply(reqBuf) {
  const totalLen = 34;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);
  buf.writeUInt16BE(CMD_SERVER_ID, 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(reqBuf.readUInt32BE(12), 12);
  buf.writeUInt16BE(14, 16);
  buf.writeUInt16BE(0x1001, 18); // exchange attr reply uses same ID

  // Template: return CCSID, NLV, server version, datastream level
  buf.writeUInt32BE(37, 20);     // CCSID
  buf[24] = 0xF2; buf[25] = 0xF9; buf[26] = 0xF2; buf[27] = 0xF4; // NLV
  buf.writeUInt32BE(1, 28);      // server version
  buf.writeUInt16BE(10, 32);     // datastream level

  return buf;
}

/**
 * Build a run-command completion reply (success, no messages).
 */
function buildRunCommandReply(reqBuf) {
  // Minimal reply: header + 4-byte return code
  const totalLen = 24;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);
  buf.writeUInt16BE(CMD_SERVER_ID, 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(reqBuf.readUInt32BE(12), 12);
  buf.writeUInt16BE(4, 16);
  buf.writeUInt16BE(0x8002, 18); // command completion reply

  buf.writeUInt32BE(0, 20); // return code = 0 (success)

  return buf;
}

/**
 * Build a call-program reply (success, no output params, no messages).
 */
function buildCallProgramReply(reqBuf) {
  const totalLen = 24;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);
  buf.writeUInt16BE(CMD_SERVER_ID, 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(reqBuf.readUInt32BE(12), 12);
  buf.writeUInt16BE(4, 16);
  buf.writeUInt16BE(0x8003, 18); // program call reply

  buf.writeUInt32BE(0, 20); // return code = 0

  return buf;
}

/**
 * Handle a complete datastream frame.
 */
function handleFrame(frame) {
  if (frame.length < HEADER_LENGTH) return null;

  const reqRepId = frame.readUInt16BE(18);

  switch (reqRepId) {
    case 0x7001: return buildSeedExchangeReply(frame);
    case 0x7002: return buildStartServerReply(frame);
    case 0x1001: return buildExchangeAttrReply(frame);
    case 0x1002: return buildRunCommandReply(frame);
    case 0x1003: return buildCallProgramReply(frame);
    default: return null;
  }
}

/**
 * Create a mock command server listening on a random port.
 *
 * @returns {Promise<{ port: number, close: () => void, requests: Array }>}
 */
export function createMockCommandServer() {
  return new Promise((resolve, reject) => {
    const requests = [];

    const server = createServer((socket) => {
      let pending = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= HEADER_LENGTH) {
          const totalLen = pending.readUInt32BE(0);
          if (pending.length < totalLen) break;

          const frame = Buffer.from(pending.subarray(0, totalLen));
          pending = pending.subarray(totalLen);

          requests.push({
            reqRepId: frame.readUInt16BE(18),
            serverId: frame.readUInt16BE(6),
            length: frame.length,
          });

          const reply = handleFrame(frame);
          if (reply) {
            socket.write(reply);
          }
        }
      });

      socket.on('error', () => {});
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => server.close(),
        requests,
      });
    });

    server.on('error', reject);
  });
}
