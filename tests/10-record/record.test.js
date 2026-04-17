/**
 * Tests for Record: get/set fields, buffer encode/decode, null handling, toObject.
 */

import { describe, it, expect } from 'bun:test';
import { RecordFormat } from '../../src/record/RecordFormat.js';
import { Record } from '../../src/record/Record.js';
import { FieldDescription } from '../../src/record/FieldDescription.js';

function buildFormat() {
  const fmt = new RecordFormat('EMPREC');
  fmt.addFieldDescription(FieldDescription.binary('EMPNO', 4));
  fmt.addFieldDescription(FieldDescription.character('LNAME', 15));
  fmt.addFieldDescription(FieldDescription.packedDecimal('SALARY', 9, 2));
  return fmt;
}

function buildNullableFormat() {
  const fmt = new RecordFormat('NTEST');
  fmt.addFieldDescription(FieldDescription.binary('ID', 4));
  fmt.addFieldDescription(FieldDescription.character('NOTES', 20, 37, { allowNull: true }));
  return fmt;
}

describe('Record construction', () => {
  it('allocates buffer for format recordLength', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    expect(rec.getContents().length).toBe(fmt.recordLength);
  });

  it('accepts pre-filled buffer', () => {
    const fmt = buildFormat();
    const buf = Buffer.alloc(fmt.recordLength, 0xFF);
    const rec = new Record(fmt, buf);
    expect(rec.getContents()[0]).toBe(0xFF);
  });

  it('exposes format', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    expect(rec.format).toBe(fmt);
  });

  it('tracks record number', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.recordNumber = 42;
    expect(rec.recordNumber).toBe(42);
  });
});

describe('Record field get/set', () => {
  it('sets and gets a binary field', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.setField('EMPNO', 12345);
    expect(rec.getField('EMPNO')).toBe(12345);
  });

  it('sets and gets a character field', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.setField('LNAME', 'Smith');
    const val = rec.getField('LNAME');
    expect(val.trim()).toBe('Smith');
  });

  it('sets and gets a packed decimal field', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.setField('SALARY', '55000.00');
    expect(rec.getField('SALARY')).toBe('55000.00');
  });

  it('writes correct bytes for binary field at offset 0', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.setField('EMPNO', 256);
    const buf = rec.getContents();
    expect(buf.readInt32BE(0)).toBe(256);
  });

  it('throws on unknown field', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    expect(() => rec.getField('NOPE')).toThrow(/not found/);
    expect(() => rec.setField('NOPE', 1)).toThrow(/not found/);
  });
});

describe('Record null handling', () => {
  it('sets a field to null', () => {
    const fmt = buildNullableFormat();
    const rec = new Record(fmt);
    rec.setField('NOTES', null);
    expect(rec.isFieldNull('NOTES')).toBe(true);
    expect(rec.getField('NOTES')).toBeNull();
  });

  it('clears null when value is set', () => {
    const fmt = buildNullableFormat();
    const rec = new Record(fmt);
    rec.setField('NOTES', null);
    rec.setField('NOTES', 'Some text');
    expect(rec.isFieldNull('NOTES')).toBe(false);
  });

  it('setFieldNull marks field null', () => {
    const fmt = buildNullableFormat();
    const rec = new Record(fmt);
    rec.setFieldNull('NOTES');
    expect(rec.isFieldNull('NOTES')).toBe(true);
  });
});

describe('Record null field map', () => {
  it('generates F0 for non-null, F1 for null', () => {
    const fmt = buildNullableFormat();
    const rec = new Record(fmt);
    rec.setFieldNull('NOTES');
    const map = rec.getNullFieldMap();
    expect(map.length).toBe(2); // 2 fields
    expect(map[0]).toBe(0xF0); // ID not null
    expect(map[1]).toBe(0xF1); // NOTES null
  });

  it('applies null field map from DDM', () => {
    const fmt = buildNullableFormat();
    const rec = new Record(fmt);
    const map = Buffer.from([0xF0, 0xF1]);
    rec.applyNullFieldMap(map);
    expect(rec.isFieldNull('ID')).toBe(false);
    expect(rec.isFieldNull('NOTES')).toBe(true);
  });
});

describe('Record toObject / fromObject', () => {
  it('converts all fields to a plain object', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.setField('EMPNO', 100);
    rec.setField('LNAME', 'Doe');
    rec.setField('SALARY', '75000.00');

    const obj = rec.toObject();
    expect(obj.EMPNO).toBe(100);
    expect(obj.LNAME).toBe('Doe'); // trimmed
    expect(obj.SALARY).toBe('75000.00');
  });

  it('trims strings by default', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.setField('LNAME', 'Hi');
    expect(rec.toObject().LNAME).toBe('Hi');
    expect(rec.toObject({ trim: false }).LNAME.length).toBe(15);
  });

  it('sets fields from a plain object', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.fromObject({ EMPNO: 200, LNAME: 'Jane', SALARY: '50000.00' });
    expect(rec.getField('EMPNO')).toBe(200);
    expect(rec.getField('LNAME').trim()).toBe('Jane');
  });

  it('ignores unknown keys in fromObject', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.fromObject({ EMPNO: 1, UNKNOWN: 'ignored' });
    expect(rec.getField('EMPNO')).toBe(1);
  });
});

describe('Record.fromBuffer', () => {
  it('creates a record from raw buffer with record number', () => {
    const fmt = buildFormat();
    const buf = Buffer.alloc(fmt.recordLength);
    buf.writeInt32BE(999, 0);
    const rec = Record.fromBuffer(fmt, buf, 7);
    expect(rec.getField('EMPNO')).toBe(999);
    expect(rec.recordNumber).toBe(7);
  });
});

describe('Record.toBuffer', () => {
  it('returns a copy of the record buffer', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    rec.setField('EMPNO', 42);
    const copy = rec.toBuffer();
    expect(copy.readInt32BE(0)).toBe(42);
    // Verify it's a copy
    copy.writeInt32BE(0, 0);
    expect(rec.getField('EMPNO')).toBe(42);
  });
});

describe('Record.getNumberOfFields', () => {
  it('returns the number of fields', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    expect(rec.getNumberOfFields()).toBe(3);
  });
});

describe('Record.setContents', () => {
  it('replaces the underlying buffer', () => {
    const fmt = buildFormat();
    const rec = new Record(fmt);
    const newBuf = Buffer.alloc(fmt.recordLength);
    newBuf.writeInt32BE(777, 0);
    rec.setContents(newBuf);
    expect(rec.getField('EMPNO')).toBe(777);
  });
});
