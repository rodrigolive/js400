/**
 * Tests for record module exports and main index exports.
 */

import { describe, it, expect } from 'bun:test';
import * as record from '../../src/record/index.js';
import * as main from '../../src/index.js';

describe('record module exports', () => {
  it('exports RecordFormat', () => {
    expect(record.RecordFormat).toBeDefined();
    expect(typeof record.RecordFormat).toBe('function');
  });

  it('exports Record', () => {
    expect(record.Record).toBeDefined();
    expect(typeof record.Record).toBe('function');
  });

  it('exports FieldDescription', () => {
    expect(record.FieldDescription).toBeDefined();
    expect(typeof record.FieldDescription).toBe('function');
  });

  it('exports FIELD_TYPE', () => {
    expect(record.FIELD_TYPE).toBeDefined();
    expect(record.FIELD_TYPE.BINARY).toBe('binary');
  });

  it('exports SequentialFile', () => {
    expect(record.SequentialFile).toBeDefined();
    expect(typeof record.SequentialFile).toBe('function');
  });

  it('exports DIRECTION', () => {
    expect(record.DIRECTION).toBeDefined();
    expect(record.DIRECTION.NEXT).toBe(1);
  });

  it('exports KeyedFile', () => {
    expect(record.KeyedFile).toBeDefined();
    expect(typeof record.KeyedFile).toBe('function');
  });

  it('exports KEY_SEARCH', () => {
    expect(record.KEY_SEARCH).toBeDefined();
    expect(record.KEY_SEARCH.EQUAL).toBe(0);
  });

  it('exports RecordFormatDocument', () => {
    expect(record.RecordFormatDocument).toBeDefined();
    expect(typeof record.RecordFormatDocument).toBe('function');
  });

  it('exports FileRecordDescription', () => {
    expect(record.FileRecordDescription).toBeDefined();
    expect(typeof record.FileRecordDescription).toBe('function');
  });

  it('exports DDMReq', () => {
    expect(record.DDMReq).toBeDefined();
    expect(typeof record.DDMReq).toBe('function');
  });

  it('exports DDMRep', () => {
    expect(record.DDMRep).toBeDefined();
    expect(typeof record.DDMRep).toBe('function');
  });

  it('exports DDMPool', () => {
    expect(record.DDMPool).toBeDefined();
    expect(typeof record.DDMPool).toBe('function');
  });

  it('exports CP constants', () => {
    expect(record.CP).toBeDefined();
    expect(record.CP.S38OPEN).toBe(0xD011);
  });
});

describe('main index exports record module', () => {
  it('exports RecordFormat from main index', () => {
    expect(main.RecordFormat).toBeDefined();
  });

  it('exports Record from main index', () => {
    expect(main.Record).toBeDefined();
  });

  it('exports FieldDescription from main index', () => {
    expect(main.FieldDescription).toBeDefined();
  });

  it('exports SequentialFile from main index', () => {
    expect(main.SequentialFile).toBeDefined();
  });

  it('exports KeyedFile from main index', () => {
    expect(main.KeyedFile).toBeDefined();
  });

  it('exports RecordFormatDocument from main index', () => {
    expect(main.RecordFormatDocument).toBeDefined();
  });

  it('exports FileRecordDescription from main index', () => {
    expect(main.FileRecordDescription).toBeDefined();
  });

  it('exports FIELD_TYPE from main index', () => {
    expect(main.FIELD_TYPE).toBeDefined();
  });

  it('exports DIRECTION from main index', () => {
    expect(main.DIRECTION).toBeDefined();
  });

  it('exports KEY_SEARCH from main index', () => {
    expect(main.KEY_SEARCH).toBeDefined();
  });
});
