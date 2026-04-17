/**
 * Unit tests for DataQueue, KeyedDataQueue, and related classes.
 */

import { describe, it, expect } from 'bun:test';
import {
  DataQueue,
  KeyedDataQueue,
  DataQueueEntry,
  KeyedDataQueueEntry,
  DataQueueAttributes,
} from '../../src/objects/data-queue.js';

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

describe('DataQueue', () => {
  it('requires an AS400 instance', () => {
    expect(() => new DataQueue(null, '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ')).toThrow('requires an AS400 instance');
  });

  it('requires a path', () => {
    expect(() => new DataQueue(mockSystem(), '')).toThrow('requires a path');
  });

  it('parses path correctly', () => {
    const dq = new DataQueue(mockSystem(), '/QSYS.LIB/TESTLIB.LIB/TESTQ.DTAQ');
    expect(dq.library).toBe('TESTLIB');
    expect(dq.name).toBe('TESTQ');
    expect(dq.path).toBe('/QSYS.LIB/TESTLIB.LIB/TESTQ.DTAQ');
  });

  it('write throws without connection', async () => {
    const dq = new DataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(dq.write(Buffer.from('test'))).rejects.toThrow('mock');
  });

  it('read throws without connection', async () => {
    const dq = new DataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(dq.read()).rejects.toThrow('mock');
  });

  it('peek throws without connection', async () => {
    const dq = new DataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(dq.peek()).rejects.toThrow('mock');
  });

  it('clear throws without connection', async () => {
    const dq = new DataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(dq.clear()).rejects.toThrow('mock');
  });

  it('create throws without connection', async () => {
    const dq = new DataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(dq.create()).rejects.toThrow('mock');
  });

  it('delete throws without connection', async () => {
    const dq = new DataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(dq.delete()).rejects.toThrow('mock');
  });

  it('getAttributes throws without connection', async () => {
    const dq = new DataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(dq.getAttributes()).rejects.toThrow('mock');
  });
});

describe('KeyedDataQueue', () => {
  it('requires an AS400 instance', () => {
    expect(() => new KeyedDataQueue(null, '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ')).toThrow('requires an AS400 instance');
  });

  it('requires a path', () => {
    expect(() => new KeyedDataQueue(mockSystem(), '')).toThrow('requires a path');
  });

  it('parses path correctly', () => {
    const kdq = new KeyedDataQueue(mockSystem(), '/QSYS.LIB/PRODLIB.LIB/KEYQ.DTAQ');
    expect(kdq.library).toBe('PRODLIB');
    expect(kdq.name).toBe('KEYQ');
  });

  it('create requires keyLength', async () => {
    const kdq = new KeyedDataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(kdq.create({})).rejects.toThrow('keyLength is required');
  });

  it('read validates search type', async () => {
    const kdq = new KeyedDataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(kdq.read('key', 0, 'INVALID')).rejects.toThrow('Invalid search type');
  });

  it('write throws without connection', async () => {
    const kdq = new KeyedDataQueue(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYQ.DTAQ');
    await expect(kdq.write('key', Buffer.from('data'))).rejects.toThrow('mock');
  });
});

describe('DataQueueEntry', () => {
  it('stores data and sender info', () => {
    const data = Buffer.from('test data');
    const sender = Buffer.alloc(36);
    const entry = new DataQueueEntry(data, sender);
    expect(entry.getData()).toBe(data);
    expect(entry.getSenderInformation()).toBe(sender);
  });
});

describe('KeyedDataQueueEntry', () => {
  it('stores data, key, and sender info', () => {
    const data = Buffer.from('test data');
    const key = Buffer.from('MYKEY');
    const sender = Buffer.alloc(36);
    const entry = new KeyedDataQueueEntry(data, key, sender);
    expect(entry.getData()).toBe(data);
    expect(entry.getKey()).toBe(key);
    expect(entry.getSenderInformation()).toBe(sender);
  });
});

describe('DataQueueAttributes', () => {
  it('stores attributes', () => {
    const attrs = new DataQueueAttributes({
      maxEntryLength: 2000,
      saveSenderInfo: true,
      queueType: 'FIFO',
      keyLength: 0,
      forceToAuxStorage: false,
      description: 'Test queue',
    });
    expect(attrs.maxEntryLength).toBe(2000);
    expect(attrs.saveSenderInfo).toBe(true);
    expect(attrs.queueType).toBe('FIFO');
    expect(attrs.keyLength).toBe(0);
    expect(attrs.forceToAuxStorage).toBe(false);
    expect(attrs.description).toBe('Test queue');
  });
});
