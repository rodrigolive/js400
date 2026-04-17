/**
 * Contract tests for the mock command server.
 * Validates the mock responds to command and program call requests.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { createConnection } from 'node:net';
import { createMockCommandServer } from '../mocks/command-server.js';
import { DataStream } from '../../src/transport/datastream.js';
import { CommandReq } from '../../src/command/protocol/CommandReq.js';

let server;

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
});

describe('mock command server', () => {
  test('starts and listens on a port', async () => {
    server = await createMockCommandServer();
    expect(server.port).toBeGreaterThan(0);
    expect(server.requests).toBeInstanceOf(Array);
  });

  test('responds to exchange-attributes request', async () => {
    server = await createMockCommandServer();

    const reqBuf = CommandReq.buildExchangeAttributes({ ccsid: 37 });
    const replyBuf = await sendRequest(server.port, reqBuf);

    const header = DataStream.parseHeader(replyBuf);
    expect(header.serverId).toBe(0xE008);
    expect(header.reqRepId).toBe(0x1001);
    expect(header.templateLen).toBe(14);

    // Check returned CCSID
    expect(replyBuf.readUInt32BE(20)).toBe(37);

    expect(server.requests.length).toBe(1);
    expect(server.requests[0].reqRepId).toBe(0x1001);
  });

  test('responds to seed exchange request', async () => {
    server = await createMockCommandServer();

    const reqBuf = buildSeedExchangeReq(0xE008);
    const replyBuf = await sendRequest(server.port, reqBuf);

    const header = DataStream.parseHeader(replyBuf);
    expect(header.reqRepId).toBe(0xF001);
    expect(replyBuf.readUInt32BE(20)).toBe(0);
  });

  test('responds to run-command request', async () => {
    server = await createMockCommandServer();

    const reqBuf = CommandReq.buildRunCommand({
      command: 'DSPLIB QGPL',
      datastreamLevel: 10,
      ccsid: 37,
    });
    const replyBuf = await sendRequest(server.port, reqBuf);

    const header = DataStream.parseHeader(replyBuf);
    expect(header.reqRepId).toBe(0x8002); // command completion
    expect(replyBuf.readUInt32BE(20)).toBe(0); // success
  });

  test('tracks all received requests', async () => {
    server = await createMockCommandServer();
    expect(server.requests.length).toBe(0);

    await sendRequest(server.port, buildSeedExchangeReq(0xE008));
    expect(server.requests.length).toBe(1);
    expect(server.requests[0].reqRepId).toBe(0x7001);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function buildSeedExchangeReq(serverId) {
  const buf = Buffer.alloc(28);
  buf.writeUInt32BE(28, 0);
  buf[4] = 0x03;
  buf.writeUInt16BE(serverId, 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(1, 12);
  buf.writeUInt16BE(8, 16);
  buf.writeUInt16BE(0x7001, 18);
  for (let i = 0; i < 8; i++) buf[20 + i] = i + 1;
  return buf;
}

function sendRequest(port, reqBuf) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(reqBuf);
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
