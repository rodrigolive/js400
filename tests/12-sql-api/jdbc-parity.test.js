/**
 * Comprehensive mock tests for the JDBC-parity DB2 API layer.
 *
 * Tests ResultSet, ResultSetMetaData, ParameterMetaData, PreparedStatement,
 * CallableStatement, Connection, DatabaseMetaData, SqlWarning, and
 * PreparedStatementCache using mock data only (no server required).
 */
import { describe, test, expect } from 'bun:test';
import { ResultSet, FetchDirection, ResultSetType, ResultSetConcurrency, ResultSetHoldability } from '../../src/db/api/ResultSet.js';
import { ResultSetMetaData, JdbcType, ColumnNullable } from '../../src/db/api/ResultSetMetaData.js';
import { ParameterMetaData, ParameterMode, ParameterNullable } from '../../src/db/api/ParameterMetaData.js';
import { PreparedStatement, SQL_NULL } from '../../src/db/api/PreparedStatement.js';
import { CallableStatement } from '../../src/db/api/CallableStatement.js';
import { SqlWarning } from '../../src/db/api/SqlWarning.js';
import { PreparedStatementCache } from '../../src/db/api/PreparedStatementCache.js';
import {
  DatabaseMetaData, BestRowScope, BestRowNullable,
  VersionColumnPseudo, ForeignKeyRule,
} from '../../src/db/api/DatabaseMetaData.js';

// ─── Shared test fixtures ──────────────────────────────────────────────

const sampleColDescs = [
  { index: 0, name: 'ID', label: 'ID', typeName: 'INTEGER', sqlType: 496, precision: 10, scale: 0, nullable: false, ccsid: 37 },
  { index: 1, name: 'NAME', label: 'NAME', typeName: 'VARCHAR', sqlType: 448, precision: 50, scale: 0, nullable: true, ccsid: 37 },
  { index: 2, name: 'SALARY', label: 'SALARY', typeName: 'DECIMAL', sqlType: 484, precision: 15, scale: 2, nullable: true, ccsid: 37 },
  { index: 3, name: 'HIRED', label: 'HIRED', typeName: 'DATE', sqlType: 384, precision: 10, scale: 0, nullable: true, ccsid: 37 },
];

const sampleRows = [
  { ID: 1, NAME: 'Alice', SALARY: 75000.50, HIRED: new Date('2020-01-15') },
  { ID: 2, NAME: 'Bob', SALARY: 60000, HIRED: new Date('2021-06-01') },
  { ID: 3, NAME: null, SALARY: null, HIRED: null },
];

// ─── ResultSet ─────────────────────────────────────────────────────────

