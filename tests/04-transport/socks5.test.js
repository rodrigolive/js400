/**
 * SOCKS5 handshake tests against mock / buffer verification.
 */
import { describe, test, expect } from 'bun:test';
import { Socks5 } from '../../src/transport/socket/Socks5.js';

describe('Socks5', () => {
  test('buildGreeting without auth', () => {
    const buf = Socks5.buildGreeting(false);
    expect(buf.length).toBe(3);
    expect(buf[0]).toBe(0x05); // VER
    expect(buf[1]).toBe(0x01); // 1 method
    expect(buf[2]).toBe(0x00); // NO AUTH
  });

  test('buildGreeting with auth', () => {
    const buf = Socks5.buildGreeting(true);
    expect(buf.length).toBe(4);
    expect(buf[0]).toBe(0x05);
    expect(buf[1]).toBe(0x02); // 2 methods
    expect(buf[2]).toBe(0x00); // NO AUTH
    expect(buf[3]).toBe(0x02); // USERNAME/PASSWORD
  });

  test('buildConnectRequest for domain', () => {
    const buf = Socks5.buildConnectRequest('myhost.example.com', 8476);
    expect(buf[0]).toBe(0x05); // VER
    expect(buf[1]).toBe(0x01); // CMD = CONNECT
    expect(buf[2]).toBe(0x00); // RSV
    expect(buf[3]).toBe(0x03); // ATYP = DOMAIN
    expect(buf[4]).toBe(18);   // domain length
    const domain = buf.subarray(5, 5 + 18).toString('ascii');
    expect(domain).toBe('myhost.example.com');
    // Port at end
    const port = buf.readUInt16BE(5 + 18);
    expect(port).toBe(8476);
  });

  test('buildConnectRequest total length', () => {
    const buf = Socks5.buildConnectRequest('host', 80);
    // 4 + 1 + 4 + 2 = 11
    expect(buf.length).toBe(11);
  });

  test('parseGreetingReply: no auth', () => {
    const reply = Buffer.from([0x05, 0x00]);
    const result = Socks5.parseGreetingReply(reply);
    expect(result.version).toBe(5);
    expect(result.method).toBe(0x00);
  });

  test('parseGreetingReply: username/password', () => {
    const reply = Buffer.from([0x05, 0x02]);
    const result = Socks5.parseGreetingReply(reply);
    expect(result.method).toBe(0x02);
  });

  test('parseGreetingReply: no acceptable method', () => {
    const reply = Buffer.from([0x05, 0xFF]);
    const result = Socks5.parseGreetingReply(reply);
    expect(result.method).toBe(0xFF);
  });

  test('parseGreetingReply throws on short buffer', () => {
    expect(() => Socks5.parseGreetingReply(Buffer.alloc(1))).toThrow();
    expect(() => Socks5.parseGreetingReply(null)).toThrow();
  });

  test('parseConnectReply: success with IPv4', () => {
    const reply = Buffer.from([
      0x05, 0x00, 0x00, 0x01, // VER, REP=success, RSV, ATYP=IPv4
      0x0A, 0x00, 0x00, 0x01, // bound addr
      0x21, 0x1C,             // bound port
    ]);
    const result = Socks5.parseConnectReply(reply);
    expect(result.version).toBe(5);
    expect(result.reply).toBe(0x00);
    expect(result.addressType).toBe(0x01);
  });

  test('parseConnectReply: failure', () => {
    const reply = Buffer.from([0x05, 0x01, 0x00, 0x01]);
    const result = Socks5.parseConnectReply(reply);
    expect(result.reply).toBe(0x01); // general failure
  });

  test('parseConnectReply throws on short buffer', () => {
    expect(() => Socks5.parseConnectReply(Buffer.alloc(2))).toThrow();
  });

  test('connect with non-existent proxy fails', async () => {
    try {
      await Socks5.connect({
        proxyHost: '192.0.2.1',
        proxyPort: 1080,
        targetHost: 'target',
        targetPort: 8476,
        timeout: 500,
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.name).toBe('ConnectionDroppedError');
    }
  });
});
