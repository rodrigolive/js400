import { describe, test, expect } from 'bun:test';
import { DatabaseMetaData } from '../../src/db/api/DatabaseMetaData.js';

function createMockConnection(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return rows;
    },
  };
}

describe('DatabaseMetaData', () => {
  test('getTables() maps QSYS2 table rows into JDBC-style fields', async () => {
    const conn = createMockConnection([
      {
        TABLE_SCHEMA: 'MYLIB',
        TABLE_NAME: 'ORDERS',
        TABLE_TYPE: 'T',
        TABLE_TEXT: 'Customers',
      },
    ]);

    const md = new DatabaseMetaData(conn);
    const rows = await md.getTables({ schema: 'mylib', type: 'TABLE' });

    expect(conn.calls).toHaveLength(1);
    expect(conn.calls[0].params).toEqual(['MYLIB', 'T', 'TABLE']);
    expect(rows).toEqual([
      {
        TABLE_SCHEMA: 'MYLIB',
        TABLE_NAME: 'ORDERS',
        TABLE_TYPE: 'TABLE',
        TABLE_TEXT: 'Customers',
        TABLE_CAT: null,
        TABLE_SCHEM: 'MYLIB',
        REMARKS: 'Customers',
        SYSTEM_TABLE_TYPE: 'T',
      },
    ]);
  });

  test('getColumns() exposes JDBC-style column metadata while preserving raw catalog fields', async () => {
    const conn = createMockConnection([
      {
        TABLE_SCHEMA: 'MYLIB',
        TABLE_NAME: 'ORDERS',
        COLUMN_NAME: 'PEPAIS',
        ORDINAL_POSITION: 1,
        DATA_TYPE: 'DECIMAL',
        LENGTH: 3,
        NUMERIC_SCALE: 0,
        NUMERIC_PRECISION: 5,
        IS_NULLABLE: 'N',
        COLUMN_DEFAULT: null,
        COLUMN_TEXT: 'Country',
        CCSID: 0,
      },
      {
        TABLE_SCHEMA: 'MYLIB',
        TABLE_NAME: 'ORDERS',
        COLUMN_NAME: 'PENOM',
        ORDINAL_POSITION: 2,
        DATA_TYPE: 'CHAR',
        LENGTH: 13,
        NUMERIC_SCALE: null,
        NUMERIC_PRECISION: null,
        IS_NULLABLE: 'Y',
        COLUMN_DEFAULT: "' '",
        COLUMN_TEXT: 'Name',
        CCSID: 37,
      },
    ]);

    const md = new DatabaseMetaData(conn);
    const rows = await md.getColumns({ schema: 'mylib', table: 'orders' });

    expect(conn.calls).toHaveLength(1);
    expect(conn.calls[0].params).toEqual(['MYLIB', 'ORDERS']);

    expect(rows[0]).toMatchObject({
      TABLE_SCHEM: 'MYLIB',
      TABLE_NAME: 'ORDERS',
      COLUMN_NAME: 'PEPAIS',
      TYPE_NAME: 'DECIMAL',
      COLUMN_SIZE: 5,
      DECIMAL_DIGITS: 0,
      NUM_PREC_RADIX: 10,
      NULLABLE: 0,
      REMARKS: 'Country',
      IS_NULLABLE: 'NO',
      DATA_TYPE: 'DECIMAL',
      LENGTH: 3,
    });

    expect(rows[1]).toMatchObject({
      TABLE_SCHEM: 'MYLIB',
      TABLE_NAME: 'ORDERS',
      COLUMN_NAME: 'PENOM',
      TYPE_NAME: 'CHAR',
      COLUMN_SIZE: 13,
      DECIMAL_DIGITS: null,
      NUM_PREC_RADIX: null,
      NULLABLE: 1,
      CHAR_OCTET_LENGTH: 13,
      COLUMN_DEF: "' '",
      REMARKS: 'Name',
      IS_NULLABLE: 'YES',
      DATA_TYPE: 'CHAR',
      LENGTH: 13,
    });
  });

  test('getSchemas() adds TABLE_SCHEM alias', async () => {
    const conn = createMockConnection([
      {
        SCHEMA_NAME: 'MYLIB',
        SCHEMA_OWNER: 'TESTUSER',
        SYSTEM_SCHEMA_NAME: 'MYLIB',
      },
    ]);

    const md = new DatabaseMetaData(conn);
    const rows = await md.getSchemas({ schema: 'my%' });

    expect(conn.calls[0].params).toEqual(['MY%']);
    expect(rows[0]).toEqual({
      SCHEMA_NAME: 'MYLIB',
      SCHEMA_OWNER: 'TESTUSER',
      SYSTEM_SCHEMA_NAME: 'MYLIB',
      TABLE_CATALOG: null,
      TABLE_SCHEM: 'MYLIB',
    });
  });

  test('positioned-update metadata reflects the live-qualified cursor-name path', () => {
    const md = new DatabaseMetaData(createMockConnection([]));
    expect(md.supportsPositionedDelete()).toBe(true);
    expect(md.supportsPositionedUpdate()).toBe(true);
  });

  test('capability flags match runtime reality (no false positives)', () => {
    const md = new DatabaseMetaData(createMockConnection([]));
    // Multi-result-set machinery exists as API shape only — the engine
    // never surfaces additional server-side result sets today, so the
    // metadata must NOT report these as supported.
    expect(md.supportsMultipleResultSets()).toBe(false);
    expect(md.supportsMultipleOpenResults()).toBe(false);

    // Scroll types: FORWARD_ONLY and SCROLL_INSENSITIVE are honored;
    // SCROLL_SENSITIVE is not (no server-side sensitive scroll).
    expect(md.supportsResultSetType(1003)).toBe(true);  // FORWARD_ONLY
    expect(md.supportsResultSetType(1004)).toBe(true);  // SCROLL_INSENSITIVE
    expect(md.supportsResultSetType(1005)).toBe(false); // SCROLL_SENSITIVE

    // Concurrency: only CONCUR_READ_ONLY, and only for supported types.
    expect(md.supportsResultSetConcurrency(1007, 1003)).toBe(true);
    expect(md.supportsResultSetConcurrency(1007, 1005)).toBe(false);
    expect(md.supportsResultSetConcurrency(1008, 1003)).toBe(false); // CONCUR_UPDATABLE
  });
});
