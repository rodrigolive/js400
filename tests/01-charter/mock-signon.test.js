/**
 * Contract tests for the mock signon server.
 * Validates the mock responds correctly to exchange-attribute requests.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { createConnection } from 'node:net';
import { createMockSignonServer } from '../mocks/signon-server.js';
import { DataStream } from '../../src/transport/datastream.js';
import { SignonExchangeReq } from '../../src/auth/protocol/SignonExchangeReq.js';
import { SignonExchangeRep } from '../../src/auth/protocol/SignonExchangeRep.js';
import { ServerID } from '../../src/core/constants.js';

let server;

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
});

describe('mock signon server', () => {
  test('starts and listens on a port', async () => {
    server = await createMockSignonServer();
    expect(server.port).toBeGreaterThan(0);
    expect(typeof server.close).toBe('function');
  });

  test('responds to exchange-attributes request', async () => {
    server = await createMockSignonServer({ passwordLevel: 2 });

    const replyBuf = await sendRequest(server.port, () => {
      const { buffer } = SignonExchangeReq.build({
        serverId: ServerID.SIGNON,
        clientSeed: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      });
      return buffer;
    });

    expect(replyBuf.length).toBeGreaterThanOrEqual(42);

    const header = DataStream.parseHeader(replyBuf);
    expect(header.serverId).toBe(0xE009);
    expect(header.reqRepId).toBe(0xF003);

    const reply = SignonExchangeRep.parse(replyBuf);
    expect(reply.returnCode).toBe(0);
    expect(reply.serverVersion).toBe(0x00070500);
    expect(reply.serverLevel).toBe(10);
    expect(reply.passwordLevel).toBe(2);
    expect(reply.serverSeed).not.toBeNull();
    expect(reply.serverSeed.length).toBe(8);
  });

  test('responds to seed exchange request', async () => {
    server = await createMockSignonServer();

    const reqBuf = buildSeedExchangeReq();
    const replyBuf = await sendRequest(server.port, () => reqBuf);

    const header = DataStream.parseHeader(replyBuf);
    expect(header.reqRepId).toBe(0xF001);
    expect(replyBuf.readUInt32BE(20)).toBe(0); // return code
  });

  test('reports correct connection count', async () => {
    server = await createMockSignonServer();
    expect(server.connections).toBe(0);

    await sendRequest(server.port, () => buildSeedExchangeReq());
    expect(server.connections).toBe(1);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function buildSeedExchangeReq() {
  const buf = Buffer.alloc(28);
  buf.writeUInt32BE(28, 0);
  buf[4] = 0x03;
  buf.writeUInt16BE(0xE009, 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(1, 12);
  buf.writeUInt16BE(8, 16);
  buf.writeUInt16BE(0x7001, 18);
  // 8 bytes client seed
  for (let i = 0; i < 8; i++) buf[20 + i] = i + 1;
  return buf;
}

function sendRequest(port, buildFn) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(buildFn());
    });

    const chunks = [];
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      if (combined.length >= 4) {
        const expected = combined.readUInt32BE(0);
        if (combined.length >= expected) {
          socket.end();
          resolve(combined.subarray(0, expected));
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error('Timeout'));
    });
  });
}
