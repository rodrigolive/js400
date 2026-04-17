/**
 * Unit tests for SystemValue, DataArea, SystemStatus.
 */

import { describe, it, expect } from 'bun:test';
import { SystemValue } from '../../src/objects/system/SystemValue.js';
import { DataArea } from '../../src/objects/system/DataArea.js';
import { SystemStatus } from '../../src/objects/system/SystemStatus.js';

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

describe('SystemValue', () => {
  it('requires an AS400 instance', () => {
    expect(() => new SystemValue(null, 'QDATE')).toThrow('requires an AS400 instance');
  });

  it('requires a name', () => {
    expect(() => new SystemValue(mockSystem(), '')).toThrow('requires a name');
  });

  it('stores name uppercased', () => {
    const sv = new SystemValue(mockSystem(), 'qdate');
    expect(sv.getName()).toBe('QDATE');
  });

  it('load throws without connection', async () => {
    const sv = new SystemValue(mockSystem(), 'QDATE');
    await expect(sv.load()).rejects.toThrow();
  });

  it('getValue calls load', async () => {
    const sv = new SystemValue(mockSystem(), 'QDATE');
    await expect(sv.getValue()).rejects.toThrow();
  });
});

describe('DataArea', () => {
  it('requires an AS400 instance', () => {
    expect(() => new DataArea(null, '/QSYS.LIB/MYLIB.LIB/MYDA.DTAARA')).toThrow('requires an AS400 instance');
  });

  it('requires a path', () => {
    expect(() => new DataArea(mockSystem(), '')).toThrow('requires a path');
  });

  it('parses path correctly', () => {
    const da = new DataArea(mockSystem(), '/QSYS.LIB/TESTLIB.LIB/TESTDA.DTAARA');
    expect(da.library).toBe('TESTLIB');
    expect(da.name).toBe('TESTDA');
    expect(da.path).toBe('/QSYS.LIB/TESTLIB.LIB/TESTDA.DTAARA');
  });

  it('readCharacter throws without connection', async () => {
    const da = new DataArea(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYDA.DTAARA');
    await expect(da.readCharacter()).rejects.toThrow();
  });

  it('readDecimal throws without connection', async () => {
    const da = new DataArea(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYDA.DTAARA');
    await expect(da.readDecimal()).rejects.toThrow();
  });

  it('readLogical throws without connection', async () => {
    const da = new DataArea(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYDA.DTAARA');
    await expect(da.readLogical()).rejects.toThrow();
  });

  it('writeCharacter throws without connection', async () => {
    const da = new DataArea(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYDA.DTAARA');
    await expect(da.writeCharacter('test')).rejects.toThrow();
  });

  it('create throws without connection', async () => {
    const da = new DataArea(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYDA.DTAARA');
    await expect(da.create()).rejects.toThrow();
  });

  it('delete throws without connection', async () => {
    const da = new DataArea(mockSystem(), '/QSYS.LIB/MYLIB.LIB/MYDA.DTAARA');
    await expect(da.delete()).rejects.toThrow();
  });
});

describe('SystemStatus', () => {
  it('requires an AS400 instance', () => {
    expect(() => new SystemStatus(null)).toThrow('requires an AS400 instance');
  });

  it('constructs and has getters with defaults', () => {
    const ss = new SystemStatus(mockSystem());
    expect(ss.getSystemName()).toBe('');
    expect(ss.getCurrentDateTime()).toBe('');
    expect(ss.getUsersCurrentSignedOn()).toBe(0);
    expect(ss.getBatchJobsRunning()).toBe(0);
    expect(ss.getPercentSystemASPUsed()).toBe(0);
    expect(ss.getTotalAuxiliaryStorage()).toBe(0);
    expect(ss.getSystemASP()).toBe(0);
    expect(ss.getPercentProcessingUnitUsed()).toBe(0);
    expect(ss.getJobsInSystem()).toBe(0);
    expect(ss.getNumberOfProcessors()).toBe(0);
    expect(ss.getActiveJobsInSystem()).toBe(0);
  });

  it('load throws without connection', async () => {
    const ss = new SystemStatus(mockSystem());
    await expect(ss.load()).rejects.toThrow();
  });

  it('getInfo returns a copy', () => {
    const ss = new SystemStatus(mockSystem());
    const info = ss.getInfo();
    expect(typeof info).toBe('object');
    info.test = 'mutated';
    expect(ss.getInfo().test).toBeUndefined();
  });
});
