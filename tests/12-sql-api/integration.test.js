/**
 * Integration tests for the SQL API layer.
 *
 * These tests wire together multiple layers (Connection, Statement,
 * PreparedStatement, ResultSet, transactions, pool) using mock
 * DbConnection objects to verify end-to-end flows.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { Connection } from '../../src/db/api/Connection.js';
import { ConnectionPool } from '../../src/db/pool/ConnectionPool.js';
import { Blob } from '../../src/db/lob/Blob.js';
import { Clob } from '../../src/db/lob/Clob.js';
import { SQLXML } from '../../src/db/lob/SQLXML.js';
import { parseJdbcUrl } from '../../src/db/url.js';
import { normalizeProperties, validateProperties } from '../../src/db/properties.js';

/**
 * Create a full mock DbConnection with in-memory table data.
 */
function createMockDbWithData(tableData = []) {
  let autoCommit = true;
  let committed = false;
  let rolledBack = false;
  const data = [...tableData];
  const stmtCounter = { value: 0 };

  const stmtManager = {
    execute: async (handle, params = []) => {
      const sql = handle.sql.toUpperCase().trim();

      if (sql.startsWith('SELECT')) {
        return {
          hasResultSet: true,
          rows: data.map(row => ({ ...row })),
          affectedRows: 0,
          sqlca: { sqlCode: 0, rowCount: 0 },
          rpbId: handle.rpbId,
          endOfData: true,
          columnDescriptors: handle.columnDescriptors,
        };
      }

      if (sql.startsWith('INSERT')) {
        data.push({ ID: params[0] || data.length + 1, NAME: params[1] || 'NEW' });
        return {
          hasResultSet: false,
          rows: [],
          affectedRows: 1,
          sqlca: { sqlCode: 0, rowCount: 1 },
          rpbId: handle.rpbId,
          endOfData: true,
          columnDescriptors: [],
        };
      }

      if (sql.startsWith('UPDATE')) {
        return {
          hasResultSet: false,
          rows: [],
          affectedRows: data.length,
          sqlca: { sqlCode: 0, rowCount: data.length },
          rpbId: handle.rpbId,
          endOfData: true,
          columnDescriptors: [],
        };
      }

      if (sql.startsWith('DELETE')) {
        const count = data.length;
        data.length = 0;
        return {
          hasResultSet: false,
          rows: [],
          affectedRows: count,
          sqlca: { sqlCode: 0, rowCount: count },
          rpbId: handle.rpbId,
          endOfData: true,
          columnDescriptors: [],
        };
      }

      return {
        hasResultSet: false,
        rows: [],
        affectedRows: 0,
        sqlca: { sqlCode: 0, rowCount: 0 },
        rpbId: handle.rpbId,
        endOfData: true,
        columnDescriptors: [],
      };
    },
    closeStatement: async (handle) => { handle.closed = true; },
    executeBatch: async (handle, paramSets) => {
      const sql = handle.sql.toUpperCase().trim();
      const isInsert = sql.startsWith('INSERT');
      if (isInsert) {
        for (const params of paramSets) {
          data.push({ ID: params[0] || data.length + 1, NAME: params[1] || 'NEW' });
        }
      }
      return {
        affectedRows: paramSets.length,
        sqlca: { sqlCode: 0, rowCount: paramSets.length },
        batchSize: paramSets.length,
        isInsert,
      };
    },
  };

  const cursorManager = {
    async fetch() { return []; },
    async closeCursor() {},
  };

  return {
    connected: true,
    prepareStatement: async (sql) => {
      stmtCounter.value++;
      return {
        rpbId: stmtCounter.value,
        sql,
        columnDescriptors: [
          { index: 0, name: 'ID', label: 'ID', typeName: 'INTEGER', sqlType: 496 },
          { index: 1, name: 'NAME', label: 'NAME', typeName: 'VARCHAR', sqlType: 448, nullable: true },
        ],
        paramDescriptors: [{ sqlType: 496 }, { sqlType: 448 }],
        paramCount: 2,
        columnCount: 2,
        closed: false,
      };
    },
    executeImmediate: async (sql) => ({
      sqlca: { sqlCode: 0, rowCount: 0 },
      affectedRows: 0,
    }),
    statementManager: stmtManager,
    cursorManager,
    setAutoCommit(val) { autoCommit = val; },
    getAutoCommit() { return autoCommit; },
    async commit() { committed = true; },
    async rollback() { rolledBack = true; },
    async setSavepoint(name) {
      return { id: 1, name: name || 'SP_1' };
    },
    async rollbackToSavepoint(sp) {},
    async close() {},
    _test: {
      get committed() { return committed; },
      get rolledBack() { return rolledBack; },
      get data() { return data; },
    },
  };
}

