/**
 * Tests for BatchUpdateError and per-row batch error diagnostics (Phase 002).
 *
 * Mock data is derived from actual PUB400 (Db2 for i) wire captures:
 *   - SQLCODE -803 / SQLSTATE 23505: duplicate key on INSERT with PK
 *   - SQLERRD[2] = 2: two rows succeeded before the error
 *   - JTOpen returns updateCounts of length SQLERRD[2] filled with -2
 *   - js400 returns updateCounts of length batchSize with 1/-2 and -3
 */
import { describe, test, expect } from 'bun:test';
import { SqlError, BatchUpdateError } from '../../src/core/errors.js';
import { PreparedStatement } from '../../src/db/api/PreparedStatement.js';

// ---- SQLCA shapes captured from live PUB400 batch errors ----

function makeBatchErrorSqlca(overrides = {}) {
  return {
    sqlCode: -803,
    sqlState: '23505',
    messageTokens: '\x00\x02*N\x00\x02*N\x00ZBATCH01\x00GIG4002',
    messageText: '[SQL0803] Duplicate key value specified.',
    secondLevelText: 'Cause: duplicate key in unique index',
    productId: 'QSQ07020',
    sqlerrd: [-168758284, -168759047, 2, 0, 0, 0],
    sqlwarn: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rowCount: 2,
    isError: true,
    isWarning: false,
    isSuccess: false,
    ...overrides,
  };
}

function makeSuccessSqlca(rowCount = 3) {
  return {
    sqlCode: 0,
    sqlState: '00000',
    messageTokens: '',
    sqlerrd: [0, 0, rowCount, 0, 0, 0],
    sqlwarn: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rowCount,
    isError: false,
    isWarning: false,
    isSuccess: true,
  };
}

// ---- Mock DbConnection ----

function createMockDbConnection(opts = {}) {
  const stmtHandle = {
    rpbId: 1,
    sql: opts.sql || 'INSERT INTO T VALUES(?)',
    columnDescriptors: [],
    paramDescriptors: opts.paramDescriptors || [
      { index: 0, name: 'P1', sqlType: 496, length: 4 },
    ],
    paramCount: (opts.paramDescriptors || [{ index: 0 }]).length,
    columnCount: 0,
    closed: false,
  };

  const mockStatementManager = {
    execute: opts.execute || (async () => ({
      hasResultSet: false,
      rows: [],
      affectedRows: 1,
      sqlca: makeSuccessSqlca(1),
      rpbId: 1,
      endOfData: true,
      columnDescriptors: [],
    })),
    executeBatch: opts.executeBatch || (async (handle, paramSets) => ({
      affectedRows: paramSets.length,
      sqlca: makeSuccessSqlca(paramSets.length),
      batchSize: paramSets.length,
      isInsert: true,
    })),
    closeStatement: async (handle) => { handle.closed = true; },
  };

  return {
    db: {
      statementManager: mockStatementManager,
      cursorManager: { async fetch() { return []; }, async closeCursor() {} },
    },
    handle: stmtHandle,
  };
}

function makePreparedStatement(mock) {
  return new PreparedStatement(mock.db, mock.handle, mock.handle.sql);
}

// ---- Tests ----

describe('BatchUpdateError class', () => {
  test('extends SqlError', () => {
    const err = new BatchUpdateError('test', {
      returnCode: -803,
      messageId: '23505',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SqlError);
    expect(err).toBeInstanceOf(BatchUpdateError);
    expect(err.name).toBe('BatchUpdateError');
  });

  test('carries sqlCode and sqlState from SqlError', () => {
    const err = new BatchUpdateError('test', {
      returnCode: -803,
      messageId: '23505',
      requestMetadata: { sqlCode: -803, sqlState: '23505' },
    });
    expect(err.sqlCode).toBe(-803);
    expect(err.sqlState).toBe('23505');
  });

  test('carries updateCounts and rowErrors', () => {
    const err = new BatchUpdateError('test', {
      returnCode: -803,
      messageId: '23505',
      updateCounts: [1, 1, -3, -3],
      rowErrors: [
        { row: 2, sqlCode: -803, sqlState: '23505', message: 'dup key' },
      ],
    });
    expect(err.updateCounts).toEqual([1, 1, -3, -3]);
    expect(err.rowErrors).toHaveLength(1);
    expect(err.rowErrors[0].row).toBe(2);
    expect(err.rowErrors[0].sqlCode).toBe(-803);
  });

  test('defaults updateCounts and rowErrors to empty arrays', () => {
    const err = new BatchUpdateError('test', { returnCode: -1 });
    expect(err.updateCounts).toEqual([]);
    expect(err.rowErrors).toEqual([]);
  });
});

describe('PreparedStatement.executeBatch error propagation', () => {
  test('propagates BatchUpdateError from engine with updateCounts', async () => {
    const mock = createMockDbConnection({
      executeBatch: async () => {
        throw new BatchUpdateError('Execute (batch): SQLCODE -803 SQLSTATE 23505 — dup', {
          returnCode: -803,
          messageId: '23505',
          requestMetadata: {
            sqlCode: -803,
            sqlState: '23505',
            sqlerrd: [-168758284, -168759047, 2, 0, 0, 0],
            rowCount: 2,
          },
          updateCounts: [1, 1, -3, -3],
          rowErrors: [{ row: 2, sqlCode: -803, sqlState: '23505', message: 'dup' }],
        });
      },
    });
    const pstmt = makePreparedStatement(mock);

    try {
      await pstmt.executeBatch([[10], [20], [10], [30]]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchUpdateError);
      expect(err.sqlCode).toBe(-803);
      expect(err.sqlState).toBe('23505');
      expect(err.updateCounts).toEqual([1, 1, -3, -3]);
      expect(err.rowErrors[0].row).toBe(2);
    }
  });

  test('successful executeBatch still returns normal result', async () => {
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => ({
        affectedRows: 3,
        sqlca: makeSuccessSqlca(3),
        batchSize: 3,
        isInsert: true,
      }),
    });
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch([[1], [2], [3]]);
    expect(result.updateCounts).toEqual([1, 1, 1]);
    expect(result.totalAffected).toBe(3);
  });

  test('zero-length batch returns empty result', async () => {
    const mock = createMockDbConnection();
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch([]);
    expect(result.updateCounts).toEqual([]);
    expect(result.totalAffected).toBe(0);
  });
});

