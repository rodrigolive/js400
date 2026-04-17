/**
 * Tests for barrel exports from db/index.js — verifies all Phase 12 classes are exported.
 */
import { describe, test, expect } from 'bun:test';
import * as db from '../../src/db/index.js';

describe('Phase 12 barrel exports', () => {
  test('exports connect factory', () => {
    expect(typeof db.connect).toBe('function');
    expect(typeof db.createPool).toBe('function');
    expect(typeof db.parseJdbcUrl).toBe('function');
  });

  test('exports Connection class', () => {
    expect(typeof db.Connection).toBe('function');
  });

  test('exports Statement class', () => {
    expect(typeof db.Statement).toBe('function');
  });

  test('exports PreparedStatement class', () => {
    expect(typeof db.PreparedStatement).toBe('function');
  });

  test('exports CallableStatement class', () => {
    expect(typeof db.CallableStatement).toBe('function');
  });

  test('exports ResultSet class', () => {
    expect(typeof db.ResultSet).toBe('function');
  });

  test('exports DatabaseMetaData class', () => {
    expect(typeof db.DatabaseMetaData).toBe('function');
  });

  test('exports SqlArray class', () => {
    expect(typeof db.SqlArray).toBe('function');
  });

  test('exports RowId class', () => {
    expect(typeof db.RowId).toBe('function');
  });

  test('exports Blob class', () => {
    expect(typeof db.Blob).toBe('function');
  });

  test('exports Clob class', () => {
    expect(typeof db.Clob).toBe('function');
  });

  test('exports SQLXML class', () => {
    expect(typeof db.SQLXML).toBe('function');
  });

  test('exports ConnectionPool class', () => {
    expect(typeof db.ConnectionPool).toBe('function');
  });

  test('exports property validation functions', () => {
    expect(typeof db.validateProperties).toBe('function');
    expect(typeof db.normalizeProperties).toBe('function');
  });

  test('preserves Phase 11 engine exports', () => {
    expect(typeof db.DbConnection).toBe('function');
    expect(typeof db.StatementManager).toBe('function');
    expect(typeof db.CursorManager).toBe('function');
    expect(typeof db.TransactionManager).toBe('function');
    expect(typeof db.Savepoint).toBe('function');
    expect(typeof db.LibraryList).toBe('function');
    expect(typeof db.SortSequence).toBe('function');
    expect(typeof db.PackageManager).toBe('function');
  });

  test('preserves Phase 11 protocol exports', () => {
    expect(typeof db.DBRequestDS).toBe('function');
    expect(typeof db.parseReply).toBe('function');
    expect(typeof db.parseExchangeAttributes).toBe('function');
    expect(typeof db.parseOperationReply).toBe('function');
    expect(typeof db.parseFetchReply).toBe('function');
    expect(typeof db.parseSQLCA).toBe('function');
    expect(typeof db.throwIfError).toBe('function');
    expect(typeof db.getCodePointData).toBe('function');
    expect(typeof db.decodeTextCodePoint).toBe('function');
  });

  test('preserves Phase 11 descriptor exports', () => {
    expect(typeof db.SqlType).toBe('object');
    expect(typeof db.parseColumnDescriptors).toBe('function');
    expect(typeof db.parseExtendedColumnDescriptors).toBe('function');
    expect(typeof db.sqlTypeToName).toBe('function');
    expect(typeof db.calculateRowLength).toBe('function');
    expect(typeof db.getColumnByteLength).toBe('function');
  });

  test('preserves Phase 11 LOB protocol exports', () => {
    expect(typeof db.parseLobLocator).toBe('function');
    expect(typeof db.parseLobDataReply).toBe('function');
    expect(typeof db.readEntireLob).toBe('function');
    expect(typeof db.freeLobLocator).toBe('function');
    expect(typeof db.LobHandle).toBe('function');
  });

  test('preserves Phase 11 type system exports', () => {
    expect(typeof db.getTypeHandler).toBe('function');
    expect(typeof db.decodeValue).toBe('function');
    expect(typeof db.encodeValue).toBe('function');
    expect(typeof db.decodeRow).toBe('function');
    expect(typeof db.decodeRows).toBe('function');
  });

  test('preserves Phase 11 property exports', () => {
    expect(typeof db.Naming).toBe('object');
    expect(typeof db.DateFormat).toBe('object');
    expect(typeof db.TimeFormat).toBe('object');
    expect(typeof db.IsolationLevel).toBe('object');
    expect(typeof db.CommitMode).toBe('object');
    expect(typeof db.defaultProperties).toBe('object');
  });
});

describe('main index.js sql namespace', () => {
  test('sql namespace is accessible from main entry', async () => {
    const main = await import('../../src/index.js');
    expect(main.sql).toBeDefined();
    expect(typeof main.sql.connect).toBe('function');
    expect(typeof main.sql.createPool).toBe('function');
    expect(typeof main.sql.parseJdbcUrl).toBe('function');
    expect(typeof main.sql.Connection).toBe('function');
    expect(typeof main.sql.PreparedStatement).toBe('function');
    expect(typeof main.sql.ResultSet).toBe('function');
    expect(typeof main.sql.Blob).toBe('function');
    expect(typeof main.sql.Clob).toBe('function');
    expect(typeof main.sql.ConnectionPool).toBe('function');
  });
});
