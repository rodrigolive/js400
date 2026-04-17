/**
 * Tests for SqlArray and RowId wrappers.
 */
import { describe, test, expect } from 'bun:test';
import { SqlArray } from '../../src/db/api/SqlArray.js';
import { RowId } from '../../src/db/api/RowId.js';

describe('SqlArray', () => {
  test('wraps elements', () => {
    const arr = new SqlArray({ baseType: 496, baseTypeName: 'INTEGER', elements: [1, 2, 3] });
    expect(arr.length).toBe(3);
    expect(arr.baseType).toBe(496);
    expect(arr.baseTypeName).toBe('INTEGER');
  });

  test('getArray() returns copy of elements', () => {
    const arr = new SqlArray({ elements: [10, 20] });
    const copy = arr.getArray();
    expect(copy).toEqual([10, 20]);
  });

  test('iterable via Symbol.iterator', () => {
    const arr = new SqlArray({ elements: ['a', 'b', 'c'] });
    const collected = [...arr];
    expect(collected).toEqual(['a', 'b', 'c']);
  });

  test('toJSON() returns elements', () => {
    const arr = new SqlArray({ elements: [1, 2] });
    expect(JSON.stringify(arr)).toBe('[1,2]');
  });

  test('empty SqlArray', () => {
    const arr = new SqlArray({});
    expect(arr.length).toBe(0);
    expect(arr.getArray()).toEqual([]);
  });
});

describe('RowId', () => {
  test('wraps bytes', () => {
    const rid = new RowId(Buffer.from([0x01, 0x02, 0xFF]));
    expect(rid.length).toBe(3);
    expect(rid.bytes).toBeDefined();
  });

  test('toString() returns hex', () => {
    const rid = new RowId(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
    expect(rid.toString()).toBe('DEADBEEF');
  });

  test('equals() compares RowIds', () => {
    const a = new RowId(Buffer.from([1, 2, 3]));
    const b = new RowId(Buffer.from([1, 2, 3]));
    const c = new RowId(Buffer.from([1, 2, 4]));

    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals('not a rowid')).toBe(false);
  });

  test('toJSON() returns hex string', () => {
    const rid = new RowId(Buffer.from([0xCA, 0xFE]));
    expect(JSON.stringify(rid)).toBe('"CAFE"');
  });

  test('handles empty bytes', () => {
    const rid = new RowId(null);
    expect(rid.length).toBe(0);
    expect(rid.toString()).toBe('');
  });

  test('accepts Uint8Array', () => {
    const rid = new RowId(new Uint8Array([0xAB, 0xCD]));
    expect(rid.toString()).toBe('ABCD');
  });
});
