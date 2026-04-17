/**
 * Unit tests for MessageQueue.
 */

import { describe, it, expect } from 'bun:test';
import { MessageQueue } from '../../src/objects/MessageQueue.js';

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

describe('MessageQueue', () => {
  it('requires an AS400 instance', () => {
    expect(() => new MessageQueue(null, '/QSYS.LIB/QUSRSYS.LIB/TEST.MSGQ')).toThrow('requires an AS400 instance');
  });

  it('requires a path', () => {
    expect(() => new MessageQueue(mockSystem(), '')).toThrow('requires a path');
  });

  it('parses path correctly', () => {
    const mq = new MessageQueue(mockSystem(), '/QSYS.LIB/QUSRSYS.LIB/MYUSER.MSGQ');
    expect(mq.library).toBe('QUSRSYS');
    expect(mq.name).toBe('MYUSER');
    expect(mq.path).toBe('/QSYS.LIB/QUSRSYS.LIB/MYUSER.MSGQ');
  });

  it('receive throws without connection', async () => {
    const mq = new MessageQueue(mockSystem(), '/QSYS.LIB/QUSRSYS.LIB/TEST.MSGQ');
    await expect(mq.receive()).rejects.toThrow();
  });

  it('sendInformational throws without connection', async () => {
    const mq = new MessageQueue(mockSystem(), '/QSYS.LIB/QUSRSYS.LIB/TEST.MSGQ');
    await expect(mq.sendInformational('Hello')).rejects.toThrow();
  });
});
