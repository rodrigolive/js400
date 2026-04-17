/**
 * Tests for ProgramCall, CommandCall, and ServiceProgramCall construction.
 *
 * These are unit tests (no live IBM i connection).
 */

import { describe, it, expect } from 'bun:test';
import { ProgramCall } from '../../src/command/ProgramCall.js';
import { CommandCall } from '../../src/command/CommandCall.js';
import { ServiceProgramCall } from '../../src/command/ServiceProgramCall.js';
import { ProgramParameter } from '../../src/command/ProgramParameter.js';

// Minimal mock for AS400
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

describe('ProgramCall', () => {

  it('requires an AS400 instance', () => {
    expect(() => new ProgramCall(null)).toThrow('requires an AS400 instance');
  });

  it('constructs with system', () => {
    const pc = new ProgramCall(mockSystem());
    expect(pc.getProgram()).toBe('');
    expect(pc.getParameterList()).toEqual([]);
    expect(pc.getMessageList()).toEqual([]);
    expect(pc.isThreadsafe()).toBe(false);
  });

  it('setProgram stores path and parameters', () => {
    const pc = new ProgramCall(mockSystem());
    const params = [new ProgramParameter(Buffer.alloc(4))];
    pc.setProgram('/QSYS.LIB/MYLIB.LIB/MYPGM.PGM', params);

    expect(pc.getProgram()).toBe('/QSYS.LIB/MYLIB.LIB/MYPGM.PGM');
    expect(pc.getParameterList()).toHaveLength(1);
  });

  it('setParameterList replaces parameters', () => {
    const pc = new ProgramCall(mockSystem());
    pc.setParameterList([new ProgramParameter(10), new ProgramParameter(20)]);
    expect(pc.getParameterList()).toHaveLength(2);
  });

  it('setThreadsafe works', () => {
    const pc = new ProgramCall(mockSystem());
    pc.setThreadsafe(true);
    expect(pc.isThreadsafe()).toBe(true);
  });

  it('run throws without program set', async () => {
    const pc = new ProgramCall(mockSystem());
    await expect(pc.run()).rejects.toThrow('No program set');
  });
});

describe('CommandCall', () => {

  it('requires an AS400 instance', () => {
    expect(() => new CommandCall(null)).toThrow('requires an AS400 instance');
  });

  it('constructs with system and optional command', () => {
    const cmd = new CommandCall(mockSystem(), 'DSPLIBL');
    expect(cmd.getCommand()).toBe('DSPLIBL');
    expect(cmd.getMessageList()).toEqual([]);
  });

  it('setCommand stores command', () => {
    const cmd = new CommandCall(mockSystem());
    cmd.setCommand('CRTLIB LIB(TEST)');
    expect(cmd.getCommand()).toBe('CRTLIB LIB(TEST)');
  });

  it('run throws without command', async () => {
    const cmd = new CommandCall(mockSystem());
    await expect(cmd.run()).rejects.toThrow('No command specified');
  });
});

describe('ServiceProgramCall', () => {

  it('requires an AS400 instance', () => {
    expect(() => new ServiceProgramCall(null)).toThrow('requires an AS400 instance');
  });

  it('constructs with system', () => {
    const spc = new ServiceProgramCall(mockSystem());
    expect(spc.getProgram()).toBe('');
    expect(spc.getProcedureName()).toBe('');
    expect(spc.getReturnValueFormat()).toBe(ServiceProgramCall.NO_RETURN_VALUE);
    expect(spc.getIntegerReturnValue()).toBe(0);
  });

  it('set/get program and procedure', () => {
    const spc = new ServiceProgramCall(mockSystem());
    spc.setProgram('/QSYS.LIB/MYLIB.LIB/MYSRVPGM.SRVPGM');
    spc.setProcedureName('myProc');
    spc.setReturnValueFormat(ServiceProgramCall.RETURN_INTEGER);

    expect(spc.getProgram()).toBe('/QSYS.LIB/MYLIB.LIB/MYSRVPGM.SRVPGM');
    expect(spc.getProcedureName()).toBe('myProc');
    expect(spc.getReturnValueFormat()).toBe(ServiceProgramCall.RETURN_INTEGER);
  });

  it('constants are correct', () => {
    expect(ServiceProgramCall.NO_RETURN_VALUE).toBe(0);
    expect(ServiceProgramCall.RETURN_INTEGER).toBe(1);
  });

  it('run throws without program', async () => {
    const spc = new ServiceProgramCall(mockSystem());
    await expect(spc.run()).rejects.toThrow('No service program set');
  });

  it('run throws without procedure name', async () => {
    const spc = new ServiceProgramCall(mockSystem());
    spc.setProgram('/QSYS.LIB/MYLIB.LIB/MYPGM.SRVPGM');
    await expect(spc.run()).rejects.toThrow('No procedure name set');
  });

  it('EPCCSID default is 0', () => {
    const spc = new ServiceProgramCall(mockSystem());
    expect(spc.getEPCCSID()).toBe(0);
    spc.setEPCCSID(37);
    expect(spc.getEPCCSID()).toBe(37);
  });
});