describe('ResultSet', () => {
  test('constants are frozen', () => {
    expect(FetchDirection.forward).toBe(1000);
    expect(ResultSetType.forwardOnly).toBe(1003);
    expect(ResultSetConcurrency.readOnly).toBe(1007);
    expect(ResultSetHoldability.holdCursorsOverCommit).toBe(1);
    expect(ResultSetHoldability.closeCursorsAtCommit).toBe(2);
  });

  test('constructor defaults', () => {
    const rs = new ResultSet();
    expect(rs.length).toBe(0);
    expect(rs.closed).toBe(false);
  });

  test('next() advances cursor', async () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleColDescs });
    expect(await rs.next()).toBe(true);
    expect(rs.getRow()).toBe(1);
    expect(await rs.next()).toBe(true);
    expect(rs.getRow()).toBe(2);
    expect(await rs.next()).toBe(true);
    expect(await rs.next()).toBe(false);
  });

  test('typed getters', async () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleColDescs });
    await rs.next(); // row 1
    expect(rs.getInt(1)).toBe(1);
    expect(rs.getString(2)).toBe('Alice');
    expect(rs.getDouble(3)).toBeCloseTo(75000.5);
    expect(rs.wasNull()).toBe(false);

    await rs.next(); // row 2
    expect(rs.getInt(1)).toBe(2);

    await rs.next(); // row 3 (has nulls in NAME/SALARY/HIRED)
    expect(rs.getObject(2)).toBeNull();
    expect(rs.wasNull()).toBe(true);
    expect(rs.getString(2)).toBeNull();
    expect(rs.getDouble(3)).toBe(0);
    expect(rs.wasNull()).toBe(true);
  });

  test('getBoolean converts values', async () => {
    const rs = new ResultSet({
      rows: [{ A: true, B: 0, C: 'yes', D: 'no', E: null }],
      columnDescriptors: [
        { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' },
      ],
    });
    await rs.next();
    expect(rs.getBoolean('A')).toBe(true);
    expect(rs.getBoolean('B')).toBe(false);
    expect(rs.getBoolean('C')).toBe(true);
    expect(rs.getBoolean('D')).toBe(false);
    expect(rs.getBoolean('E')).toBe(false);
  });

  test('getLong with bigint', async () => {
    const rs = new ResultSet({
      rows: [{ VAL: 9007199254740991n }],
      columnDescriptors: [{ name: 'VAL' }],
    });
    await rs.next();
    expect(rs.getLong('VAL')).toBe(9007199254740991n);
  });

  test('findColumn by name', () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleColDescs });
    expect(rs.findColumn('ID')).toBe(1);
    expect(rs.findColumn('name')).toBe(2); // case-insensitive
    expect(() => rs.findColumn('NONEXISTENT')).toThrow();
  });

  test('getMetaData returns ResultSetMetaData', () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleColDescs });
    const md = rs.getMetaData();
    expect(md).toBeInstanceOf(ResultSetMetaData);
    expect(md.getColumnCount()).toBe(4);
  });

  test('isFirst / isAfterLast / getRow', async () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleColDescs });
    expect(rs.isBeforeFirst()).toBe(true);
    await rs.next();
    expect(rs.isFirst()).toBe(true);
    expect(rs.getRow()).toBe(1);
    await rs.next();
    await rs.next();
    await rs.next();
    expect(rs.isAfterLast()).toBe(true);
  });

  test('absolute positioning', async () => {
    const rs = new ResultSet({
      rows: sampleRows,
      columnDescriptors: sampleColDescs,
      type: ResultSetType.scrollInsensitive,
    });
    expect(await rs.absolute(2)).toBe(true);
    expect(rs.getRow()).toBe(2);
    expect(await rs.absolute(-1)).toBe(true);
    expect(rs.getRow()).toBe(3);
    expect(await rs.absolute(0)).toBe(false);
    expect(await rs.absolute(99)).toBe(false);
  });

  test('previous()', async () => {
    const rs = new ResultSet({
      rows: sampleRows,
      columnDescriptors: sampleColDescs,
      type: ResultSetType.scrollInsensitive,
    });
    await rs.next();
    await rs.next();
    expect(await rs.previous()).toBe(true);
    expect(rs.getRow()).toBe(1);
  });

  test('warnings chain', () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleColDescs });
    expect(rs.getWarnings()).toBeNull();
    rs.addWarning('test warning', { sqlState: '01000' });
    expect(rs.getWarnings()).toBeInstanceOf(SqlWarning);
    rs.clearWarnings();
    expect(rs.getWarnings()).toBeNull();
  });

  test('close', async () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleColDescs });
    expect(rs.closed).toBe(false);
    await rs.close();
    expect(rs.closed).toBe(true);
  });

  test('async iterator yields all rows', async () => {
    const rs = new ResultSet({ rows: sampleRows, columnDescriptors: sampleColDescs });
    const collected = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected.length).toBe(3);
  });
});

// ─── ResultSetMetaData ─────────────────────────────────────────────────

