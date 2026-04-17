/**
 * Tests for Statement and PreparedStatement APIs.
 */
import { describe, test, expect } from 'bun:test';
import { Statement } from '../../src/db/api/Statement.js';
import { PreparedStatement } from '../../src/db/api/PreparedStatement.js';

/**
 * Create a mock DbConnection that simulates the engine layer.
 */
function createMockDbConnection(opts = {}) {
  const stmtHandle = {
    rpbId: 1,
    sql: opts.sql || 'SELECT 1',
    columnDescriptors: opts.columnDescriptors || [
      { index: 0, name: 'COL1', label: 'COL1', typeName: 'INTEGER', sqlType: 496 },
    ],
    paramDescriptors: opts.paramDescriptors || [],
    paramCount: (opts.paramDescriptors || []).length,
    columnCount: (opts.columnDescriptors || [{ index: 0 }]).length,
    closed: false,
  };

  const mockStatementManager = {
    execute: async (handle, params = [], execOpts = {}) => {
      if (opts.executeResult) return opts.executeResult;
      return {
        hasResultSet: opts.hasResultSet ?? true,
        rows: opts.rows || [{ COL1: 42 }],
        affectedRows: opts.affectedRows ?? 0,
        sqlca: { sqlCode: 0, rowCount: opts.affectedRows ?? 0 },
        rpbId: handle.rpbId,
        endOfData: true,
        columnDescriptors: handle.columnDescriptors,
      };
    },
    closeStatement: async (handle) => {
      handle.closed = true;
    },
  };

  const mockCursorManager = {
    async fetch() { return []; },
    async closeCursor() {},
  };

  return {
    prepareStatement: async (sql) => ({ ...stmtHandle, sql }),
    executeImmediate: async (sql) => ({
      sqlca: { sqlCode: 0, rowCount: opts.affectedRows ?? 1 },
      affectedRows: opts.affectedRows ?? 1,
    }),
    statementManager: mockStatementManager,
    cursorManager: mockCursorManager,
  };
}

describe('Statement', () => {
  test('query() returns rows', async () => {
    const mockDb = createMockDbConnection({
      rows: [{ ID: 1 }, { ID: 2 }],
    });

    const stmt = new Statement(mockDb);
    const rows = await stmt.query('SELECT ID FROM T');
    expect(rows).toEqual([{ ID: 1 }, { ID: 2 }]);
  });

  test('query() returns empty array for non-SELECT', async () => {
    const mockDb = createMockDbConnection({
      hasResultSet: false,
      rows: [],
      affectedRows: 5,
    });

    const stmt = new Statement(mockDb);
    const rows = await stmt.query('DELETE FROM T');
    expect(rows).toEqual([]);
  });

  test('execute() returns affectedRows', async () => {
    const mockDb = createMockDbConnection({ affectedRows: 3 });
    const stmt = new Statement(mockDb);
    const result = await stmt.execute('UPDATE T SET X = 1');
    expect(result.affectedRows).toBe(3);
  });

  test('closed statement throws', async () => {
    const mockDb = createMockDbConnection();
    const stmt = new Statement(mockDb);
    await stmt.close();
    expect(stmt.closed).toBe(true);
    await expect(() => stmt.query('SELECT 1')).toThrow('Statement is closed');
  });
});

