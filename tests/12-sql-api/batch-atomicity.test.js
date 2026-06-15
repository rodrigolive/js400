/**
 * Tests for configurable batch atomicity (Phase 003).
 *
 * Covers:
 *   - atomic=false (non-atomic, row-by-row execution)
 *   - chunkSize option (application-level chunking)
 *   - backward compatibility (no opts = default atomic)
 *   - edge cases (opts validation, non-SQL error propagation)
 */
import { describe, test, expect } from 'bun:test';
import { SqlError, BatchUpdateError } from '../../src/core/errors.js';
import { PreparedStatement } from '../../src/db/api/PreparedStatement.js';

// ---- SQLCA shapes ----

function makeSuccessSqlca(rowCount = 1) {
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

// ---- Mock helpers ----

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

// ---- Non-atomic mode tests ----

describe('executeBatch({ atomic: false })', () => {
  test('executes each row individually via execute()', async () => {
    let callCount = 0;
    const mock = createMockDbConnection({
      execute: async () => {
        callCount++;
        return {
          hasResultSet: false,
          rows: [],
          affectedRows: 1,
          sqlca: makeSuccessSqlca(1),
          rpbId: 1,
          endOfData: true,
          columnDescriptors: [],
        };
      },
    });
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch([[1], [2], [3]], { atomic: false });
    expect(callCount).toBe(3);
    expect(result.updateCounts).toEqual([1, 1, 1]);
    expect(result.totalAffected).toBe(3);
  });

  test('continues past SqlError and collects per-row results', async () => {
    const failRows = new Set([1, 3]);
    let callIdx = 0;
    const mock = createMockDbConnection();
    mock.db.statementManager.execute = async () => {
      const idx = callIdx++;
      if (failRows.has(idx)) {
        throw new SqlError('Duplicate key', {
          returnCode: -803,
          messageId: '23505',
        });
      }
      return {
        hasResultSet: false,
        rows: [],
        affectedRows: 1,
        sqlca: makeSuccessSqlca(1),
        rpbId: 1,
        endOfData: true,
        columnDescriptors: [],
      };
    };

    const pstmt = makePreparedStatement(mock);
    try {
      await pstmt.executeBatch([[10], [20], [30], [40], [50]], { atomic: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchUpdateError);
      expect(err.updateCounts).toEqual([1, -3, 1, -3, 1]);
      expect(err.updateCounts).toHaveLength(5);
      expect(err.rowErrors).toHaveLength(2);
      expect(err.rowErrors[0].row).toBe(1);
      expect(err.rowErrors[0].sqlCode).toBe(-803);
      expect(err.rowErrors[1].row).toBe(3);
    }
  });

  test('non-SqlError is thrown immediately, stops execution', async () => {
    let callIdx = 0;
    const mock = createMockDbConnection();
    mock.db.statementManager.execute = async () => {
      const idx = callIdx++;
      if (idx === 1) throw new TypeError('connection lost');
      return {
        hasResultSet: false, rows: [], affectedRows: 1,
        sqlca: makeSuccessSqlca(1), rpbId: 1, endOfData: true,
        columnDescriptors: [],
      };
    };

    const pstmt = makePreparedStatement(mock);
    try {
      await pstmt.executeBatch([[1], [2], [3]], { atomic: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect(err.message).toBe('connection lost');
      // Only 2 rows attempted (row 0 ok, row 1 threw, row 2 never reached)
      expect(callIdx).toBe(2);
    }
  });

  test('preserves zero affected count (not SUCCESS_NO_INFO)', async () => {
    const mock = createMockDbConnection({
      execute: async () => ({
        hasResultSet: false,
        rows: [],
        affectedRows: 0,
        sqlca: makeSuccessSqlca(0),
        rpbId: 1,
        endOfData: true,
        columnDescriptors: [],
      }),
    });
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch([[1], [2]], { atomic: false });
    expect(result.updateCounts).toEqual([0, 0]);
    expect(result.totalAffected).toBe(0);
  });

  test('all rows succeed returns normal result (no error thrown)', async () => {
    const mock = createMockDbConnection({
      execute: async () => ({
        hasResultSet: false,
        rows: [],
        affectedRows: 1,
        sqlca: makeSuccessSqlca(1),
        rpbId: 1,
        endOfData: true,
        columnDescriptors: [],
      }),
    });
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch([[1], [2]], { atomic: false });
    expect(result.updateCounts).toEqual([1, 1]);
    expect(result.totalAffected).toBe(2);
  });

  test('empty batch with atomic=false returns empty result', async () => {
    const mock = createMockDbConnection();
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch([], { atomic: false });
    expect(result.updateCounts).toEqual([]);
    expect(result.totalAffected).toBe(0);
  });

  test('error message references first failing row', async () => {
    let callIdx = 0;
    const mock = createMockDbConnection();
    mock.db.statementManager.execute = async () => {
      const idx = callIdx++;
      if (idx === 2) {
        throw new SqlError('FK violation', {
          returnCode: -530,
          messageId: '23503',
        });
      }
      return {
        hasResultSet: false, rows: [], affectedRows: 1,
        sqlca: makeSuccessSqlca(1), rpbId: 1, endOfData: true,
        columnDescriptors: [],
      };
    };

    const pstmt = makePreparedStatement(mock);
    try {
      await pstmt.executeBatch([[1], [2], [3], [4]], { atomic: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchUpdateError);
      expect(err.message).toContain('row 2');
      expect(err.message).toContain('SQLCODE -530');
      expect(err.message).toContain('1 of 4 rows failed');
      expect(err.sqlCode).toBe(-530);
      expect(err.sqlState).toBe('23503');
    }
  });
});

// ---- Chunked mode tests ----

describe('executeBatch({ chunkSize })', () => {
  test('splits batch into chunks of the specified size', async () => {
    const chunkSizes = [];
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => {
        chunkSizes.push(paramSets.length);
        return {
          affectedRows: paramSets.length,
          sqlca: makeSuccessSqlca(paramSets.length),
          batchSize: paramSets.length,
          isInsert: true,
        };
      },
    });
    const pstmt = makePreparedStatement(mock);
    const rows = Array.from({ length: 5000 }, (_, i) => [i]);
    const result = await pstmt.executeBatch(rows, { chunkSize: 1000 });
    expect(chunkSizes).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(result.updateCounts).toHaveLength(5000);
    expect(result.updateCounts.every(c => c === 1)).toBe(true);
    expect(result.totalAffected).toBe(5000);
  });

  test('last chunk can be smaller than chunkSize', async () => {
    const chunkSizes = [];
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => {
        chunkSizes.push(paramSets.length);
        return {
          affectedRows: paramSets.length,
          sqlca: makeSuccessSqlca(paramSets.length),
          batchSize: paramSets.length,
          isInsert: true,
        };
      },
    });
    const pstmt = makePreparedStatement(mock);
    const rows = Array.from({ length: 2500 }, (_, i) => [i]);
    const result = await pstmt.executeBatch(rows, { chunkSize: 1000 });
    expect(chunkSizes).toEqual([1000, 1000, 500]);
    expect(result.updateCounts).toHaveLength(2500);
    expect(result.totalAffected).toBe(2500);
  });

  test('error in middle chunk: rowErrors offset to batch-level index', async () => {
    let chunkIdx = 0;
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => {
        const idx = chunkIdx++;
        if (idx === 2) {
          throw new BatchUpdateError('Duplicate key', {
            returnCode: -803,
            messageId: '23505',
            updateCounts: [1, 1, -3],
            rowErrors: [{ row: 2, sqlCode: -803, sqlState: '23505', message: 'dup' }],
          });
        }
        return {
          affectedRows: paramSets.length,
          sqlca: makeSuccessSqlca(paramSets.length),
          batchSize: paramSets.length,
          isInsert: true,
        };
      },
    });

    const pstmt = makePreparedStatement(mock);
    const rows = Array.from({ length: 500 }, (_, i) => [i]);
    try {
      await pstmt.executeBatch(rows, { chunkSize: 100 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchUpdateError);
      expect(err.updateCounts).toHaveLength(500);
      // First 200 rows (chunks 0 and 1) succeeded
      for (let i = 0; i < 200; i++) {
        expect(err.updateCounts[i]).toBe(1);
      }
      // Chunk 2: first 2 rows succeeded, row 2 failed
      expect(err.updateCounts[200]).toBe(1);
      expect(err.updateCounts[201]).toBe(1);
      expect(err.updateCounts[202]).toBe(-3);
      // Remaining rows: failed
      for (let i = 203; i < 500; i++) {
        expect(err.updateCounts[i]).toBe(-3);
      }
      // rowErrors[0].row is batch-level, not chunk-local
      expect(err.rowErrors[0].row).toBe(202);
      expect(err.rowErrors[0].sqlCode).toBe(-803);
    }
  });

  test('batchSize <= chunkSize skips chunking (uses atomic path)', async () => {
    let batchCalled = false;
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => {
        batchCalled = true;
        return {
          affectedRows: paramSets.length,
          sqlca: makeSuccessSqlca(paramSets.length),
          batchSize: paramSets.length,
          isInsert: true,
        };
      },
    });
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch([[1], [2], [3]], { chunkSize: 1000 });
    expect(batchCalled).toBe(true);
    expect(result.updateCounts).toEqual([1, 1, 1]);
  });
});

