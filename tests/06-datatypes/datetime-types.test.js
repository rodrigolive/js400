/**
 * Tests for date, time, and timestamp types.
 */

import { describe, it, expect } from 'bun:test';
import {
  AS400Date,
  AS400Time,
  AS400Timestamp,
  AS400DateTimeConverter,
} from '../../src/datatypes/index.js';

describe('AS400Date', () => {
  it('encodes and decodes *ISO format', () => {
    const date = new AS400Date('*ISO');
    const buf = date.toBuffer('2024-03-15');
    expect(buf.length).toBe(10);
    const result = date.fromBuffer(buf);
    expect(result).toBe('2024-03-15');
  });

  it('encodes *USA format', () => {
    const date = new AS400Date('*USA');
    const result = date.fromBuffer(date.toBuffer('03/15/2024'));
    expect(result).toBe('03/15/2024');
  });

  it('encodes *EUR format', () => {
    const date = new AS400Date('*EUR');
    const result = date.fromBuffer(date.toBuffer('15.03.2024'));
    expect(result).toBe('15.03.2024');
  });

  it('encodes *MDY format', () => {
    const date = new AS400Date('*MDY');
    expect(date.byteLength()).toBe(8);
    const result = date.fromBuffer(date.toBuffer('03/15/24'));
    expect(result).toBe('03/15/24');
  });

  it('encodes *DMY format', () => {
    const date = new AS400Date('*DMY');
    const result = date.fromBuffer(date.toBuffer('15/03/24'));
    expect(result).toBe('15/03/24');
  });

  it('encodes *YMD format', () => {
    const date = new AS400Date('*YMD');
    const result = date.fromBuffer(date.toBuffer('24/03/15'));
    expect(result).toBe('24/03/15');
  });

  it('encodes from Date object', () => {
    const date = new AS400Date('*ISO');
    const jsDate = new Date(2024, 2, 15); // March 15, 2024
    const buf = date.toBuffer(jsDate);
    expect(date.fromBuffer(buf)).toBe('2024-03-15');
  });

  it('rejects unknown format', () => {
    expect(() => new AS400Date('*INVALID')).toThrow();
  });
});

describe('AS400Time', () => {
  it('encodes and decodes *HMS format', () => {
    const time = new AS400Time('*HMS');
    const result = time.fromBuffer(time.toBuffer('14:30:00'));
    expect(result).toBe('14:30:00');
  });

  it('encodes *ISO format', () => {
    const time = new AS400Time('*ISO');
    const result = time.fromBuffer(time.toBuffer('14.30.00'));
    expect(result).toBe('14.30.00');
  });

  it('has correct byte length', () => {
    const time = new AS400Time('*HMS');
    expect(time.byteLength()).toBe(8);
  });
});

describe('AS400Timestamp', () => {
  it('encodes and decodes standard format', () => {
    const ts = new AS400Timestamp();
    const input = '2024-03-15-14.30.00.000000';
    const result = ts.fromBuffer(ts.toBuffer(input));
    expect(result).toBe(input);
  });

  it('has 26-byte length', () => {
    const ts = new AS400Timestamp();
    expect(ts.byteLength()).toBe(26);
  });

  it('encodes from Date object', () => {
    const ts = new AS400Timestamp();
    const date = new Date(2024, 2, 15, 14, 30, 0, 500);
    const buf = ts.toBuffer(date);
    const result = ts.fromBuffer(buf);
    expect(result.startsWith('2024-03-15-14.30.00')).toBe(true);
  });
});

describe('AS400DateTimeConverter', () => {
  it('dateToIso', () => {
    const date = new Date(2024, 2, 15);
    expect(AS400DateTimeConverter.dateToIso(date)).toBe('2024-03-15');
  });

  it('timeToIso', () => {
    const date = new Date(2024, 2, 15, 14, 30, 45);
    expect(AS400DateTimeConverter.timeToIso(date)).toBe('14.30.45');
  });

  it('toTimestamp', () => {
    const date = new Date(2024, 2, 15, 14, 30, 0, 500);
    const ts = AS400DateTimeConverter.toTimestamp(date);
    expect(ts.startsWith('2024-03-15-14.30.00')).toBe(true);
  });

  it('parseIsoDate', () => {
    const date = AS400DateTimeConverter.parseIsoDate('2024-03-15');
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
  });

  it('parseTimestamp', () => {
    const date = AS400DateTimeConverter.parseTimestamp('2024-03-15-14.30.45.123000');
    expect(date.getFullYear()).toBe(2024);
    expect(date.getHours()).toBe(14);
    expect(date.getMinutes()).toBe(30);
    expect(date.getSeconds()).toBe(45);
  });
});