describe('End-to-end query flow', () => {
  test('query → rows → iteration', async () => {
    const mockDb = createMockDbWithData([
      { ID: 1, NAME: 'Alice' },
      { ID: 2, NAME: 'Bob' },
    ]);
    const conn = new Connection(mockDb);

    const rows = await conn.query('SELECT * FROM CUSTMAS');
    expect(rows.length).toBe(2);
    expect(rows[0].NAME).toBe('Alice');
    expect(rows[1].NAME).toBe('Bob');

    await conn.close();
  });

  test('insert → query → verify', async () => {
    const mockDb = createMockDbWithData([]);
    const conn = new Connection(mockDb);

    // Insert via prepared statement
    const stmt = await conn.prepare('INSERT INTO CUSTMAS VALUES(?, ?)');
    await stmt.execute([100, 'NewUser']);
    await stmt.close();

    expect(mockDb._test.data.length).toBe(1);
    expect(mockDb._test.data[0].ID).toBe(100);

    await conn.close();
  });

  test('batch insert flow', async () => {
    const mockDb = createMockDbWithData([]);
    const conn = new Connection(mockDb);

    const stmt = await conn.prepare('INSERT INTO CUSTMAS VALUES(?, ?)');
    const result = await stmt.executeBatch([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
    ]);

    expect(result.updateCounts).toEqual([1, 1, 1]);
    expect(result.totalAffected).toBe(3);
    expect(mockDb._test.data.length).toBe(3);
    await stmt.close();
    await conn.close();
  });
});

describe('Transaction flow', () => {
  test('begin → insert → commit', async () => {
    const mockDb = createMockDbWithData([]);
    const conn = new Connection(mockDb);

    await conn.begin();
    expect(conn.getAutoCommit()).toBe(false);

    await conn.execute('INSERT INTO T VALUES(?, ?)', [1, 'X']);
    await conn.commit();

    expect(mockDb._test.committed).toBe(true);
    await conn.close();
  });

  test('begin → insert → rollback', async () => {
    const mockDb = createMockDbWithData([]);
    const conn = new Connection(mockDb);

    await conn.begin();
    await conn.execute('INSERT INTO T VALUES(?, ?)', [1, 'X']);
    await conn.rollback();

    expect(mockDb._test.rolledBack).toBe(true);
    await conn.close();
  });

  test('savepoint flow', async () => {
    const mockDb = createMockDbWithData([]);
    const conn = new Connection(mockDb);

    await conn.begin();
    await conn.execute('INSERT INTO T VALUES(?, ?)', [1, 'X']);
    const sp = await conn.savepoint('after_insert');
    expect(sp.name).toBe('after_insert');

    await conn.execute('INSERT INTO T VALUES(?, ?)', [2, 'Y']);
    await conn.rollback(sp);
    await conn.commit();

    expect(mockDb._test.committed).toBe(true);
    await conn.close();
  });
});

describe('Streaming flow', () => {
  test('prepared statement stream()', async () => {
    const mockDb = createMockDbWithData([
      { ID: 1, NAME: 'Row1' },
      { ID: 2, NAME: 'Row2' },
      { ID: 3, NAME: 'Row3' },
    ]);
    const conn = new Connection(mockDb);

    const stmt = await conn.prepare('SELECT * FROM BIGTABLE');
    const collected = [];
    for await (const row of stmt.stream()) {
      collected.push(row);
    }

    expect(collected.length).toBe(3);
    expect(collected[0].NAME).toBe('Row1');
    expect(collected[2].NAME).toBe('Row3');

    await stmt.close();
    await conn.close();
  });
});

describe('Pool integration', () => {
  let pool;

  afterEach(async () => {
    if (pool && !pool.closed) await pool.close();
  });

  test('pool.query() end-to-end', async () => {
    let connCount = 0;
    pool = new ConnectionPool({
      connect: async () => {
        connCount++;
        const mockDb = createMockDbWithData([{ ID: 1, NAME: 'Pooled' }]);
        return new Connection(mockDb);
      },
      max: 5,
      idleTimeout: 0,
    });

    const rows = await pool.query('SELECT * FROM T');
    expect(rows.length).toBe(1);
    expect(rows[0].NAME).toBe('Pooled');
    expect(connCount).toBe(1);

    // Second query reuses the connection
    const rows2 = await pool.query('SELECT * FROM T');
    expect(rows2.length).toBe(1);
    expect(connCount).toBe(1);
  });

  test('pool handles multiple concurrent requests', async () => {
    let connCount = 0;
    pool = new ConnectionPool({
      connect: async () => {
        connCount++;
        const mockDb = createMockDbWithData([{ ID: connCount }]);
        return new Connection(mockDb);
      },
      max: 3,
      idleTimeout: 0,
    });

    const results = await Promise.all([
      pool.query('SELECT 1'),
      pool.query('SELECT 2'),
      pool.query('SELECT 3'),
    ]);

    expect(results.length).toBe(3);
    expect(connCount).toBe(3); // created 3 concurrent connections
  });
});

