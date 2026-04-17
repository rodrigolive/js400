/**
 * Tests for the engine layer: LibraryList, SortSequence, PackageManager,
 * TransactionManager, CursorManager, StatementManager, DbConnection.
 *
 * Uses mocked connections where real server communication is needed.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { LibraryList } from '../../src/db/engine/LibraryList.js';
import { SortSequence } from '../../src/db/engine/SortSequence.js';
import { PackageManager } from '../../src/db/engine/PackageManager.js';
import { TransactionManager, Savepoint } from '../../src/db/engine/TransactionManager.js';
import { CursorManager } from '../../src/db/engine/CursorManager.js';
import { StatementManager } from '../../src/db/engine/StatementManager.js';
import { DbConnection } from '../../src/db/engine/DbConnection.js';
import { DataStream } from '../../src/transport/DataStream.js';
import { CodePoint, StatementType } from '../../src/db/protocol/DBRequestDS.js';

function buildSuccessReply() {
  const buf = Buffer.alloc(40, 0);
  buf.writeInt32BE(40, 0);
  buf.writeUInt16BE(0xE004, 6);
  buf.writeInt16BE(20, 16);
  return buf;
}

function readShortCodePoint(buf, codePoint) {
  const header = DataStream.parseHeader(buf);
  let offset = DataStream.HEADER_LENGTH + header.templateLen;

  while (offset + 6 <= buf.length) {
    const ll = buf.readInt32BE(offset);
    if (ll < 6 || offset + ll > buf.length) break;
    const cp = buf.readUInt16BE(offset + 4);
    if (cp === codePoint && ll >= 8) {
      return buf.readInt16BE(offset + 6);
    }
    offset += ll;
  }

  return null;
}

function readRawCodePoint(buf, codePoint) {
  const header = DataStream.parseHeader(buf);
  let offset = DataStream.HEADER_LENGTH + header.templateLen;

  while (offset + 6 <= buf.length) {
    const ll = buf.readInt32BE(offset);
    if (ll < 6 || offset + ll > buf.length) break;
    const cp = buf.readUInt16BE(offset + 4);
    if (cp === codePoint) {
      return buf.subarray(offset + 6, offset + ll);
    }
    offset += ll;
  }

  return null;
}

describe('LibraryList', () => {
  test('initializes with libraries', () => {
    const ll = new LibraryList({ libraries: ['MYLIB', 'YOURLIB'] });
    expect(ll.hasLibrary('MYLIB')).toBe(true);
    expect(ll.hasLibrary('YOURLIB')).toBe(true);
  });

  test('addLibrary and removeLibrary', () => {
    const ll = new LibraryList({ libraries: [] });
    ll.addLibrary('TESTLIB');
    expect(ll.hasLibrary('TESTLIB')).toBe(true);
    ll.removeLibrary('TESTLIB');
    expect(ll.hasLibrary('TESTLIB')).toBe(false);
  });

  test('toSetPathSQL generates correct SQL', () => {
    const ll = new LibraryList({ libraries: ['LIB1', 'LIB2'] });
    const sql = ll.toSetPathSQL();
    expect(sql).toContain('SET PATH');
    expect(sql).toContain('"LIB1"');
    expect(sql).toContain('"LIB2"');
  });

  test('toSetPathSQL returns empty for no libraries', () => {
    const ll = new LibraryList({ libraries: [] });
    expect(ll.toSetPathSQL()).toBeFalsy();
  });

  test('toSetSchemaSQL with defaultSchema', () => {
    const ll = new LibraryList({ defaultSchema: 'MYSCHEMA' });
    const sql = ll.toSetSchemaSQL();
    expect(sql).toContain('SET SCHEMA');
    expect(sql).toContain('"MYSCHEMA"');
  });

  test('toSetSchemaSQL returns empty without defaultSchema', () => {
    const ll = new LibraryList({});
    expect(ll.toSetSchemaSQL()).toBeFalsy();
  });
});

describe('SortSequence', () => {
  test('toSetSQL for JOB type', () => {
    const ss = new SortSequence({ type: '*JOB' });
    const sql = ss.toSetSQL();
    expect(sql).toBeTruthy();
    expect(sql).toContain('*JOB');
  });

  test('toSetSQL for HEX type returns null (default, no SQL needed)', () => {
    const ss = new SortSequence({ type: '*HEX' });
    const sql = ss.toSetSQL();
    expect(sql).toBeNull();
  });

  test('toSetSQL returns empty for no type', () => {
    const ss = new SortSequence({});
    expect(ss.toSetSQL()).toBeFalsy();
  });
});

describe('PackageManager', () => {
  test('default package name', () => {
    const pm = new PackageManager();
    expect(pm.defaultPackage).toBe('QSYS2/QSQJRN');
  });

  test('register, get, and remove package', () => {
    const pm = new PackageManager();
    pm.registerPackage('PKG1', { id: 1 });
    expect(pm.getPackage('PKG1')).toEqual({ id: 1 });
    pm.removePackage('PKG1');
    expect(pm.getPackage('PKG1')).toBeNull();
  });

  test('clear removes all packages', () => {
    const pm = new PackageManager();
    pm.registerPackage('A', {});
    pm.registerPackage('B', {});
    pm.clear();
    expect(pm.getPackage('A')).toBeNull();
    expect(pm.getPackage('B')).toBeNull();
  });
});

describe('Savepoint', () => {
  test('auto-generates name if not provided', () => {
    const sp = new Savepoint();
    expect(sp.name).toMatch(/^SP_\d+$/);
    expect(sp.id).toBeGreaterThan(0);
  });

  test('uses provided name', () => {
    const sp = new Savepoint('MY_SP');
    expect(sp.name).toBe('MY_SP');
  });
});

describe('CursorManager', () => {
  test('register and get cursor', () => {
    const mockConn = { sendAndReceive: async () => Buffer.alloc(0) };
    const cm = new CursorManager(mockConn);
    cm.registerCursor(1, [{ sqlType: 496, length: 4 }]);
    const cursor = cm.getCursor(1);
    expect(cursor).not.toBeNull();
    expect(cursor.rpbId).toBe(1);
    expect(cursor.open).toBe(true);
    expect(cursor.endOfData).toBe(false);
  });

  test('getCursor returns null for unknown rpbId', () => {
    const mockConn = { sendAndReceive: async () => Buffer.alloc(0) };
    const cm = new CursorManager(mockConn);
    expect(cm.getCursor(999)).toBeNull();
  });

  test('openCursorCount tracks cursors', () => {
    const mockConn = { sendAndReceive: async () => Buffer.alloc(0) };
    const cm = new CursorManager(mockConn);
    expect(cm.openCursorCount).toBe(0);
    cm.registerCursor(1, []);
    cm.registerCursor(2, []);
    expect(cm.openCursorCount).toBe(2);
  });

  test('fetch throws on unknown cursor', async () => {
    const mockConn = { sendAndReceive: async () => Buffer.alloc(0) };
    const cm = new CursorManager(mockConn);
    await expect(cm.fetch(999)).rejects.toThrow('not open');
  });

  test('fetch returns empty array on endOfData', async () => {
    const mockConn = { sendAndReceive: async () => Buffer.alloc(0) };
    const cm = new CursorManager(mockConn);
    cm.registerCursor(1, []);
    const cursor = cm.getCursor(1);
    cursor.endOfData = true;
    const rows = await cm.fetch(1);
    expect(rows).toEqual([]);
  });
});

describe('StatementManager', () => {
  test('openStatementCount starts at 0', () => {
    const mockConn = { sendAndReceive: async () => Buffer.alloc(0) };
    const mockCursorMgr = {
      registerCursor: () => {},
      closeCursor: async () => {},
    };
    const sm = new StatementManager(mockConn, mockCursorMgr);
    expect(sm.openStatementCount).toBe(0);
  });

  test('prepareStatement() sends SELECT statement type for SELECT', async () => {
    const requests = [];
    const mockConn = {
      async sendAndReceive(buf) {
        requests.push(Buffer.from(buf));
        return buildSuccessReply();
      },
    };
    const mockCursorMgr = {
      registerCursor: () => {},
      closeCursor: async () => {},
    };

    const sm = new StatementManager(mockConn, mockCursorMgr);
    await sm.prepareStatement('SELECT * FROM SYSIBM.SYSDUMMY1');

    expect(requests).toHaveLength(2);
    expect(readShortCodePoint(requests[1], CodePoint.STATEMENT_TYPE)).toBe(StatementType.SELECT);
  });

  test('prepareStatement() does not advertise INSERT as SELECT', async () => {
    const requests = [];
    const mockConn = {
      async sendAndReceive(buf) {
        requests.push(Buffer.from(buf));
        return buildSuccessReply();
      },
    };
    const mockCursorMgr = {
      registerCursor: () => {},
      closeCursor: async () => {},
    };

    const sm = new StatementManager(mockConn, mockCursorMgr);
    await sm.prepareStatement('INSERT INTO QTEMP.T1 VALUES (?)');

    expect(requests).toHaveLength(2);
    expect(readShortCodePoint(requests[1], CodePoint.STATEMENT_TYPE)).toBe(StatementType.OTHER);
  });

  test('execute() shrinks LONGVARCHAR parameter descriptors to the bound value length', async () => {
    const requests = [];
    const mockConn = {
      async sendAndReceive(buf) {
        requests.push(Buffer.from(buf));
        return buildSuccessReply();
      },
    };
    const mockCursorMgr = {
      registerCursor: () => {},
      closeCursor: async () => {},
    };

    const sm = new StatementManager(mockConn, mockCursorMgr);
    const stmt = await sm.prepareStatement('SELECT * FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA LIKE ?');

    stmt.paramDescriptors = [{
      index: 0,
      sqlType: 457,
      length: 32740,
      rawFieldLength: 32742,
      scale: 32740,
      precision: 0,
      ccsid: 1200,
      nullable: true,
      name: 'P1',
      typeName: 'LONGVARCHAR',
    }];
    stmt.paramCount = 1;

    await expect(sm.execute(stmt, ['MYLIB'])).resolves.toBeDefined();

    expect(requests.length).toBeGreaterThanOrEqual(4);
    const formatBuf = readRawCodePoint(requests[2], 0x3801);
    expect(formatBuf).not.toBeNull();
    expect(formatBuf.readInt16BE(6)).toBe(16);   // recordSize
    expect(formatBuf.readInt16BE(12)).toBe(16);  // fieldLength
  });
});

describe('DbConnection', () => {
  test('constructor sets initial state', () => {
    const mockSystem = { user: 'USER', password: 'PASS' };
    const db = new DbConnection(mockSystem);
    expect(db.connected).toBe(false);
    expect(db.getServerCCSID()).toBe(37);
    expect(db.getServerVersion()).toBe(0);
    expect(db.getServerDatastreamLevel()).toBe(0);
  });

  test('prepareStatement throws when not connected', async () => {
    const mockSystem = { user: 'USER', password: 'PASS' };
    const db = new DbConnection(mockSystem);
    await expect(db.prepareStatement('SELECT 1')).rejects.toThrow('not open');
  });

  test('executeImmediate throws when not connected', async () => {
    const mockSystem = { user: 'USER', password: 'PASS' };
    const db = new DbConnection(mockSystem);
    await expect(db.executeImmediate('SELECT 1')).rejects.toThrow('not open');
  });

  test('commit throws when not connected', async () => {
    const mockSystem = { user: 'USER', password: 'PASS' };
    const db = new DbConnection(mockSystem);
    await expect(db.commit()).rejects.toThrow('not open');
  });

  test('rollback throws when not connected', async () => {
    const mockSystem = { user: 'USER', password: 'PASS' };
    const db = new DbConnection(mockSystem);
    await expect(db.rollback()).rejects.toThrow('not open');
  });

  test('setAutoCommit/getAutoCommit work before connect', () => {
    const mockSystem = { user: 'USER', password: 'PASS' };
    const db = new DbConnection(mockSystem);
    expect(db.getAutoCommit()).toBe(true);
    db.setAutoCommit(false);
    expect(db.getAutoCommit()).toBe(false);
  });

  test('close is no-op when not connected', async () => {
    const mockSystem = { user: 'USER', password: 'PASS' };
    const db = new DbConnection(mockSystem);
    await db.close(); // should not throw
  });
});
