/**
 * Unit tests for OutputQueue and SpooledFile.
 */

import { describe, it, expect } from 'bun:test';
import { OutputQueue } from '../../src/print/OutputQueue.js';
import { SpooledFile } from '../../src/print/SpooledFile.js';

function mockSystem() {
  return {
    user: 'TESTUSER',
    password: 'TESTPASS',
    host: '127.0.0.1',
    getPasswordLevel: () => 0,
    getServerCCSID: () => 37,
    connectService: () => { throw new Error('mock: not connected'); },
    runCommand: () => { throw new Error('mock: not connected'); },
  };
}

describe('OutputQueue', () => {
  it('requires an AS400 instance', () => {
    expect(() => new OutputQueue(null, '/QSYS.LIB/QUSRSYS.LIB/MYOUTQ.OUTQ')).toThrow('requires an AS400 instance');
  });

  it('requires a path', () => {
    expect(() => new OutputQueue(mockSystem(), '')).toThrow('requires a path');
  });

  it('parses path correctly', () => {
    const oq = new OutputQueue(mockSystem(), '/QSYS.LIB/QUSRSYS.LIB/MYOUTQ.OUTQ');
    expect(oq.library).toBe('QUSRSYS');
    expect(oq.name).toBe('MYOUTQ');
    expect(oq.path).toBe('/QSYS.LIB/QUSRSYS.LIB/MYOUTQ.OUTQ');
  });

  it('clear throws without connection', async () => {
    const oq = new OutputQueue(mockSystem(), '/QSYS.LIB/QUSRSYS.LIB/MYOUTQ.OUTQ');
    await expect(oq.clear()).rejects.toThrow();
  });

  it('hold throws without connection', async () => {
    const oq = new OutputQueue(mockSystem(), '/QSYS.LIB/QUSRSYS.LIB/MYOUTQ.OUTQ');
    await expect(oq.hold()).rejects.toThrow();
  });

  it('release throws without connection', async () => {
    const oq = new OutputQueue(mockSystem(), '/QSYS.LIB/QUSRSYS.LIB/MYOUTQ.OUTQ');
    await expect(oq.release()).rejects.toThrow();
  });
});

describe('SpooledFile', () => {
  it('requires an AS400 instance', () => {
    expect(() => new SpooledFile(null, 'QSYSPRT')).toThrow('requires an AS400 instance');
  });

  it('requires a name', () => {
    expect(() => new SpooledFile(mockSystem(), '')).toThrow('requires a name');
  });

  it('constructs with defaults', () => {
    const sf = new SpooledFile(mockSystem(), 'QSYSPRT');
    expect(sf.getName()).toBe('QSYSPRT');
    expect(sf.getJobName()).toBe('');
    expect(sf.getJobUser()).toBe('');
    expect(sf.getJobNumber()).toBe('');
    expect(sf.getNumber()).toBe(1);
    expect(sf.getTotalPages()).toBe(0);
    expect(sf.getOutputQueue()).toBe('');
    expect(sf.getOutputQueueLibrary()).toBe('');
  });

  it('constructs with options', () => {
    const sf = new SpooledFile(mockSystem(), 'MYREPORT', {
      jobName: 'MYJOB',
      jobUser: 'MYUSER',
      jobNumber: '123456',
      spooledFileNumber: 3,
      totalPages: 10,
      outputQueue: 'MYOUTQ',
      outputQueueLibrary: 'MYLIB',
    });
    expect(sf.getName()).toBe('MYREPORT');
    expect(sf.getJobName()).toBe('MYJOB');
    expect(sf.getJobUser()).toBe('MYUSER');
    expect(sf.getJobNumber()).toBe('123456');
    expect(sf.getNumber()).toBe(3);
    expect(sf.getTotalPages()).toBe(10);
    expect(sf.getOutputQueue()).toBe('MYOUTQ');
    expect(sf.getOutputQueueLibrary()).toBe('MYLIB');
  });

  it('toString formats correctly', () => {
    const sf = new SpooledFile(mockSystem(), 'MYREPORT', {
      jobName: 'MYJOB',
      jobUser: 'MYUSER',
      jobNumber: '123456',
      spooledFileNumber: 3,
    });
    expect(sf.toString()).toBe('MYREPORT (123456/MYUSER/MYJOB #3)');
  });

  it('hold throws without connection', async () => {
    const sf = new SpooledFile(mockSystem(), 'QSYSPRT', {
      jobName: 'MYJOB', jobUser: 'MYUSER', jobNumber: '123456',
    });
    await expect(sf.hold()).rejects.toThrow();
  });

  it('release throws without connection', async () => {
    const sf = new SpooledFile(mockSystem(), 'QSYSPRT', {
      jobName: 'MYJOB', jobUser: 'MYUSER', jobNumber: '123456',
    });
    await expect(sf.release()).rejects.toThrow();
  });

  it('delete throws without connection', async () => {
    const sf = new SpooledFile(mockSystem(), 'QSYSPRT', {
      jobName: 'MYJOB', jobUser: 'MYUSER', jobNumber: '123456',
    });
    await expect(sf.delete()).rejects.toThrow();
  });

  it('move throws without connection', async () => {
    const sf = new SpooledFile(mockSystem(), 'QSYSPRT', {
      jobName: 'MYJOB', jobUser: 'MYUSER', jobNumber: '123456',
    });
    await expect(sf.move('/QSYS.LIB/MYLIB.LIB/OTHER.OUTQ')).rejects.toThrow();
  });
});