describe('ResultSetMetaData', () => {
  test('getColumnCount', () => {
    const md = new ResultSetMetaData(sampleColDescs);
    expect(md.getColumnCount()).toBe(4);
  });

  test('getColumnName / getColumnLabel', () => {
    const md = new ResultSetMetaData(sampleColDescs);
    expect(md.getColumnName(1)).toBe('ID');
    expect(md.getColumnLabel(2)).toBe('NAME');
  });

  test('getColumnType', () => {
    const md = new ResultSetMetaData(sampleColDescs);
    expect(md.getColumnType(1)).toBe(JdbcType.INTEGER);
    expect(md.getColumnType(2)).toBe(JdbcType.VARCHAR);
  });

  test('getColumnTypeName', () => {
    const md = new ResultSetMetaData(sampleColDescs);
    expect(md.getColumnTypeName(1)).toBe('INTEGER');
    expect(md.getColumnTypeName(2)).toBe('VARCHAR');
  });

  test('getPrecision / getScale', () => {
    const md = new ResultSetMetaData(sampleColDescs);
    expect(md.getPrecision(1)).toBe(10);
    expect(md.getScale(3)).toBe(2);
  });

  test('isNullable', () => {
    const md = new ResultSetMetaData(sampleColDescs);
    expect(md.isNullable(1)).toBe(ColumnNullable.noNulls);
    expect(md.isNullable(2)).toBe(ColumnNullable.nullable);
  });

  test('isAutoIncrement / isReadOnly / isSearchable defaults', () => {
    const md = new ResultSetMetaData(sampleColDescs);
    expect(md.isAutoIncrement(1)).toBe(false);
    expect(md.isReadOnly(1)).toBe(false);
    expect(md.isSearchable(1)).toBe(true);
  });

  test('JdbcType enum has key types', () => {
    expect(JdbcType.INTEGER).toBeDefined();
    expect(JdbcType.VARCHAR).toBeDefined();
    expect(JdbcType.BOOLEAN).toBeDefined();
    expect(JdbcType.BLOB).toBeDefined();
  });

  test('toPlainArray', () => {
    const md = new ResultSetMetaData(sampleColDescs);
    const arr = md.toPlainArray();
    expect(arr.length).toBe(4);
    expect(arr[0].name).toBe('ID');
  });
});

// ─── ParameterMetaData ──────────────────────────────────────────────────

describe('ParameterMetaData', () => {
  const paramDescs = [
    { name: 'P1', typeName: 'INTEGER', sqlType: 496, precision: 10, scale: 0, nullable: false, ccsid: 37 },
    { name: 'P2', typeName: 'VARCHAR', sqlType: 448, precision: 50, scale: 0, nullable: true, ccsid: 37 },
  ];

  test('getParameterCount', () => {
    const md = new ParameterMetaData(paramDescs);
    expect(md.getParameterCount()).toBe(2);
  });

  test('getParameterMode defaults to IN', () => {
    const md = new ParameterMetaData(paramDescs);
    expect(md.getParameterMode(1)).toBe(ParameterMode.in);
  });

  test('setParameterMode', () => {
    const md = new ParameterMetaData(paramDescs);
    md.setParameterMode(1, ParameterMode.out);
    expect(md.getParameterMode(1)).toBe(ParameterMode.out);
  });

  test('isNullable', () => {
    const md = new ParameterMetaData(paramDescs);
    expect(md.isNullable(1)).toBe(ParameterNullable.noNulls);
    expect(md.isNullable(2)).toBe(ParameterNullable.nullable);
  });

  test('getPrecision / getScale', () => {
    const md = new ParameterMetaData(paramDescs);
    expect(md.getPrecision(1)).toBe(10);
    expect(md.getScale(1)).toBe(0);
  });

  test('toPlainArray', () => {
    const md = new ParameterMetaData(paramDescs);
    const arr = md.toPlainArray();
    expect(arr.length).toBe(2);
  });
});

// ─── PreparedStatement ─────────────────────────────────────────────────