// ---- Combined options ----

describe('executeBatch option precedence', () => {
  test('atomic=false takes priority over chunkSize', async () => {
    let executeCount = 0;
    let batchCount = 0;
    const mock = createMockDbConnection({
      execute: async () => {
        executeCount++;
        return {
          hasResultSet: false, rows: [], affectedRows: 1,
          sqlca: makeSuccessSqlca(1), rpbId: 1, endOfData: true,
          columnDescriptors: [],
        };
      },
      executeBatch: async (handle, paramSets) => {
        batchCount++;
        return {
          affectedRows: paramSets.length,
          sqlca: makeSuccessSqlca(paramSets.length),
          batchSize: paramSets.length,
          isInsert: true,
        };
      },
    });
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch(
      [[1], [2], [3]], { atomic: false, chunkSize: 2 },
    );
    // atomic=false wins: row-by-row via execute(), not executeBatch()
    expect(executeCount).toBe(3);
    expect(batchCount).toBe(0);
    expect(result.updateCounts).toEqual([1, 1, 1]);
  });
});

// ---- opts validation ----

describe('executeBatch opts validation', () => {
  test('opts=null does not throw', async () => {
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => ({
        affectedRows: 2,
        sqlca: makeSuccessSqlca(2),
        batchSize: 2,
        isInsert: true,
      }),
    });
    const pstmt = makePreparedStatement(mock);
    const result = await pstmt.executeBatch([[1], [2]], null);
    expect(result.updateCounts).toEqual([1, 1]);
  });

  test('fractional chunkSize is truncated to integer', async () => {
    const chunkSizes = [];
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => {
        chunkSizes.push(paramSets.length);
        return {
          affectedRows: paramSets.length,
          sqlca: makeSuccessSqlca(paramSets.length),
          batchSize: paramSets.length,
          isInsert: true,
        };
      },
    });
    const pstmt = makePreparedStatement(mock);
    const rows = Array.from({ length: 10 }, (_, i) => [i]);
    await pstmt.executeBatch(rows, { chunkSize: 3.7 });
    // 3.7 truncated to 3
    expect(chunkSizes).toEqual([3, 3, 3, 1]);
  });

  test('chunkSize=0 is ignored (uses atomic path)', async () => {
    let batchCalled = false;
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => {
        batchCalled = true;
        return {
          affectedRows: paramSets.length,
          sqlca: makeSuccessSqlca(paramSets.length),
          batchSize: paramSets.length,
          isInsert: true,
        };
      },
    });
    const pstmt = makePreparedStatement(mock);
    await pstmt.executeBatch([[1], [2]], { chunkSize: 0 });
    expect(batchCalled).toBe(true);
  });
});

// ---- Backward compatibility ----

describe('executeBatch backward compatibility', () => {
  test('no opts = default atomic behavior (unchanged)', async () => {
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

  test('executeBatchAccumulated still works without opts', async () => {
    const mock = createMockDbConnection({
      executeBatch: async (handle, paramSets) => ({
        affectedRows: paramSets.length,
        sqlca: makeSuccessSqlca(paramSets.length),
        batchSize: paramSets.length,
        isInsert: true,
      }),
    });
    const pstmt = makePreparedStatement(mock);
    pstmt.setObject(1, 10);
    pstmt.addBatch();
    pstmt.setObject(1, 20);
    pstmt.addBatch();
    const result = await pstmt.executeBatchAccumulated();
    expect(result.updateCounts).toEqual([1, 1]);
    expect(result.totalAffected).toBe(2);
  });
});
