/**
 * Lightweight mock signon server for contract testing.
 *
 * Responds to:
 *   - Exchange Seed (0x7001) -> seed reply (0xF001)
 *   - Signon Exchange Attributes (0x7003) -> attributes reply (0xF003)
 *
 * Usage:
 *   import { createMockSignonServer } from './signon-server.js';
 *   const server = await createMockSignonServer();
 *   // ... connect client to server.port ...
 *   server.close();
 *
 * Source-trace: validates SignonExchangeReq, SignonExchangeRep, SeedExchange
 */

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

const HEADER_LENGTH = 20;

/** Server version mimicking V7R5. */
const SERVER_VERSION = 0x00070500;
/** Server level for signon. */
const SERVER_LEVEL = 10;
/** Default password level returned. */
const DEFAULT_PASSWORD_LEVEL = 2;

/**
 * Build a signon exchange attributes reply.
 *
 * @param {Buffer} reqBuf - The incoming request buffer
 * @param {number} passwordLevel - Password level to report
 * @returns {Buffer}
 */
function buildExchangeAttrReply(reqBuf, passwordLevel) {
  const serverSeed = randomBytes(8);
  const jobName = Buffer.from('QUSER     000001/QPADEV0001', 'ascii');
  const jobNameLL = 10 + jobName.length;
  const totalLen = 42 + 14 + 7 + jobNameLL + 7;
  const buf = Buffer.alloc(totalLen);

  // Header
  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);
  buf.writeUInt16BE(0xE009, 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(reqBuf.readUInt32BE(12), 12); // echo correlation
  buf.writeUInt16BE(0, 16);
  buf.writeUInt16BE(0xF003, 18);

  // Return code = 0
  buf.writeUInt32BE(0, 20);

  // Server version
  buf.writeUInt32BE(10, 24);
  buf.writeUInt16BE(0x1101, 28);
  buf.writeUInt32BE(SERVER_VERSION, 30);

  // Server level
  buf.writeUInt32BE(8, 34);
  buf.writeUInt16BE(0x1102, 38);
  buf.writeUInt16BE(SERVER_LEVEL, 40);

  let offset = 42;

  // Server seed
  buf.writeUInt32BE(14, offset);
  buf.writeUInt16BE(0x1103, offset + 4);
  serverSeed.copy(buf, offset + 6);
  offset += 14;

  // Password level
  buf.writeUInt32BE(7, offset);
  buf.writeUInt16BE(0x1119, offset + 4);
  buf[offset + 6] = passwordLevel;
  offset += 7;

  // Job name
  buf.writeUInt32BE(jobNameLL, offset);
  buf.writeUInt16BE(0x111F, offset + 4);
  buf.writeUInt32BE(37, offset + 6);
  jobName.copy(buf, offset + 10);
  offset += jobNameLL;

  // AAF indicator
  buf.writeUInt32BE(7, offset);
  buf.writeUInt16BE(0x112E, offset + 4);
  buf[offset + 6] = 0x00;

  return buf;
}

/**
 * Build a seed exchange reply.
 *
 * @param {Buffer} reqBuf - The incoming request buffer
 * @returns {Buffer}
 */
function buildSeedExchangeReply(reqBuf) {
  const serverSeed = randomBytes(8);
  const totalLen = 32;
  const buf = Buffer.alloc(totalLen);

  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0x0000, 4);
  buf.writeUInt16BE(reqBuf.readUInt16BE(6), 6); // echo server ID
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(reqBuf.readUInt32BE(12), 12); // echo correlation
  buf.writeUInt16BE(8, 16);
  buf.writeUInt16BE(0xF001, 18);

  // Return code = 0
  buf.writeUInt32BE(0, 20);
  // Server seed
  serverSeed.copy(buf, 24);

  return buf;
}

/**
 * Handle a complete datastream frame.
 *
 * @param {Buffer} frame
 * @param {object} opts
 * @returns {Buffer|null}
 */
function handleFrame(frame, opts) {
  if (frame.length < HEADER_LENGTH) return null;

  const reqRepId = frame.readUInt16BE(18);

  switch (reqRepId) {
    case 0x7001: // EXCHANGE_SEED_REQ
      return buildSeedExchangeReply(frame);

    case 0x7003: // SIGNON_EXCHANGE_ATTR_REQ
      return buildExchangeAttrReply(frame, opts.passwordLevel);

    default:
      // Unknown request - return a minimal error reply
      return null;
  }
}

/**
 * Create a mock signon server listening on a random port.
 *
 * @param {object} [opts]
 * @param {number} [opts.passwordLevel=2] - Password level to report
 * @returns {Promise<{ port: number, close: () => void, connections: number }>}
 */
export function createMockSignonServer(opts = {}) {
  const { passwordLevel = DEFAULT_PASSWORD_LEVEL } = opts;

  return new Promise((resolve, reject) => {
    let connectionCount = 0;

    const server = createServer((socket) => {
      connectionCount++;
      let pending = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= HEADER_LENGTH) {
          const totalLen = pending.readUInt32BE(0);
          if (pending.length < totalLen) break;

          const frame = pending.subarray(0, totalLen);
          pending = pending.subarray(totalLen);

          const reply = handleFrame(Buffer.from(frame), { passwordLevel });
          if (reply) {
            socket.write(reply);
          }
        }
      });

      socket.on('error', () => {
        // Silently ignore client disconnects
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => server.close(),
        get connections() { return connectionCount; },
      });
    });

    server.on('error', reject);
  });
}