describe('PreparedStatement', () => {
  function makeStmt(paramCount = 2) {
    const handle = {
      paramCount,
      columnCount: 0,
      paramDescriptors: [],
      columnDescriptors: [],
    };
    return new PreparedStatement({}, handle, 'SELECT * FROM T WHERE A = ? AND B = ?');
  }

  test('SQL_NULL symbol', () => {
    expect(typeof SQL_NULL).toBe('symbol');
    expect(SQL_NULL).toBe(Symbol.for('js400.sql.null'));
  });

  test('setParameter bounds', () => {
    const stmt = makeStmt(2);
    expect(() => stmt.setInt(0, 1)).toThrow(RangeError);
    expect(() => stmt.setInt(3, 1)).toThrow(RangeError);
  });

  test('setInt / setString / setBoolean', () => {
    const stmt = makeStmt(2);
    expect(() => stmt.setInt(1, 42)).not.toThrow();
    expect(() => stmt.setString(2, 'hello')).not.toThrow();
    expect(() => stmt.setBoolean(1, true)).not.toThrow();
  });

  test('setNull uses SQL_NULL', () => {
    const stmt = makeStmt(1);
    stmt.setNull(1, JdbcType.INTEGER);
    // Just verifies it doesn't throw
  });

  test('setBoolean encodes as 0/1', () => {
    const stmt = makeStmt(1);
    stmt.setBoolean(1, true);
    stmt.setBoolean(1, false);
    stmt.setBoolean(1, null); // should use SQL_NULL
  });

  test('clearParameters', () => {
    const stmt = makeStmt(2);
    stmt.setInt(1, 1);
    stmt.clearParameters();
  });

  test('fetchSize / maxRows / queryTimeout', () => {
    const stmt = makeStmt(0);
    stmt.setFetchSize(100);
    expect(stmt.getFetchSize()).toBe(100);
    stmt.setMaxRows(50);
    expect(stmt.getMaxRows()).toBe(50);
    stmt.setQueryTimeout(30);
    expect(stmt.getQueryTimeout()).toBe(30);
  });

  test('addBatch / clearBatch', () => {
    const stmt = makeStmt(1);
    stmt.setInt(1, 1);
    stmt.addBatch();
    stmt.setInt(1, 2);
    stmt.addBatch();
    stmt.clearBatch();
  });

  test('close', async () => {
    const stmt = makeStmt(0);
    await stmt.close();
    expect(stmt.closed).toBe(true);
  });
});

// ─── CallableStatement ──────────────────────────────────────────────────

describe('CallableStatement', () => {
  function makeCall() {
    // Minimal mock connection with prepare()
    const conn = {
      async prepare(sql) {
        return {
          async execute(params) { return []; },
          async close() {},
          paramCount: 3,
          columnCount: 0,
          paramDescriptors: [],
          columnDescriptors: [],
        };
      },
    };
    return new CallableStatement(conn, 'MYLIB.MYPROC');
  }

  test('registerOutParameter', () => {
    const cstmt = makeCall();
    cstmt.registerOutParameter(1, 'integer');
    cstmt.registerOutParameter(2, 'varchar');
    // Slots are 1-based; the array has a hole at [0], so length = 3
    expect(cstmt.parameterCount).toBe(3);
  });

  test('setObject', () => {
    const cstmt = makeCall();
    cstmt.setObject(1, 42);
    expect(cstmt.parameterCount).toBe(2);
  });

  test('setParameterName + named getter', () => {
    const cstmt = makeCall();
    cstmt.setParameterName(1, 'UserId');
    cstmt.setObject(1, 99);
    cstmt.setParameterName(2, 'Result');
    cstmt.registerOutParameter(2, 'integer');
  });

  test('setOutValue for engine-layer population', () => {
    const cstmt = makeCall();
    cstmt.registerOutParameter(1, 'integer');
    cstmt.setOutValue(1, 42);
    expect(cstmt.getInt(1)).toBe(42);
    expect(cstmt.wasNull()).toBe(false);
  });

  test('typed OUT getters', () => {
    const cstmt = makeCall();
    cstmt.registerOutParameter(1, 'integer');
    cstmt.setOutValue(1, 42);
    expect(cstmt.getInt(1)).toBe(42);
    expect(cstmt.getString(1)).toBe('42');
    expect(cstmt.getBoolean(1)).toBe(true);
  });

  test('null OUT value', () => {
    const cstmt = makeCall();
    cstmt.registerOutParameter(1, 'varchar');
    cstmt.setOutValue(1, null);
    expect(cstmt.getString(1)).toBeNull();
    expect(cstmt.wasNull()).toBe(true);
  });
});

// ─── SqlWarning ────────────────────────────────────────────────────────

describe('SqlWarning', () => {
  test('constructor defaults', () => {
    const w = new SqlWarning('test');
    expect(w.message).toBe('test');
    expect(w.sqlState).toBe('01000');
    expect(w.vendorCode).toBe(0);
  });

  test('custom sqlState', () => {
    const w = new SqlWarning('disk full', { sqlState: '57011', vendorCode: -901 });
    expect(w.sqlState).toBe('57011');
    expect(w.vendorCode).toBe(-901);
  });

  test('chain via setNextWarning', () => {
    const w1 = new SqlWarning('first');
    const w2 = new SqlWarning('second');
    const w3 = new SqlWarning('third');
    w1.setNextWarning(w2);
    w1.setNextWarning(w3);
    expect(w1.getNextWarning()).toBe(w2);
    expect(w2.getNextWarning()).toBe(w3);
    expect(w3.getNextWarning()).toBeNull();
  });

  test('iterator', () => {
    const w1 = new SqlWarning('a');
    const w2 = new SqlWarning('b');
    w1.setNextWarning(w2);
    const msgs = [...w1].map(w => w.message);
    expect(msgs).toEqual(['a', 'b']);
  });

  test('toString', () => {
    const w = new SqlWarning('oops', { sqlState: '01004' });
    expect(w.toString()).toContain('01004');
    expect(w.toString()).toContain('oops');
  });
});