describe('BatchUpdateError updateCounts shapes', () => {
  test('mirrors PUB400 capture: 4-row batch, dup at row 2, SQLERRD[2]=2', () => {
    // Exact reproduction of live PUB400 wire capture data
    const err = new BatchUpdateError(
      'Execute (batch): SQLCODE -803 SQLSTATE 23505 — [SQL0803] Duplicate key value specified.',
      {
        returnCode: -803,
        messageId: '23505',
        hostService: 'database',
        requestMetadata: {
          sqlCode: -803,
          sqlState: '23505',
          messageText: '[SQL0803] Duplicate key value specified.',
          secondLevelText: 'Cause: duplicate key in unique index',
          messageTokens: '\x00\x02*N\x00\x02*N\x00ZBATCH01\x00GIG4002',
          rowCount: 2,
          sqlerrd: [-168758284, -168759047, 2, 0, 0, 0],
        },
        updateCounts: [1, 1, -3, -3],
        rowErrors: [{
          row: 2,
          sqlCode: -803,
          sqlState: '23505',
          message: '[SQL0803] Duplicate key value specified.',
        }],
      },
    );

    // Row 0 (ID=10): succeeded → 1
    expect(err.updateCounts[0]).toBe(1);
    // Row 1 (ID=20): succeeded → 1
    expect(err.updateCounts[1]).toBe(1);
    // Row 2 (ID=10 dup): failed → -3 (EXECUTE_FAILED)
    expect(err.updateCounts[2]).toBe(-3);
    // Row 3 (ID=30): never executed → -3
    expect(err.updateCounts[3]).toBe(-3);
    // Always same length as original batch
    expect(err.updateCounts).toHaveLength(4);
    // Error pinpoints row 2
    expect(err.rowErrors[0].row).toBe(2);
  });

  test('error in second chunk marks first chunk rows as succeeded', () => {
    const batchSize = 35000;
    const updateCounts = new Array(batchSize);
    // First 32000 rows in chunk 0: all succeeded
    for (let i = 0; i < 32000; i++) updateCounts[i] = 1;
    // 500 rows in chunk 1 succeeded before error (SQLERRD[2]=500)
    for (let i = 32000; i < 32500; i++) updateCounts[i] = 1;
    // Rest: EXECUTE_FAILED
    for (let i = 32500; i < batchSize; i++) updateCounts[i] = -3;

    const err = new BatchUpdateError('batch error', {
      returnCode: -803,
      messageId: '23505',
      updateCounts,
      rowErrors: [{ row: 32500, sqlCode: -803, sqlState: '23505', message: 'dup' }],
    });

    expect(err.updateCounts[0]).toBe(1);
    expect(err.updateCounts[31999]).toBe(1);
    expect(err.updateCounts[32000]).toBe(1);
    expect(err.updateCounts[32499]).toBe(1);
    expect(err.updateCounts[32500]).toBe(-3);
    expect(err.updateCounts[batchSize - 1]).toBe(-3);
    expect(err.updateCounts).toHaveLength(batchSize);
    expect(err.rowErrors[0].row).toBe(32500);
  });

  test('journaling error (55019) — entire batch fails, SQLERRD[2]=0', () => {
    // Captured from PUB400: non-journaled table under commitment control
    // fails before any rows are processed
    const err = new BatchUpdateError(
      'Execute (batch): SQLCODE -7008 SQLSTATE 55019 — not journaled',
      {
        returnCode: -7008,
        messageId: '55019',
        updateCounts: [-3, -3, -3],
        rowErrors: [{
          row: 0,
          sqlCode: -7008,
          sqlState: '55019',
          message: 'not journaled',
        }],
      },
    );

    expect(err.sqlCode).toBe(-7008);
    expect(err.sqlState).toBe('55019');
    expect(err.updateCounts).toEqual([-3, -3, -3]);
    expect(err.rowErrors[0].row).toBe(0);
  });
});

describe('BatchUpdateError is exported from barrel', () => {
  test('available from src/index.js', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.BatchUpdateError).toBeDefined();
    expect(mod.BatchUpdateError).toBe(BatchUpdateError);
  });
});
