/**
 * DataStream header build/parse round-trip tests for all 9 service IDs.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { DataStream } from '../../src/transport/DataStream.js';
import { ServiceToServerID, Service, ServerID } from '../../src/core/constants.js';

beforeEach(() => {
  DataStream.resetCorrelation();
});

describe('DataStream', () => {
  test('HEADER_LENGTH is 20', () => {
    expect(DataStream.HEADER_LENGTH).toBe(20);
  });

  test('buildHeader creates a 20-byte buffer', () => {
    const buf = DataStream.buildHeader({ serverId: 0xE009, reqRepId: 0x7001 });
    expect(buf.length).toBe(20);
  });

  test('parseHeader round-trips correctly', () => {
    const opts = {
      totalLength: 100,
      headerID: 0x0300,
      serverId: 0xE009,
      csInstance: 42,
      correlation: 99,
      templateLen: 8,
      reqRepId: 0x7001,
    };
    const buf = DataStream.buildHeader(opts);
    const parsed = DataStream.parseHeader(buf);

    expect(parsed.totalLength).toBe(100);
    expect(parsed.headerID).toBe(0x0300);
    expect(parsed.serverId).toBe(0xE009);
    expect(parsed.csInstance).toBe(42);
    expect(parsed.correlation).toBe(99);
    expect(parsed.templateLen).toBe(8);
    expect(parsed.reqRepId).toBe(0x7001);
  });

  describe('round-trip for all 9 service IDs', () => {
    const services = [
      { name: 'FILE',         id: Service.FILE,         serverId: ServerID.FILE },
      { name: 'PRINT',        id: Service.PRINT,        serverId: ServerID.PRINT },
      { name: 'COMMAND',      id: Service.COMMAND,       serverId: ServerID.COMMAND },
      { name: 'DATAQUEUE',    id: Service.DATAQUEUE,     serverId: ServerID.DATAQUEUE },
      { name: 'DATABASE',     id: Service.DATABASE,      serverId: ServerID.DATABASE },
      { name: 'RECORDACCESS', id: Service.RECORDACCESS,  serverId: 0 },
      { name: 'CENTRAL',      id: Service.CENTRAL,       serverId: ServerID.CENTRAL },
      { name: 'SIGNON',       id: Service.SIGNON,        serverId: ServerID.SIGNON },
      { name: 'HOSTCNN',      id: Service.HOSTCNN,       serverId: ServerID.HOSTCNN },
    ];

    for (const svc of services) {
      test(`service ${svc.name} (id=${svc.id}, serverId=0x${svc.serverId.toString(16)})`, () => {
        const mapped = ServiceToServerID[svc.id];
        expect(mapped).toBe(svc.serverId);

        if (svc.serverId === 0) return; // RECORDACCESS uses DDM

        const buf = DataStream.buildPacket({
          serverId: svc.serverId,
          reqRepId: 0x7001,
          templateLen: 8,
        });

        expect(buf.length).toBe(20 + 8); // header + template
        const parsed = DataStream.parseHeader(buf);
        expect(parsed.serverId).toBe(svc.serverId);
        expect(parsed.reqRepId).toBe(0x7001);
        expect(parsed.templateLen).toBe(8);
        expect(parsed.totalLength).toBe(28);
      });
    }
  });

  test('buildPacket with payload', () => {
    const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const buf = DataStream.buildPacket({
      serverId: 0xE009,
      reqRepId: 0x7001,
      templateLen: 0,
      payload,
    });
    expect(buf.length).toBe(24);
    expect(buf[20]).toBe(0x01);
    expect(buf[21]).toBe(0x02);
    expect(buf[22]).toBe(0x03);
    expect(buf[23]).toBe(0x04);
  });

  test('buildPacket with template and payload', () => {
    const payload = Buffer.from([0xAA, 0xBB]);
    const buf = DataStream.buildPacket({
      serverId: 0xE000,
      reqRepId: 0x1234,
      templateLen: 4,
      payload,
    });
    // 20 header + 4 template + 2 payload = 26
    expect(buf.length).toBe(26);
    expect(buf.readUInt32BE(0)).toBe(26);
    expect(buf[24]).toBe(0xAA);
    expect(buf[25]).toBe(0xBB);
  });

  test('nextCorrelation auto-increments', () => {
    const c1 = DataStream.nextCorrelation();
    const c2 = DataStream.nextCorrelation();
    expect(c2).toBe(c1 + 1);
  });

  test('isValidHeader checks server ID byte', () => {
    const good = DataStream.buildHeader({ serverId: 0xE009 });
    expect(DataStream.isValidHeader(good)).toBe(true);

    const bad = DataStream.buildHeader({ serverId: 0x1234 });
    expect(DataStream.isValidHeader(bad)).toBe(false);
  });

  test('validateLength checks total length', () => {
    const buf = DataStream.buildPacket({
      serverId: 0xE009,
      reqRepId: 0x7001,
      templateLen: 0,
    });
    expect(DataStream.validateLength(buf)).toBe(true);

    // Corrupt the length
    buf.writeUInt32BE(999, 0);
    expect(DataStream.validateLength(buf)).toBe(false);
  });

  test('parseHeader throws on short buffer', () => {
    expect(() => DataStream.parseHeader(Buffer.alloc(10))).toThrow();
  });
});