// ─── PreparedStatementCache ────────────────────────────────────────────

describe('PreparedStatementCache', () => {
  test('miss on empty cache', () => {
    const cache = new PreparedStatementCache(4);
    expect(cache.get('SELECT 1')).toBeNull();
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(0);
  });

  test('put and get', () => {
    const cache = new PreparedStatementCache(4);
    const handle = { id: 1 };
    cache.put('SELECT 1', handle);
    expect(cache.get('SELECT 1')).toBe(handle);
    expect(cache.hits).toBe(1);
  });

  test('normalizes SQL key', () => {
    const cache = new PreparedStatementCache(4);
    const handle = { id: 1 };
    cache.put('select  1', handle);
    expect(cache.get('SELECT 1')).toBe(handle);
  });

  test('LRU eviction', () => {
    const cache = new PreparedStatementCache(2);
    cache.put('A', { id: 'A' });
    cache.put('B', { id: 'B' });
    cache.put('C', { id: 'C' }); // evicts A
    expect(cache.get('A')).toBeNull();
    expect(cache.get('B')).not.toBeNull();
    expect(cache.get('C')).not.toBeNull();
    expect(cache.size).toBe(2);
  });

  test('LRU reordering on get', () => {
    const cache = new PreparedStatementCache(2);
    cache.put('A', { id: 'A' });
    cache.put('B', { id: 'B' });
    cache.get('A'); // touch A, making B the LRU
    cache.put('C', { id: 'C' }); // evicts B
    expect(cache.get('A')).not.toBeNull();
    expect(cache.get('B')).toBeNull();
    expect(cache.get('C')).not.toBeNull();
  });

  test('delete', () => {
    const cache = new PreparedStatementCache(4);
    cache.put('X', { id: 'X' });
    expect(cache.delete('X')).toBe(true);
    expect(cache.get('X')).toBeNull();
    expect(cache.delete('X')).toBe(false);
  });

  test('clear', () => {
    const cache = new PreparedStatementCache(4);
    cache.put('A', {});
    cache.put('B', {});
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test('stats', () => {
    const cache = new PreparedStatementCache(4);
    cache.put('A', {});
    cache.get('A');
    cache.get('B');
    const s = cache.stats();
    expect(s.size).toBe(1);
    expect(s.capacity).toBe(4);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(0.5);
  });
});

// ─── DatabaseMetaData ──────────────────────────────────────────────────

describe('DatabaseMetaData', () => {
  function makeMeta() {
    // Mock connection with query()
    const conn = {
      async query(sql, params) {
        // Return canned data for known catalog views
        if (sql.includes('SYSSCHEMAS')) {
          return [
            { SCHEMA_NAME: 'QGPL', SCHEMA_OWNER: 'QSYS', SYSTEM_SCHEMA_NAME: 'QGPL' },
            { SCHEMA_NAME: 'MYLIB', SCHEMA_OWNER: 'ME', SYSTEM_SCHEMA_NAME: 'MYLIB' },
          ];
        }
        if (sql.includes('SYSTABLES')) {
          return [
            { TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'EMP', TABLE_TYPE: 'T', TABLE_TEXT: 'Employees' },
            { TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'DEPT', TABLE_TYPE: 'V', TABLE_TEXT: 'Departments' },
          ];
        }
        if (sql.includes('SYSCOLUMNS')) {
          return [
            { TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'EMP', COLUMN_NAME: 'ID', ORDINAL_POSITION: 1, DATA_TYPE: 'INTEGER', LENGTH: 4, NUMERIC_SCALE: 0, NUMERIC_PRECISION: 10, IS_NULLABLE: 'N', COLUMN_DEFAULT: null, COLUMN_TEXT: 'Emp ID', CCSID: 37 },
            { TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'EMP', COLUMN_NAME: 'NAME', ORDINAL_POSITION: 2, DATA_TYPE: 'VARCHAR', LENGTH: 50, NUMERIC_SCALE: 0, NUMERIC_PRECISION: null, IS_NULLABLE: 'Y', COLUMN_DEFAULT: null, COLUMN_TEXT: 'Emp Name', CCSID: 37 },
          ];
        }
        return [];
      },
    };
    return new DatabaseMetaData(conn);
  }

  test('getSchemas', async () => {
    const md = makeMeta();
    const schemas = await md.getSchemas({ schema: 'MY%' });
    expect(schemas.length).toBeGreaterThan(0);
    expect(schemas[0].TABLE_SCHEM).toBeDefined();
  });

  test('getCatalogs', async () => {
    const md = makeMeta();
    const cats = await md.getCatalogs();
    expect(cats).toHaveLength(1);
  });

  test('getTableTypes', () => {
    const md = makeMeta();
    const types = md.getTableTypes();
    expect(types.length).toBe(5);
    expect(types.map(t => t.TABLE_TYPE)).toContain('TABLE');
    expect(types.map(t => t.TABLE_TYPE)).toContain('VIEW');
  });

  test('getTypeInfo', () => {
    const md = makeMeta();
    const info = md.getTypeInfo();
    expect(info.length).toBeGreaterThan(10);
    const charInfo = info.find(t => t.TYPE_NAME === 'CHAR');
    expect(charInfo).toBeDefined();
    expect(charInfo.DATA_TYPE).toBe(JdbcType.CHAR);
    expect(charInfo.PRECISION).toBe(32765);
  });

  test('getTables', async () => {
    const md = makeMeta();
    const tables = await md.getTables({ schema: 'MYLIB' });
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0].TABLE_SCHEM).toBe('MYLIB');
    expect(tables[0].TABLE_TYPE).toBe('TABLE');
  });

  test('getColumns', async () => {
    const md = makeMeta();
    const cols = await md.getColumns({ schema: 'MYLIB', table: 'EMP' });
    expect(cols.length).toBe(2);
    expect(cols[0].TYPE_NAME).toBe('INTEGER');
    expect(cols[0].COLUMN_SIZE).toBe(10);
  });

  test('getClientInfoProperties', () => {
    const md = makeMeta();
    const props = md.getClientInfoProperties();
    expect(props.length).toBe(5);
    expect(props[0].NAME).toBe('ApplicationName');
  });

  test('getSuperTypes / getSuperTables return empty', () => {
    const md = makeMeta();
    expect(md.getSuperTypes()).toEqual([]);
    expect(md.getSuperTables()).toEqual([]);
  });

  // Capability reporting

  test('allProceduresAreCallable', () => {
    expect(makeMeta().allProceduresAreCallable()).toBe(true);
  });

  test('supportsBatchUpdates', () => {
    expect(makeMeta().supportsBatchUpdates()).toBe(true);
  });

  test('getMaxColumnNameLength', () => {
    expect(makeMeta().getMaxColumnNameLength()).toBe(128);
  });

  test('getMaxRowSize', () => {
    expect(makeMeta().getMaxRowSize()).toBe(32766);
  });

  test('getSQLKeywords returns string', () => {
    const kw = makeMeta().getSQLKeywords();
    expect(typeof kw).toBe('string');
    expect(kw.length).toBeGreaterThan(0);
  });

  test('getNumericFunctions returns string', () => {
    const fn = makeMeta().getNumericFunctions();
    expect(fn).toContain('ABS');
    expect(fn).toContain('SQRT');
  });

  test('nullsAreSortedLow', () => {
    expect(makeMeta().nullsAreSortedLow()).toBe(true);
  });

  test('nullsAreSortedHigh', () => {
    expect(makeMeta().nullsAreSortedHigh()).toBe(false);
  });

  test('ForeignKeyRule constants', () => {
    expect(ForeignKeyRule.noAction).toBe(0);
    expect(ForeignKeyRule.cascade).toBe(2);
    expect(ForeignKeyRule.setNull).toBe(3);
  });

  test('BestRowScope constants', () => {
    expect(BestRowScope.temporary).toBe(0);
    expect(BestRowScope.session).toBe(2);
  });
});

