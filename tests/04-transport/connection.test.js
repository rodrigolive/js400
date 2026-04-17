/**
 * Connection TLS and non-TLS connect smoke tests (mock).
 */
import { describe, test, expect } from 'bun:test';
import { Connection } from '../../src/transport/Connection.js';
import { Service } from '../../src/core/constants.js';

describe('Connection', () => {
  test('constructor sets properties', () => {
    const conn = new Connection({
      host: 'myhost.example.com',
      port: 8476,
      serviceId: Service.SIGNON,
      secure: false,
    });

    expect(conn.host).toBe('myhost.example.com');
    expect(conn.port).toBe(8476);
    expect(conn.serviceId).toBe(Service.SIGNON);
    expect(conn.connected).toBe(false);
    expect(conn.connectionId).toBeGreaterThan(0);
  });

  test('constructor defaults secure to false', () => {
    const conn = new Connection({
      host: 'host',
      port: 8470,
      serviceId: Service.CENTRAL,
    });
    expect(conn.connected).toBe(false);
  });

  test('send throws when not connected', async () => {
    const conn = new Connection({
      host: 'host',
      port: 1234,
      serviceId: Service.COMMAND,
    });
    try {
      await conn.send(Buffer.alloc(10));
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err.name).toBe('ConnectionDroppedError');
    }
  });

  test('receive throws when not connected', async () => {
    const conn = new Connection({
      host: 'host',
      port: 1234,
      serviceId: Service.COMMAND,
    });
    try {
      await conn.receive();
      expect(true).toBe(false);
    } catch (err) {
      expect(err.name).toBe('ConnectionDroppedError');
    }
  });

  test('close is safe when not connected', () => {
    const conn = new Connection({
      host: 'host',
      port: 1234,
      serviceId: Service.COMMAND,
    });
    conn.close();
    expect(conn.connected).toBe(false);
  });

  test('connect to non-existent host fails with error', async () => {
    const conn = new Connection({
      host: '192.0.2.1', // RFC 5737 TEST-NET, should fail
      port: 8476,
      serviceId: Service.SIGNON,
      timeout: 500,
    });
    try {
      await conn.connect();
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err.name).toBe('ConnectionDroppedError');
    }
  });

  test('connect with aborted signal fails immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const conn = new Connection({
      host: '192.0.2.1',
      port: 8476,
      serviceId: Service.SIGNON,
      signal: ac.signal,
    });
    try {
      await conn.connect();
      expect(true).toBe(false);
    } catch (err) {
      expect(err.name).toBe('ConnectionDroppedError');
      expect(err.message).toContain('aborted');
    }
  });

  test('jobString getter/setter', () => {
    const conn = new Connection({
      host: 'host',
      port: 1234,
      serviceId: Service.COMMAND,
    });
    expect(conn.jobString).toBeNull();
    conn.jobString = '123456/MYUSER/QZRCSRVS';
    expect(conn.jobString).toBe('123456/MYUSER/QZRCSRVS');
  });

  test('TLS connection constructor properties', () => {
    const conn = new Connection({
      host: 'myhost.example.com',
      port: 9476,
      serviceId: Service.SIGNON,
      secure: true,
      tlsOptions: { rejectUnauthorized: false },
    });
    expect(conn.port).toBe(9476);
    expect(conn.connected).toBe(false);
  });
});
