/**
 * Unit tests for UserSpace.
 */

import { describe, it, expect } from 'bun:test';
import { UserSpace } from '../../src/objects/UserSpace.js';

function mockSystem() {
  return {
    user: 'TESTUSER',
    password: 'TESTPASS',
    host: '127.0.0.1',
    getPasswordLevel: () => 0,
    getServerCCSID: () => 37,
    connectService: () => { throw new Error('mock: not connected'); },
  };
}

describe('UserSpace', () => {
  it('requires an AS400 instance', () => {
    expect(() => new UserSpace(null, '/QSYS.LIB/QTEMP.LIB/MYSPACE.USRSPC')).toThrow('requires an AS400 instance');
  });

  it('requires a path', () => {
    expect(() => new UserSpace(mockSystem(), '')).toThrow('requires a path');
  });

  it('parses path correctly', () => {
    const us = new UserSpace(mockSystem(), '/QSYS.LIB/QTEMP.LIB/MYSPACE.USRSPC');
    expect(us.library).toBe('QTEMP');
    expect(us.name).toBe('MYSPACE');
    expect(us.path).toBe('/QSYS.LIB/QTEMP.LIB/MYSPACE.USRSPC');
  });

  it('create throws without connection', async () => {
    const us = new UserSpace(mockSystem(), '/QSYS.LIB/QTEMP.LIB/MYSPACE.USRSPC');
    await expect(us.create()).rejects.toThrow();
  });

  it('read throws without connection', async () => {
    const us = new UserSpace(mockSystem(), '/QSYS.LIB/QTEMP.LIB/MYSPACE.USRSPC');
    await expect(us.read(0, 100)).rejects.toThrow();
  });

  it('write throws without connection', async () => {
    const us = new UserSpace(mockSystem(), '/QSYS.LIB/QTEMP.LIB/MYSPACE.USRSPC');
    await expect(us.write(0, Buffer.from('test'))).rejects.toThrow();
  });

  it('delete throws without connection', async () => {
    const us = new UserSpace(mockSystem(), '/QSYS.LIB/QTEMP.LIB/MYSPACE.USRSPC');
    await expect(us.delete()).rejects.toThrow();
  });
});
