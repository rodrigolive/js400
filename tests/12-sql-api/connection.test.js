/**
 * Tests for the Connection API wrapper.
 */
import { describe, test, expect } from 'bun:test';
import { Connection } from '../../src/db/api/Connection.js';
import { connect } from '../../src/db/connect.js';
import { AS400 } from '../../src/core/AS400.js';
import { DbConnection } from '../../src/db/engine/DbConnection.js';

/**
 * Create a mock DbConnection.
 */
function createMockDbConnection(opts = {}) {
  let autoCommit = true;
  const savedSavepoints = [];
  const rolledBackSavepoints = [];
  const executedSqls = [];
  let commitCount = 0;
  let rollbackCount = 0;

  const stmtHandle = {
    rpbId: 1,
    sql: '',
    columnDescriptors: opts.columnDescriptors || [
      { index: 0, name: 'ID', label: 'ID', typeName: 'INTEGER', sqlType: 496, precision: 10, scale: 0, nullable: false },
    ],
    paramDescriptors: opts.paramDescriptors || [],
    paramCount: (opts.paramDescriptors || []).length,
    columnCount: 1,
    closed: false,
  };

  const mockStatementManager = {
    execute: async (handle, params = []) => ({
      hasResultSet: opts.hasResultSet ?? true,
      rows: opts.rows || [{ ID: 1 }, { ID: 2 }],
      affectedRows: opts.affectedRows ?? 0,
      sqlca: { sqlCode: 0, rowCount: 0 },
      rpbId: handle.rpbId,
      endOfData: true,
      columnDescriptors: handle.columnDescriptors,
    }),
    closeStatement: async (handle) => { handle.closed = true; },
  };

  const mockCursorManager = {
    async fetch() { return []; },
    async closeCursor() {},
  };

  return {
    connected: true,
    prepareStatement: async (sql) => {
      executedSqls.push(sql);
      return { ...stmtHandle, sql };
    },
    executeImmediate: async (sql) => {
      executedSqls.push(sql);
      return {
        sqlca: { sqlCode: 0, rowCount: opts.affectedRows ?? 1 },
        affectedRows: opts.affectedRows ?? 1,
      };
    },
    statementManager: mockStatementManager,
    cursorManager: mockCursorManager,
    setAutoCommit(val) { autoCommit = val; },
    getAutoCommit() { return autoCommit; },
    async commit() { commitCount++; },
    async rollback() { rollbackCount++; },
    async setSavepoint(name) {
      const sp = { id: savedSavepoints.length + 1, name: name || `SP_${savedSavepoints.length + 1}` };
      savedSavepoints.push(sp);
      return sp;
    },
    async rollbackToSavepoint(sp) {
      rolledBackSavepoints.push(sp);
    },
    async close() {},
    // Expose internals for testing
    _test: { get commitCount() { return commitCount; }, get rollbackCount() { return rollbackCount; }, executedSqls, savedSavepoints, rolledBackSavepoints },
  };
}

