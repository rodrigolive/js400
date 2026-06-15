import { describe, test, expect } from 'bun:test';
import { throwIfError, SQLCODE_FALLBACK_MESSAGES } from '../../src/db/protocol/DBReplyDS.js';
import { SqlError } from '../../src/core/errors.js';

function makeSqlca(overrides = {}) {
  return {
    sqlCode: 0,
    sqlState: '00000',
    messageTokens: '',
    messageText: '',
    secondLevelText: '',
    isError: false,
    isWarning: false,
    isSuccess: true,
    sqlerrd: [0, 0, 0, 0, 0, 0],
    rowCount: 0,
    ...overrides,
  };
}

describe('SQLCODE fallback messages', () => {
  test('throwIfError produces non-empty message for known SQLCODE with no server text', () => {
    const sqlca = makeSqlca({
      sqlCode: -803,
      sqlState: '23505',
      isError: true,
      isSuccess: false,
    });
    try {
      throwIfError(sqlca, 'Execute (batch)');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SqlError);
      expect(err.message).toContain('Duplicate key value');
      expect(err.message).not.toMatch(/— $/);
      expect(err.sqlCode).toBe(-803);
      expect(err.sqlState).toBe('23505');
    }
  });

  test('server message text takes precedence over fallback map', () => {
    const sqlca = makeSqlca({
      sqlCode: -803,
      sqlState: '23505',
      messageTokens: 'MYLIB/MYTABLE',
      messageText: '[SQL0803] Duplicate key value specified for MYLIB/MYTABLE',
      isError: true,
      isSuccess: false,
    });
    try {
      throwIfError(sqlca, 'test');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).toContain('[SQL0803]');
      expect(err.message).toContain('MYLIB/MYTABLE');
    }
  });

  test('unknown SQLCODE with no text still throws correctly', () => {
    const sqlca = makeSqlca({
      sqlCode: -99999,
      sqlState: 'XXXXX',
      isError: true,
      isSuccess: false,
    });
    try {
      throwIfError(sqlca);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SqlError);
      expect(err.message).toContain('-99999');
      expect(err.message).toContain('XXXXX');
    }
  });

  test('fallback map has non-empty strings for all entries', () => {
    for (const [code, msg] of SQLCODE_FALLBACK_MESSAGES) {
      expect(typeof code).toBe('number');
      expect(code).toBeLessThan(0);
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test('SqlError exposes sqlCode and sqlState as top-level properties', () => {
    const err = new SqlError('test', {
      returnCode: -803,
      messageId: '23505',
      requestMetadata: { sqlCode: -803, sqlState: '23505' },
    });
    expect(err.sqlCode).toBe(-803);
    expect(err.sqlState).toBe('23505');
  });
});