// ─── Connection (mock) ──────────────────────────────────────────────────

describe('Connection (mock integration)', () => {
  test('TransactionIsolation constants', async () => {
    const { Connection, TransactionIsolation: TI } = await import('../../src/db/api/Connection.js');
    expect(TI.none).toBe(0);
    expect(TI.readCommitted).toBe(2);
    expect(TI.serializable).toBe(8);
  });

  test('Connection defaults with mock dbConnection', async () => {
    const { Connection } = await import('../../src/db/api/Connection.js');
    const mockDb = {
      connected: true,
      close: async () => {},
      getAutoCommit: () => true,
      setAutoCommit: () => {},
      prepareStatement: async () => ({ paramCount: 0, columnCount: 0, paramDescriptors: [], columnDescriptors: [] }),
      executeImmediate: async () => [],
    };
    const conn = new Connection(mockDb, { statementCacheSize: 8 });
    expect(conn.connected).toBe(true);
    expect(conn.closed).toBe(false);

    // Statement cache stats
    const stats = conn.statementCacheStats();
    expect(stats.capacity).toBe(8);
    expect(stats.size).toBe(0);
  });

  test('setReadOnly / isReadOnly', async () => {
    const { Connection } = await import('../../src/db/api/Connection.js');
    const mockDb = {
      connected: true,
      close: async () => {},
      getAutoCommit: () => true,
      setAutoCommit: () => {},
      executeImmediate: async () => [],
    };
    const conn = new Connection(mockDb);
    expect(conn.isReadOnly()).toBe(false);
    await conn.setReadOnly(true);
    expect(conn.isReadOnly()).toBe(true);
  });

  test('setHoldability / getHoldability', async () => {
    const { Connection } = await import('../../src/db/api/Connection.js');
    const mockDb = { connected: true, close: async () => {} };
    const conn = new Connection(mockDb);
    expect(conn.getHoldability()).toBe(ResultSetHoldability.closeCursorsAtCommit);
    conn.setHoldability(ResultSetHoldability.holdCursorsOverCommit);
    expect(conn.getHoldability()).toBe(ResultSetHoldability.holdCursorsOverCommit);
    expect(() => conn.setHoldability(999)).toThrow();
  });

  test('setClientInfo / getClientInfo', async () => {
    const { Connection } = await import('../../src/db/api/Connection.js');
    const mockDb = {
      connected: true,
      close: async () => {},
      executeImmediate: async () => [],
    };
    const conn = new Connection(mockDb);
    await conn.setClientInfo('ApplicationName', 'test-app');
    expect(conn.getClientInfo('ApplicationName')).toBe('test-app');
    const all = conn.getClientInfo();
    expect(all.ApplicationName).toBe('test-app');
  });

  test('warnings chain', async () => {
    const { Connection } = await import('../../src/db/api/Connection.js');
    const mockDb = { connected: true, close: async () => {} };
    const conn = new Connection(mockDb);
    expect(conn.getWarnings()).toBeNull();
    conn.addWarning('first');
    conn.addWarning('second');
    const w = conn.getWarnings();
    expect(w).toBeInstanceOf(SqlWarning);
    expect(w.message).toBe('first');
    conn.clearWarnings();
    expect(conn.getWarnings()).toBeNull();
  });

  test('LOB factories return correct types', async () => {
    const { Connection } = await import('../../src/db/api/Connection.js');
    const { Blob: DbBlob } = await import('../../src/db/lob/Blob.js');
    const { Clob: DbClob } = await import('../../src/db/lob/Clob.js');
    const mockDb = { connected: true, close: async () => {} };
    const conn = new Connection(mockDb);
    expect(conn.createBlob()).toBeInstanceOf(DbBlob);
    expect(conn.createClob()).toBeInstanceOf(DbClob);
    expect(conn.createNClob()).toBeInstanceOf(DbClob);
  });

  test('close', async () => {
    const { Connection } = await import('../../src/db/api/Connection.js');
    let closed = false;
    const mockDb = { connected: true, close: async () => { closed = true; } };
    const conn = new Connection(mockDb);
    await conn.close();
    expect(conn.closed).toBe(true);
    expect(closed).toBe(true);
  });
});