describe('PreparedStatement', () => {
  test('execute() with SELECT returns rows', async () => {
    const mockDb = createMockDbConnection({
      rows: [{ NAME: 'Alice' }, { NAME: 'Bob' }],
    });

    const handle = await mockDb.prepareStatement('SELECT NAME FROM T WHERE ID = ?');
    const pstmt = new PreparedStatement(mockDb, handle, 'SELECT NAME FROM T WHERE ID = ?');

    const result = await pstmt.execute([1]);
    expect(result).toEqual([{ NAME: 'Alice' }, { NAME: 'Bob' }]);
  });

  test('execute() with DML returns affectedRows', async () => {
    const mockDb = createMockDbConnection({
      hasResultSet: false,
      rows: [],
      affectedRows: 2,
    });

    const handle = await mockDb.prepareStatement('UPDATE T SET X = ?');
    const pstmt = new PreparedStatement(mockDb, handle, 'UPDATE T SET X = ?');

    const result = await pstmt.execute([42]);
    expect(result.affectedRows).toBe(2);
  });

  test('executeBatch() packs rows into one call', async () => {
    // Per JTOpen, the host server collapses N rows into a single
    // EXECUTE round trip. We expect statementManager.executeBatch to
    // be called exactly once for N param sets.
    let batchCalls = 0;
    let receivedSets = null;
    const mockDb = createMockDbConnection();
    mockDb.statementManager.executeBatch = async (handle, paramSets) => {
      batchCalls++;
      receivedSets = paramSets;
      return {
        affectedRows: paramSets.length,
        sqlca: { sqlCode: 0, rowCount: paramSets.length },
        batchSize: paramSets.length,
        isInsert: true,
      };
    };

    const handle = await mockDb.prepareStatement('INSERT INTO T VALUES(?)');
    const pstmt = new PreparedStatement(mockDb, handle, 'INSERT INTO T VALUES(?)');

    const result = await pstmt.executeBatch([[1], [2], [3]]);
    expect(batchCalls).toBe(1);
    expect(receivedSets).toEqual([[1], [2], [3]]);
    // INSERT + totalAffected == batchSize => per-row count is 1
    expect(result.updateCounts).toEqual([1, 1, 1]);
    expect(result.totalAffected).toBe(3);
  });

  test('executeBatch() reports SUCCESS_NO_INFO when host total != batch size', async () => {
    const mockDb = createMockDbConnection();
    mockDb.statementManager.executeBatch = async (handle, paramSets) => ({
      affectedRows: 0,
      sqlca: { sqlCode: 0, rowCount: 0 },
      batchSize: paramSets.length,
      isInsert: true,
    });

    const handle = await mockDb.prepareStatement('INSERT INTO T VALUES(?)');
    const pstmt = new PreparedStatement(mockDb, handle, 'INSERT INTO T VALUES(?)');

    const result = await pstmt.executeBatch([[1], [2]]);
    expect(result.updateCounts).toEqual([-2, -2]);
    expect(result.totalAffected).toBe(0);
  });

  test('executeBatch() returns empty for zero-length batch', async () => {
    let batchCalls = 0;
    const mockDb = createMockDbConnection();
    mockDb.statementManager.executeBatch = async () => {
      batchCalls++;
      return { affectedRows: 0, sqlca: null, batchSize: 0, isInsert: false };
    };

    const handle = await mockDb.prepareStatement('INSERT INTO T VALUES(?)');
    const pstmt = new PreparedStatement(mockDb, handle, 'INSERT INTO T VALUES(?)');

    const result = await pstmt.executeBatch([]);
    expect(batchCalls).toBe(0);
    expect(result.updateCounts).toEqual([]);
    expect(result.totalAffected).toBe(0);
  });

  test('stream() returns async iterable', async () => {
    const mockDb = createMockDbConnection({
      rows: [{ ID: 1 }, { ID: 2 }],
    });

    const handle = await mockDb.prepareStatement('SELECT ID FROM T');
    const pstmt = new PreparedStatement(mockDb, handle, 'SELECT ID FROM T');

    const collected = [];
    for await (const row of pstmt.stream()) {
      collected.push(row);
    }
    expect(collected).toEqual([{ ID: 1 }, { ID: 2 }]);
  });

  test('sql getter returns SQL text', () => {
    const handle = {
      rpbId: 1, sql: 'SELECT 1', columnDescriptors: [], paramDescriptors: [],
      paramCount: 0, columnCount: 0, closed: false,
    };
    const pstmt = new PreparedStatement({}, handle, 'SELECT 1');
    expect(pstmt.sql).toBe('SELECT 1');
  });

  test('parameterCount and columnCount', () => {
    const handle = {
      rpbId: 1, sql: 'SELECT 1', paramDescriptors: [{ sqlType: 496 }],
      columnDescriptors: [{ index: 0 }, { index: 1 }],
      paramCount: 1, columnCount: 2, closed: false,
    };
    const pstmt = new PreparedStatement({}, handle, 'SELECT 1');
    expect(pstmt.parameterCount).toBe(1);
    expect(pstmt.columnCount).toBe(2);
  });

  test('close() marks statement as closed', async () => {
    const mockDb = createMockDbConnection();
    const handle = await mockDb.prepareStatement('SELECT 1');
    const pstmt = new PreparedStatement(mockDb, handle, 'SELECT 1');

    await pstmt.close();
    expect(pstmt.closed).toBe(true);
    await expect(() => pstmt.execute()).toThrow('PreparedStatement is closed');
  });

  test('close() is idempotent', async () => {
    let closeCount = 0;
    const mockDb = createMockDbConnection();
    const origClose = mockDb.statementManager.closeStatement;
    mockDb.statementManager.closeStatement = async (h) => {
      closeCount++;
      return origClose(h);
    };

    const handle = await mockDb.prepareStatement('SELECT 1');
    const pstmt = new PreparedStatement(mockDb, handle, 'SELECT 1');

    await pstmt.close();
    await pstmt.close();
    expect(closeCount).toBe(1);
  });
});
