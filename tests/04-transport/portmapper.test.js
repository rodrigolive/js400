/**
 * Port mapper reply parsing tests (mock, no live connection).
 */
import { describe, test, expect } from 'bun:test';
import { PortMapper } from '../../src/transport/PortMapper.js';
import { Service, DefaultPort, DefaultSecurePort, ServiceName } from '../../src/core/constants.js';

describe('PortMapper', () => {
  test('parseReply: success reply (0x2B)', () => {
    const reply = Buffer.alloc(5);
    reply[0] = 0x2B; // '+'
    reply.writeUInt32BE(8476, 1);
    const result = PortMapper.parseReply(reply);
    expect(result.success).toBe(true);
    expect(result.port).toBe(8476);
  });

  test('parseReply: failure reply (not 0x2B)', () => {
    const reply = Buffer.alloc(5);
    reply[0] = 0x2D; // '-'
    reply.writeUInt32BE(0, 1);
    const result = PortMapper.parseReply(reply);
    expect(result.success).toBe(false);
  });

  test('parseReply: short buffer returns failure', () => {
    const result = PortMapper.parseReply(Buffer.alloc(3));
    expect(result.success).toBe(false);
    expect(result.port).toBe(0);
  });

  test('parseReply: null returns failure', () => {
    const result = PortMapper.parseReply(null);
    expect(result.success).toBe(false);
  });

  test('buildRequest creates ASCII buffer', () => {
    const buf = PortMapper.buildRequest('as-signon');
    expect(buf.toString('ascii')).toBe('as-signon');
    expect(buf.length).toBe(9);
  });

  test('buildRequest for secure appends -s', () => {
    const buf = PortMapper.buildRequest('as-signon-s');
    expect(buf.toString('ascii')).toBe('as-signon-s');
  });

  test('getDefaultPort returns correct ports', () => {
    expect(PortMapper.getDefaultPort(Service.SIGNON)).toBe(8476);
    expect(PortMapper.getDefaultPort(Service.SIGNON, true)).toBe(9476);
    expect(PortMapper.getDefaultPort(Service.COMMAND)).toBe(8475);
    expect(PortMapper.getDefaultPort(Service.COMMAND, true)).toBe(9475);
    expect(PortMapper.getDefaultPort(Service.DATABASE)).toBe(8471);
    expect(PortMapper.getDefaultPort(Service.FILE)).toBe(8473);
    expect(PortMapper.getDefaultPort(Service.CENTRAL)).toBe(8470);
  });

  test('all service names are defined', () => {
    for (const key of Object.keys(Service)) {
      const id = Service[key];
      expect(ServiceName[id]).toBeDefined();
      expect(typeof ServiceName[id]).toBe('string');
      expect(ServiceName[id].startsWith('as-')).toBe(true);
    }
  });

  test('clearCache does not throw', () => {
    PortMapper.clearCache();
  });

  test('parseReply round-trip with all standard ports', () => {
    for (const key of Object.keys(Service)) {
      const id = Service[key];
      const port = DefaultPort[id];
      if (port > 0) {
        const reply = Buffer.alloc(5);
        reply[0] = 0x2B;
        reply.writeUInt32BE(port, 1);
        const result = PortMapper.parseReply(reply);
        expect(result.success).toBe(true);
        expect(result.port).toBe(port);
      }
    }
  });
});
