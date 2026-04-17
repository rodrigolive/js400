/**
 * Tests for ResultSet API.
 */
import { describe, test, expect } from 'bun:test';
import { ResultSet } from '../../src/db/api/ResultSet.js';

const sampleDescriptors = [
  { index: 0, name: 'ID', label: 'ID', typeName: 'INTEGER', sqlType: 496, precision: 10, scale: 0, nullable: false },
  { index: 1, name: 'NAME', label: 'NAME', typeName: 'VARCHAR', sqlType: 448, precision: 50, scale: 0, nullable: true },
];

const sampleRows = [
  { ID: 1, NAME: 'Alice' },
  { ID: 2, NAME: 'Bob' },
  { ID: 3, NAME: 'Charlie' },
];

describe('ResultSet', () => {
  test('constructor with pre-fetched rows', () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleDescriptors });
    expect(rs.length).toBe(3);
    expect(rs.closed).toBe(false);
  });

  test('get() returns row by index', () => {
    const rs = new ResultSet({ rows: sampleRows });
    expect(rs.get(0)).toEqual({ ID: 1, NAME: 'Alice' });
    expect(rs.get(2)).toEqual({ ID: 3, NAME: 'Charlie' });
    expect(rs.get(5)).toBeUndefined();
  });

  test('metadata returns column info', () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleDescriptors });
    const meta = rs.metadata;
    expect(meta.length).toBe(2);
    expect(meta[0].name).toBe('ID');
    expect(meta[0].typeName).toBe('INTEGER');
    expect(meta[1].name).toBe('NAME');
    expect(meta[1].nullable).toBe(true);
  });

  test('toArray() returns all rows', async () => {
    const rs = new ResultSet({ rows: sampleRows });
    const arr = await rs.toArray();
    expect(arr).toEqual(sampleRows);
    // Returns a copy
    expect(arr).not.toBe(sampleRows);
  });

  test('synchronous iterator works', () => {
    const rs = new ResultSet({ rows: sampleRows });
    const collected = [];
    for (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(sampleRows);
  });

  test('async iterator yields all rows', async () => {
    const rs = new ResultSet({ rows: sampleRows, endOfData: true });
    const collected = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(sampleRows);
  });

  test('async iterator fetches more rows from cursor manager', async () => {
    let fetchCount = 0;
    const mockCursorManager = {
      async fetch(rpbId, count) {
        fetchCount++;
        if (fetchCount === 1) {
          return [{ ID: 4, NAME: 'Diana' }];
        }
        return [];
      },
      async closeCursor() {},
    };

    const rs = new ResultSet({
      rows: [{ ID: 1, NAME: 'Alice' }],
      cursorManager: mockCursorManager,
      rpbId: 1,
      endOfData: false,
      fetchSize: 10,
    });

    const collected = [];
    for await (const row of rs) {
      collected.push(row);
    }

    expect(collected.length).toBe(2);
    expect(collected[0].NAME).toBe('Alice');
    expect(collected[1].NAME).toBe('Diana');
  });

  test('close() marks result set as closed', async () => {
    const closedRpbIds = [];
    const mockCursorManager = {
      async closeCursor(rpbId) { closedRpbIds.push(rpbId); },
    };

    const rs = new ResultSet({
      rows: sampleRows,
      cursorManager: mockCursorManager,
      rpbId: 42,
    });

    await rs.close();
    expect(rs.closed).toBe(true);
    expect(closedRpbIds).toContain(42);
  });

  test('close() is idempotent', async () => {
    let closeCount = 0;
    const mockCursorManager = {
      async closeCursor() { closeCount++; },
    };

    const rs = new ResultSet({
      rows: [],
      cursorManager: mockCursorManager,
      rpbId: 1,
    });

    await rs.close();
    await rs.close();
    expect(closeCount).toBe(1);
  });

  test('empty result set', async () => {
    const rs = new ResultSet({ rows: [] });
    expect(rs.length).toBe(0);
    const arr = await rs.toArray();
    expect(arr).toEqual([]);

    const collected = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual([]);
  });

  test('metadata with no descriptors falls back gracefully', () => {
    const rs = new ResultSet({ rows: sampleRows });
    expect(rs.metadata).toEqual([]);
  });

  test('columns getter returns descriptors', () => {
    const rs = new ResultSet({ rows: [], columnDescriptors: sampleDescriptors });
    expect(rs.columns).toBe(sampleDescriptors);
  });
});
