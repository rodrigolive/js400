/**
 * Tests for connection properties, constants, and barrel exports.
 */
import { describe, test, expect } from 'bun:test';
import {
  Naming, DateFormat, TimeFormat, DateSeparator, TimeSeparator,
  DecimalSeparator, SortSequenceType, IsolationLevel, CommitMode,
  IsolationToCommitMode, defaultProperties,
} from '../../src/db/properties.js';
import * as dbExports from '../../src/db/index.js';

describe('Naming', () => {
  test('has SQL and SYSTEM', () => {
    expect(Naming.SQL).toBe('sql');
    expect(Naming.SYSTEM).toBe('system');
  });

  test('is frozen', () => {
    expect(Object.isFrozen(Naming)).toBe(true);
  });
});

describe('DateFormat', () => {
  test('has all ISO/USA/EUR/JIS/MDY/DMY/YMD/JUL formats', () => {
    expect(DateFormat.ISO).toBe('*ISO');
    expect(DateFormat.USA).toBe('*USA');
    expect(DateFormat.EUR).toBe('*EUR');
    expect(DateFormat.JIS).toBe('*JIS');
    expect(DateFormat.MDY).toBe('*MDY');
    expect(DateFormat.DMY).toBe('*DMY');
    expect(DateFormat.YMD).toBe('*YMD');
    expect(DateFormat.JUL).toBe('*JUL');
  });
});

describe('TimeFormat', () => {
  test('has ISO/USA/EUR/JIS/HMS', () => {
    expect(TimeFormat.ISO).toBe('*ISO');
    expect(TimeFormat.HMS).toBe('*HMS');
  });
});

describe('IsolationLevel', () => {
  test('has all levels', () => {
    expect(IsolationLevel.NONE).toBe('none');
    expect(IsolationLevel.READ_UNCOMMITTED).toBe('read-uncommitted');
    expect(IsolationLevel.READ_COMMITTED).toBe('read-committed');
    expect(IsolationLevel.REPEATABLE_READ).toBe('repeatable-read');
    expect(IsolationLevel.SERIALIZABLE).toBe('serializable');
  });
});

describe('CommitMode', () => {
  test('has wire values', () => {
    expect(CommitMode.NONE).toBe(0xF0);
    expect(CommitMode.READ_UNCOMMITTED).toBe(0xF1);
    expect(CommitMode.READ_COMMITTED).toBe(0xF2);
    expect(CommitMode.REPEATABLE_READ).toBe(0xF3);
    expect(CommitMode.SERIALIZABLE).toBe(0xF4);
  });
});

describe('IsolationToCommitMode', () => {
  test('maps all isolation levels', () => {
    expect(IsolationToCommitMode['none']).toBe(CommitMode.NONE);
    expect(IsolationToCommitMode['read-uncommitted']).toBe(CommitMode.READ_UNCOMMITTED);
    expect(IsolationToCommitMode['read-committed']).toBe(CommitMode.READ_COMMITTED);
    expect(IsolationToCommitMode['repeatable-read']).toBe(CommitMode.REPEATABLE_READ);
    expect(IsolationToCommitMode['serializable']).toBe(CommitMode.SERIALIZABLE);
  });
});

describe('defaultProperties', () => {
  test('has expected defaults', () => {
    expect(defaultProperties.naming).toBe(Naming.SQL);
    expect(defaultProperties.autoCommit).toBe(true);
    expect(defaultProperties.dateFormat).toBe(DateFormat.ISO);
    expect(defaultProperties.timeFormat).toBe(TimeFormat.ISO);
    expect(Array.isArray(defaultProperties.libraries)).toBe(true);
    expect(defaultProperties.libraries.length).toBe(0);
    expect(defaultProperties.blockSize).toBe(32);
    expect(defaultProperties.prefetch).toBe(true);
  });

  test('is frozen', () => {
    expect(Object.isFrozen(defaultProperties)).toBe(true);
  });
});

describe('barrel exports (db/index.js)', () => {
  test('exports connect function', () => {
    expect(typeof dbExports.connect).toBe('function');
  });

  test('exports DbConnection class', () => {
    expect(typeof dbExports.DbConnection).toBe('function');
  });

  test('exports engine classes', () => {
    expect(typeof dbExports.StatementManager).toBe('function');
    expect(typeof dbExports.CursorManager).toBe('function');
    expect(typeof dbExports.TransactionManager).toBe('function');
    expect(typeof dbExports.Savepoint).toBe('function');
    expect(typeof dbExports.LibraryList).toBe('function');
    expect(typeof dbExports.SortSequence).toBe('function');
    expect(typeof dbExports.PackageManager).toBe('function');
  });

  test('exports protocol classes', () => {
    expect(typeof dbExports.DBRequestDS).toBe('function');
    expect(typeof dbExports.RequestID).toBe('object');
    expect(typeof dbExports.CodePoint).toBe('object');
    expect(typeof dbExports.DescribeOption).toBe('object');
    expect(typeof dbExports.FetchScroll).toBe('object');
  });

  test('exports reply parsers', () => {
    expect(typeof dbExports.parseReply).toBe('function');
    expect(typeof dbExports.parseExchangeAttributes).toBe('function');
    expect(typeof dbExports.parseOperationReply).toBe('function');
    expect(typeof dbExports.parseFetchReply).toBe('function');
    expect(typeof dbExports.parseSQLCA).toBe('function');
    expect(typeof dbExports.throwIfError).toBe('function');
    expect(typeof dbExports.getCodePointData).toBe('function');
    expect(typeof dbExports.decodeTextCodePoint).toBe('function');
  });

  test('exports descriptor functions', () => {
    expect(typeof dbExports.SqlType).toBe('object');
    expect(typeof dbExports.parseColumnDescriptors).toBe('function');
    expect(typeof dbExports.parseExtendedColumnDescriptors).toBe('function');
    expect(typeof dbExports.sqlTypeToName).toBe('function');
    expect(typeof dbExports.calculateRowLength).toBe('function');
    expect(typeof dbExports.getColumnByteLength).toBe('function');
  });

  test('exports LOB helpers', () => {
    expect(typeof dbExports.parseLobLocator).toBe('function');
    expect(typeof dbExports.parseLobDataReply).toBe('function');
    expect(typeof dbExports.readEntireLob).toBe('function');
    expect(typeof dbExports.freeLobLocator).toBe('function');
    expect(typeof dbExports.LobHandle).toBe('function');
  });

  test('exports type system', () => {
    expect(typeof dbExports.getTypeHandler).toBe('function');
    expect(typeof dbExports.decodeValue).toBe('function');
    expect(typeof dbExports.encodeValue).toBe('function');
    expect(typeof dbExports.decodeRow).toBe('function');
    expect(typeof dbExports.decodeRows).toBe('function');
  });

  test('exports properties', () => {
    expect(typeof dbExports.Naming).toBe('object');
    expect(typeof dbExports.DateFormat).toBe('object');
    expect(typeof dbExports.defaultProperties).toBe('object');
  });
});
