/**
 * Tests for RecordFormat: field registry, offset calculations, key fields.
 */

import { describe, it, expect } from 'bun:test';
import { RecordFormat } from '../../src/record/RecordFormat.js';
import { FieldDescription } from '../../src/record/FieldDescription.js';

function buildCustomerFormat() {
  const fmt = new RecordFormat('CUSTREC');
  fmt.addFieldDescription(FieldDescription.binary('CUSTNO', 4));       // 4 bytes @ 0
  fmt.addFieldDescription(FieldDescription.character('NAME', 30));     // 30 bytes @ 4
  fmt.addFieldDescription(FieldDescription.packedDecimal('BALANCE', 9, 2)); // 5 bytes @ 34
  fmt.addFieldDescription(FieldDescription.date('SINCE'));             // 10 bytes @ 39
  return fmt;
}

describe('RecordFormat', () => {
  it('sets and gets name', () => {
    const fmt = new RecordFormat('MYFMT');
    expect(fmt.name).toBe('MYFMT');
    fmt.name = 'OTHERFMT';
    expect(fmt.name).toBe('OTHERFMT');
  });

  it('tracks field count', () => {
    const fmt = buildCustomerFormat();
    expect(fmt.numberOfFields).toBe(4);
  });

  it('computes record length', () => {
    const fmt = buildCustomerFormat();
    // 4 + 30 + 5 + 10 = 49
    expect(fmt.recordLength).toBe(49);
  });

  it('computes field offsets', () => {
    const fmt = buildCustomerFormat();
    expect(fmt.getFieldOffset('CUSTNO')).toBe(0);
    expect(fmt.getFieldOffset('NAME')).toBe(4);
    expect(fmt.getFieldOffset('BALANCE')).toBe(34);
    expect(fmt.getFieldOffset('SINCE')).toBe(39);
  });

  it('looks up fields case-insensitively', () => {
    const fmt = buildCustomerFormat();
    expect(fmt.getFieldDescription('custno').name).toBe('CUSTNO');
    expect(fmt.getFieldDescription('Name').name).toBe('NAME');
  });

  it('throws on unknown field name', () => {
    const fmt = buildCustomerFormat();
    expect(() => fmt.getFieldDescription('NOPE')).toThrow(/not found/);
  });

  it('gets field by index', () => {
    const fmt = buildCustomerFormat();
    expect(fmt.getFieldDescriptionByIndex(0).name).toBe('CUSTNO');
    expect(fmt.getFieldDescriptionByIndex(3).name).toBe('SINCE');
  });

  it('throws on out-of-range index', () => {
    const fmt = buildCustomerFormat();
    expect(() => fmt.getFieldDescriptionByIndex(99)).toThrow(/out of range/);
    expect(() => fmt.getFieldDescriptionByIndex(-1)).toThrow(/out of range/);
  });

  it('gets field names in order', () => {
    const fmt = buildCustomerFormat();
    expect(fmt.getFieldNames()).toEqual(['CUSTNO', 'NAME', 'BALANCE', 'SINCE']);
  });

  it('gets field descriptions', () => {
    const fmt = buildCustomerFormat();
    const descs = fmt.getFieldDescriptions();
    expect(descs.length).toBe(4);
    expect(descs[0].name).toBe('CUSTNO');
  });

  it('finds field index', () => {
    const fmt = buildCustomerFormat();
    expect(fmt.getFieldIndex('NAME')).toBe(1);
    expect(fmt.getFieldIndex('MISSING')).toBe(-1);
  });

  it('checks field existence', () => {
    const fmt = buildCustomerFormat();
    expect(fmt.hasField('CUSTNO')).toBe(true);
    expect(fmt.hasField('NOPE')).toBe(false);
  });

  it('gets field offset by index', () => {
    const fmt = buildCustomerFormat();
    expect(fmt.getFieldOffsetByIndex(0)).toBe(0);
    expect(fmt.getFieldOffsetByIndex(2)).toBe(34);
  });
});

describe('RecordFormat key fields', () => {
  it('sets and gets key field names', () => {
    const fmt = buildCustomerFormat();
    fmt.setKeyFieldNames(['CUSTNO']);
    expect(fmt.getKeyFieldNames()).toEqual(['CUSTNO']);
  });

  it('computes key length', () => {
    const fmt = buildCustomerFormat();
    fmt.setKeyFieldNames(['CUSTNO']);
    expect(fmt.getKeyLength()).toBe(4);
  });

  it('handles multiple key fields', () => {
    const fmt = buildCustomerFormat();
    fmt.setKeyFieldNames(['CUSTNO', 'NAME']);
    expect(fmt.getKeyLength()).toBe(34); // 4 + 30
  });
});

describe('RecordFormat null field tracking', () => {
  it('detects null-capable fields', () => {
    const fmt = new RecordFormat('TEST');
    fmt.addFieldDescription(FieldDescription.binary('ID', 4));
    expect(fmt.hasNullFields).toBe(false);

    fmt.addFieldDescription(FieldDescription.character('OPT', 5, 37, { allowNull: true }));
    expect(fmt.hasNullFields).toBe(true);
  });
});