describe('Connection', () => {
  test('query() returns array of rows', async () => {
    const mockDb = createMockDbConnection({ rows: [{ ID: 1 }, { ID: 2 }] });
    const conn = new Connection(mockDb);
    const rows = await conn.query('SELECT ID FROM T');
    expect(rows).toEqual([{ ID: 1 }, { ID: 2 }]);
  });

  test('query() with params uses prepared statement', async () => {
    const mockDb = createMockDbConnection({ rows: [{ ID: 42 }] });
    const conn = new Connection(mockDb);
    const rows = await conn.query('SELECT ID FROM T WHERE ID = ?', [42]);
    expect(rows).toEqual([{ ID: 42 }]);
  });

  test('execute() returns affectedRows', async () => {
    const mockDb = createMockDbConnection({ affectedRows: 5 });
    const conn = new Connection(mockDb);
    const result = await conn.execute('UPDATE T SET X = 1');
    expect(result.affectedRows).toBe(5);
  });

  test('execute() with params uses prepared statement', async () => {
    const mockDb = createMockDbConnection({
      hasResultSet: false,
      rows: [],
      affectedRows: 1,
    });
    const conn = new Connection(mockDb);
    const result = await conn.execute('INSERT INTO T VALUES(?)', [42]);
    expect(result.affectedRows).toBeDefined();
  });

  test('prepare() returns PreparedStatement', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    const stmt = await conn.prepare('SELECT 1');
    expect(stmt.sql).toBe('SELECT 1');
    expect(stmt.closed).toBe(false);
    await stmt.close();
  });

  test('begin() disables auto-commit', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);

    expect(conn.getAutoCommit()).toBe(true);
    await conn.begin();
    expect(conn.getAutoCommit()).toBe(false);
  });

  test('commit() delegates to DbConnection', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    await conn.commit();
    expect(mockDb._test.commitCount).toBe(1);
  });

  test('rollback() without savepoint', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    await conn.rollback();
    expect(mockDb._test.rollbackCount).toBe(1);
  });

  test('rollback(savepoint) rolls back to savepoint', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    const sp = await conn.savepoint('test_sp');
    await conn.rollback(sp);
    expect(mockDb._test.rolledBackSavepoints[0]).toBe(sp);
  });

  test('savepoint() creates named savepoint', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    const sp = await conn.savepoint('my_sp');
    expect(sp.name).toBe('my_sp');
  });

  test('metadata() returns DatabaseMetaData instance', () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    const md = conn.metadata();
    expect(md).toBeDefined();
    expect(typeof md.getTables).toBe('function');
    expect(typeof md.getColumns).toBe('function');
    expect(typeof md.getSchemas).toBe('function');
  });

  test('close() marks connection as closed', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    expect(conn.closed).toBe(false);
    await conn.close();
    expect(conn.closed).toBe(true);
  });

  test('close() is idempotent', async () => {
    let closeCount = 0;
    const mockDb = createMockDbConnection();
    const origClose = mockDb.close;
    mockDb.close = async () => { closeCount++; return origClose(); };

    const conn = new Connection(mockDb);
    await conn.close();
    await conn.close();
    expect(closeCount).toBe(1);
  });

  test('methods throw after close', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    await conn.close();

    await expect(() => conn.query('SELECT 1')).toThrow('Connection is closed');
    await expect(() => conn.execute('DELETE FROM T')).toThrow('Connection is closed');
    await expect(() => conn.prepare('SELECT 1')).toThrow('Connection is closed');
    await expect(() => conn.metadata()).toThrow('Connection is closed');
  });

  test('connected getter reflects state', async () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);
    expect(conn.connected).toBe(true);
    await conn.close();
    expect(conn.connected).toBe(false);
  });

  test('setAutoCommit/getAutoCommit', () => {
    const mockDb = createMockDbConnection();
    const conn = new Connection(mockDb);

    conn.setAutoCommit(false);
    expect(conn.getAutoCommit()).toBe(false);
    conn.setAutoCommit(true);
    expect(conn.getAutoCommit()).toBe(true);
  });
});

describe('sql.connect()', () => {
  test('host/user/password path signs on the AS400 instance before building DbConnection', async () => {
    let signonCalls = 0;
    let dbConnectCalls = 0;

    const origSignon = AS400.prototype.signon;
    const origDbConnect = DbConnection.prototype.connect;

    AS400.prototype.signon = async function signonStub() {
      signonCalls++;
    };
    DbConnection.prototype.connect = async function dbConnectStub() {
      dbConnectCalls++;
    };

    try {
      const conn = await connect({
        host: 'example.test',
        user: 'USER',
        password: 'PASS',
      });

      expect(signonCalls).toBe(1);
      expect(dbConnectCalls).toBe(1);
      expect(conn).toBeInstanceOf(Connection);
    } finally {
      AS400.prototype.signon = origSignon;
      DbConnection.prototype.connect = origDbConnect;
    }
  });
});
