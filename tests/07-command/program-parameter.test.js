/**
 * Tests for ProgramParameter class.
 */

import { describe, it, expect } from 'bun:test';
import { ProgramParameter } from '../../src/command/ProgramParameter.js';

describe('ProgramParameter', () => {

  it('creates empty parameter', () => {
    const p = new ProgramParameter();
    expect(p.getInputData()).toBeNull();
    expect(p.getOutputData()).toBeNull();
    expect(p.getOutputDataLength()).toBe(0);
    expect(p.getUsage()).toBe(ProgramParameter.INPUT);
  });

  it('creates output-only parameter from number', () => {
    const p = new ProgramParameter(100);
    expect(p.getInputData()).toBeNull();
    expect(p.getOutputDataLength()).toBe(100);
    expect(p.getUsage()).toBe(ProgramParameter.OUTPUT);
    expect(p.getInputLength()).toBe(0);
    expect(p.getMaxOutputSize()).toBe(100);
  });

  it('creates input-only parameter from Buffer', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const p = new ProgramParameter(buf);
    expect(p.getInputData()).toEqual(buf);
    expect(p.getUsage()).toBe(ProgramParameter.INPUT);
    expect(p.getInputLength()).toBe(4);
    expect(p.getMaxOutputSize()).toBe(0);
  });

  it('creates input/output parameter from Buffer + length', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const p = new ProgramParameter(buf, 50);
    expect(p.getInputData()).toEqual(buf);
    expect(p.getOutputDataLength()).toBe(50);
    expect(p.getUsage()).toBe(ProgramParameter.INOUT);
    expect(p.getInputLength()).toBe(3);
    expect(p.getMaxOutputSize()).toBe(50);
  });

  it('creates from options object', () => {
    const buf = Buffer.from([0xAA, 0xBB]);
    const p = new ProgramParameter({
      inputData: buf,
      outputLength: 200,
      passBy: ProgramParameter.PASS_BY_VALUE,
    });
    expect(p.getInputData()).toEqual(buf);
    expect(p.getOutputDataLength()).toBe(200);
    expect(p.getPassBy()).toBe(ProgramParameter.PASS_BY_VALUE);
    expect(p.getUsage()).toBe(ProgramParameter.INOUT);
  });

  it('respects explicit usage in options', () => {
    const p = new ProgramParameter({
      inputData: Buffer.alloc(4),
      usage: ProgramParameter.INPUT,
    });
    expect(p.getUsage()).toBe(ProgramParameter.INPUT);
  });

  it('handles null parameter', () => {
    const p = new ProgramParameter({ isNull: true });
    expect(p.isNullParameter()).toBe(true);
    expect(p.getInputLength()).toBe(0);
  });

  it('setOutputData stores data', () => {
    const p = new ProgramParameter(100);
    expect(p.getOutputData()).toBeNull();

    const outBuf = Buffer.from('hello');
    p.setOutputData(outBuf);
    expect(p.getOutputData()).toEqual(outBuf);
  });

  it('static constants are correct', () => {
    expect(ProgramParameter.INPUT).toBe(1);
    expect(ProgramParameter.OUTPUT).toBe(2);
    expect(ProgramParameter.INOUT).toBe(3);
    expect(ProgramParameter.PASS_BY_REFERENCE).toBe(2);
    expect(ProgramParameter.PASS_BY_VALUE).toBe(1);
  });
});