describe('LOB round-trip', () => {
  test('Blob write and read cycle', async () => {
    const original = Buffer.from('binary data payload');
    const blob = Blob.from(original);

    expect(blob.length).toBe(original.length);
    const readBack = await blob.toBuffer();
    expect(readBack.equals(original)).toBe(true);

    const partial = await blob.read(7, 4);
    expect(partial.toString()).toBe('data');
  });

  test('Clob write and read cycle', async () => {
    const original = 'This is a CLOB text value with special chars: ñ, ü, 日本語';
    const clob = Clob.from(original);

    expect(clob.length).toBe(original.length);
    const readBack = await clob.text();
    expect(readBack).toBe(original);

    const sub = await clob.substring(10, 4);
    expect(sub).toBe('CLOB');
  });

  test('SQLXML round-trip', async () => {
    const xml = '<root><item id="1">Test</item></root>';
    const sqlxml = SQLXML.from(xml);

    expect(await sqlxml.text()).toBe(xml);
    expect(await sqlxml.getString()).toBe(xml);
  });
});

describe('URL parse → property validate → normalize pipeline', () => {
  test('full JDBC URL pipeline', () => {
    const url = 'jdbc:as400://myhost/MYLIB;naming=sql;date format=iso;libraries=LIB1,LIB2;block size=64';
    const parsed = parseJdbcUrl(url);

    expect(parsed.host).toBe('myhost');
    expect(parsed.defaultSchema).toBe('MYLIB');
    expect(parsed.naming).toBe('sql');
    expect(parsed.dateFormat).toBe('*ISO');
    expect(parsed.libraries).toEqual(['LIB1', 'LIB2']);
    expect(parsed.blockSize).toBe(64);

    // Validate
    const warnings = validateProperties(parsed);
    // host, protocol are known; no errors
    expect(warnings.length).toBe(0);

    // Normalize
    const normalized = normalizeProperties(parsed);
    expect(normalized.naming).toBe('sql');
    expect(normalized.dateFormat).toBe('*ISO');
    expect(normalized.autoCommit).toBe(true); // default
    expect(normalized.libraries).toEqual(['LIB1', 'LIB2']);
  });

  test('options object pipeline', () => {
    const opts = {
      host: 'myhost',
      user: 'MYUSER',
      password: 'secret',
      naming: 'system',
      libraries: ['MYLIB', 'QGPL'],
      dateFormat: '*MDY',
    };

    const warnings = validateProperties(opts);
    expect(warnings.length).toBe(0);

    const normalized = normalizeProperties(opts);
    expect(normalized.naming).toBe('system');
    expect(normalized.libraries).toEqual(['MYLIB', 'QGPL']);
    expect(normalized.dateFormat).toBe('*MDY');
  });
});

describe('Metadata API', () => {
  test('metadata().getTables() builds correct SQL', async () => {
    const executedQueries = [];
    const mockDb = createMockDbWithData([]);
    // Override prepareStatement to capture SQL
    mockDb.prepareStatement = async (sql) => {
      executedQueries.push(sql);
      return {
        rpbId: 1, sql,
        columnDescriptors: [{ index: 0, name: 'TABLE_NAME', label: 'TABLE_NAME', typeName: 'VARCHAR', sqlType: 448 }],
        paramDescriptors: [{ sqlType: 448 }],
        paramCount: 1, columnCount: 1, closed: false,
      };
    };

    const conn = new Connection(mockDb);
    const md = conn.metadata();

    await md.getTables({ schema: 'MYLIB', type: 'TABLE' });
    expect(executedQueries.length).toBeGreaterThan(0);

    const lastQuery = executedQueries[executedQueries.length - 1];
    expect(lastQuery).toContain('QSYS2.SYSTABLES');

    await conn.close();
  });

  test('metadata().getColumns() builds correct SQL', async () => {
    const executedQueries = [];
    const mockDb = createMockDbWithData([]);
    mockDb.prepareStatement = async (sql) => {
      executedQueries.push(sql);
      return {
        rpbId: 1, sql,
        columnDescriptors: [{ index: 0, name: 'COLUMN_NAME', label: 'COLUMN_NAME', typeName: 'VARCHAR', sqlType: 448 }],
        paramDescriptors: [{ sqlType: 448 }, { sqlType: 448 }],
        paramCount: 2, columnCount: 1, closed: false,
      };
    };

    const conn = new Connection(mockDb);
    const md = conn.metadata();

    await md.getColumns({ schema: 'MYLIB', table: 'CUSTOMER' });
    const lastQuery = executedQueries[executedQueries.length - 1];
    expect(lastQuery).toContain('QSYS2.SYSCOLUMNS');

    await conn.close();
  });
});
