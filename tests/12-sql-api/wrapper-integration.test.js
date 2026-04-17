/**
 * Wrapper-object integration tests.
 *
 * Verifies that:
 *   - ResultSet/CallableStatement getters return Blob/Clob/SQLXML/SqlArray/RowId wrappers
 *   - PreparedStatement setters accept wrappers and unwrap them at execute time
 *   - PreparedStatement.setSQLXML() does NOT stringify a SQLXML instance
 *   - Generated keys wrap INSERT as SELECT * FROM FINAL TABLE (INSERT)
 *   - Statement.addBatch(sql) / executeBatch() accumulate strings
 *   - DataSource exposes the JTOpen property setter surface
 */
import { describe, test, expect } from 'bun:test';
import { ResultSet } from '../../src/db/api/ResultSet.js';
import { CallableStatement } from '../../src/db/api/CallableStatement.js';
import { PreparedStatement, SQL_NULL } from '../../src/db/api/PreparedStatement.js';
import { Statement, RETURN_GENERATED_KEYS, SUCCESS_NO_INFO } from '../../src/db/api/Statement.js';
import { SqlArray } from '../../src/db/api/SqlArray.js';
import { RowId } from '../../src/db/api/RowId.js';
import { SqlWarning } from '../../src/db/api/SqlWarning.js';
import { Blob } from '../../src/db/lob/Blob.js';
import { Clob } from '../../src/db/lob/Clob.js';
import { SQLXML } from '../../src/db/lob/SQLXML.js';
import { DataSource, ConnectionPoolDataSource } from '../../src/db/api/DataSource.js';

// ─── ResultSet wrapper getters ─────────────────────────────────────────

describe('ResultSet wrapper getters', () => {
  const colDescs = [
    { name: 'BLOB_COL', sqlType: 404, nullable: true, ccsid: 65535 },
    { name: 'CLOB_COL', sqlType: 408, nullable: true, ccsid: 37 },
    { name: 'XML_COL',  sqlType: 988, nullable: true, ccsid: 1208 },
    { name: 'ARR_COL',  sqlType: 2003, nullable: true },
    { name: 'ROWID_COL', sqlType: -8,  nullable: true },
  ];
  const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const rows = [{
    BLOB_COL: buf,
    CLOB_COL: 'hello clob',
    XML_COL: '<root><id>42</id></root>',
    ARR_COL: [1, 2, 3],
    ROWID_COL: buf,
  }];

  test('getBlob returns a Blob wrapper', async () => {
    const rs = new ResultSet({ rows, columnDescriptors: colDescs });
    await rs.next();
    const b = rs.getBlob('BLOB_COL');
    expect(b).toBeInstanceOf(Blob);
    expect(Buffer.compare(await b.toBuffer(), buf)).toBe(0);
  });

  test('getClob returns a Clob wrapper', async () => {
    const rs = new ResultSet({ rows, columnDescriptors: colDescs });
    await rs.next();
    const c = rs.getClob('CLOB_COL');
    expect(c).toBeInstanceOf(Clob);
    expect(await c.text()).toBe('hello clob');
  });

  test('getSQLXML returns a SQLXML wrapper', async () => {
    const rs = new ResultSet({ rows, columnDescriptors: colDescs });
    await rs.next();
    const x = rs.getSQLXML('XML_COL');
    expect(x).toBeInstanceOf(SQLXML);
    expect(await x.getString()).toBe('<root><id>42</id></root>');
  });

  test('getArray returns a SqlArray wrapper', async () => {
    const rs = new ResultSet({ rows, columnDescriptors: colDescs });
    await rs.next();
    const a = rs.getArray('ARR_COL');
    expect(a).toBeInstanceOf(SqlArray);
    expect(a.getArray()).toEqual([1, 2, 3]);
  });

  test('getRowId returns a RowId wrapper', async () => {
    const rs = new ResultSet({ rows, columnDescriptors: colDescs });
    await rs.next();
    const r = rs.getRowId('ROWID_COL');
    expect(r).toBeInstanceOf(RowId);
    expect(r.toString()).toBe('01020304');
  });

  test('null wrapper getters return null', async () => {
    const rs = new ResultSet({
      rows: [{ BLOB_COL: null, CLOB_COL: null, XML_COL: null, ARR_COL: null, ROWID_COL: null }],
      columnDescriptors: colDescs,
    });
    await rs.next();
    expect(rs.getBlob('BLOB_COL')).toBeNull();
    expect(rs.getClob('CLOB_COL')).toBeNull();
    expect(rs.getSQLXML('XML_COL')).toBeNull();
    expect(rs.getArray('ARR_COL')).toBeNull();
    expect(rs.getRowId('ROWID_COL')).toBeNull();
  });

  test('getClobString legacy accessor still works', async () => {
    const rs = new ResultSet({ rows, columnDescriptors: colDescs });
    await rs.next();
    expect(rs.getClobString('CLOB_COL')).toBe('hello clob');
  });
});

// ─── CallableStatement wrapper getters ────────────────────────────────

describe('CallableStatement wrapper getters', () => {
  const conn = {
    async prepare() {
      return { async execute() { return []; }, async close() {}, paramCount: 5 };
    },
  };

  test('getBlob/getClob/getSQLXML/getArray/getRowId return wrappers', () => {
    const cs = new CallableStatement(conn, 'L.P');
    cs.registerOutParameter(1, 'blob');
    cs.registerOutParameter(2, 'clob');
    cs.registerOutParameter(3, 'xml');
    cs.registerOutParameter(4, 'array');
    cs.registerOutParameter(5, 'rowid');

    const buf = Buffer.from('abc');
    cs.setOutValue(1, buf);
    cs.setOutValue(2, 'text');
    cs.setOutValue(3, '<x/>');
    cs.setOutValue(4, [10, 20]);
    cs.setOutValue(5, buf);

    expect(cs.getBlob(1)).toBeInstanceOf(Blob);
    expect(cs.getClob(2)).toBeInstanceOf(Clob);
    expect(cs.getSQLXML(3)).toBeInstanceOf(SQLXML);
    expect(cs.getArray(4)).toBeInstanceOf(SqlArray);
    expect(cs.getRowId(5)).toBeInstanceOf(RowId);
  });

  test('null OUT produces null wrapper', () => {
    const cs = new CallableStatement(conn, 'L.P');
    cs.registerOutParameter(1, 'blob');
    cs.setOutValue(1, null);
    expect(cs.getBlob(1)).toBeNull();
  });
});

// ─── PreparedStatement wrapper setters ────────────────────────────────

describe('PreparedStatement setSQLXML unwraps wrapper', () => {
  let lastParams = null;
  function makeStmt() {
    const dbc = {
      statementManager: {
        async execute(handle, params) {
          lastParams = params;
          return {
            hasResultSet: false,
            rows: [],
            affectedRows: 1,
            columnDescriptors: [],
            endOfData: true,
          };
        },
        async closeStatement() {},
        async executeBatch(handle, sets) {
          lastParams = sets;
          return { affectedRows: sets.length, isInsert: true };
        },
      },
      cursorManager: {},
      async prepareStatement() {
        return { paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
      },
    };
    const handle = { paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
    return new PreparedStatement(dbc, handle, 'INSERT INTO T(X) VALUES (?)');
  }

  test('setSQLXML(wrapper) does NOT stringify as [object Object]', async () => {
    const ps = makeStmt();
    const xml = SQLXML.from('<root><id>42</id></root>');
    ps.setSQLXML(1, xml);
    await ps.execute();
    expect(lastParams[0]).toBe('<root><id>42</id></root>');
    // ensure we never produced the [object Object] bug
    expect(lastParams[0]).not.toBe('[object Object]');
  });

  test('setBlob(wrapper) unwraps to Buffer', async () => {
    const ps = makeStmt();
    const blob = Blob.from(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
    ps.setBlob(1, blob);
    await ps.execute();
    expect(Buffer.isBuffer(lastParams[0])).toBe(true);
    expect(Buffer.compare(lastParams[0], Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]))).toBe(0);
  });

  test('setClob(wrapper) unwraps to string', async () => {
    const ps = makeStmt();
    ps.setClob(1, Clob.from('long text'));
    await ps.execute();
    expect(lastParams[0]).toBe('long text');
  });

  test('setRowId(wrapper) unwraps to raw bytes', async () => {
    const ps = makeStmt();
    const r = new RowId(Buffer.from([1, 2, 3]));
    ps.setRowId(1, r);
    await ps.execute();
    expect(Buffer.isBuffer(lastParams[0])).toBe(true);
    expect(Buffer.compare(lastParams[0], Buffer.from([1, 2, 3]))).toBe(0);
  });

  test('setArray(SqlArray) unwraps to plain array at execute', async () => {
    const ps = makeStmt();
    const arr = new SqlArray({ baseTypeName: 'INTEGER', elements: [1, 2, 3] });
    ps.setArray(1, arr);
    await ps.execute();
    expect(lastParams[0]).toEqual([1, 2, 3]);
  });

  test('setSQLXML(null) stays SQL_NULL', async () => {
    const ps = makeStmt();
    ps.setSQLXML(1, null);
    await ps.execute();
    expect(lastParams[0]).toBeNull();
  });
});

// ─── Generated keys wrapping ──────────────────────────────────────────

describe('Generated keys wrapping', () => {
  test('prepared INSERT with returnGeneratedKeys wraps in FINAL TABLE', async () => {
    const preparedSqls = [];
    const dbc = {
      statementManager: {
        async execute(handle, params) {
          if (handle.isFinalTable) {
            return {
              hasResultSet: true,
              rows: [{ ID: 42, NAME: 'NEW' }],
              columnDescriptors: [{ name: 'ID' }, { name: 'NAME' }],
              endOfData: true,
            };
          }
          return { hasResultSet: false, rows: [], affectedRows: 1, columnDescriptors: [], endOfData: true };
        },
        async closeStatement() {},
      },
      cursorManager: {},
      async prepareStatement(sql) {
        preparedSqls.push(sql);
        return {
          paramCount: 1,
          columnCount: /FINAL TABLE/i.test(sql) ? 2 : 0,
          paramDescriptors: [],
          columnDescriptors: [],
          isFinalTable: /FINAL TABLE/i.test(sql),
        };
      },
    };

    const handle = { paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
    const ps = new PreparedStatement(dbc, handle, 'INSERT INTO T(NAME) VALUES (?)');
    const result = await ps.execute(['NEW'], { returnGeneratedKeys: true });

    expect(result.affectedRows).toBe(1);
    expect(result.generatedKeys).toEqual([{ ID: 42, NAME: 'NEW' }]);
    expect(preparedSqls.some(s => /SELECT \* FROM FINAL TABLE/i.test(s))).toBe(true);

    const keysRs = ps.getGeneratedKeys();
    const keysArr = await keysRs.toArray();
    expect(keysArr).toEqual([{ ID: 42, NAME: 'NEW' }]);
  });

  test('statement getGeneratedKeys returns empty ResultSet before any execute', async () => {
    const dbc = {
      statementManager: {
        async execute() { return { hasResultSet: false, rows: [], affectedRows: 0, columnDescriptors: [] }; },
        async closeStatement() {},
      },
      cursorManager: {},
      async prepareStatement() { return { paramCount: 0, columnCount: 0, paramDescriptors: [], columnDescriptors: [] }; },
      async executeImmediate() { return { affectedRows: 0 }; },
    };
    const stmt = new Statement(dbc);
    const rs = stmt.getGeneratedKeys();
    expect(await rs.toArray()).toEqual([]);
  });

  test('non-INSERT is NOT wrapped', async () => {
    const preparedSqls = [];
    const dbc = {
      statementManager: {
        async execute() { return { hasResultSet: false, rows: [], affectedRows: 0, columnDescriptors: [], endOfData: true }; },
        async closeStatement() {},
      },
      cursorManager: {},
      async prepareStatement(sql) {
        preparedSqls.push(sql);
        return { paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
      },
    };
    const handle = { paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
    const ps = new PreparedStatement(dbc, handle, 'UPDATE T SET X=? WHERE ID=1');
    await ps.execute([42], { returnGeneratedKeys: true });
    // UPDATE should not go through FINAL TABLE wrapping
    expect(preparedSqls.some(s => /FINAL TABLE/i.test(s))).toBe(false);
  });
});

// ─── Statement API additions ─────────────────────────────────────────

describe('Statement API additions', () => {
  function makeStmt() {
    return new Statement({
      async prepareStatement() { return { paramCount: 0 }; },
      async executeImmediate(sql) {
        if (/fail-batch/i.test(sql)) throw new Error('boom');
        return { affectedRows: 1 };
      },
      statementManager: { async execute() { return { hasResultSet: false, rows: [], affectedRows: 1, columnDescriptors: [] }; }, async closeStatement() {} },
      cursorManager: {},
    });
  }

  test('addBatch(sql) / executeBatch returns update counts', async () => {
    const stmt = makeStmt();
    stmt.addBatch("INSERT INTO T VALUES ('A')");
    stmt.addBatch("INSERT INTO T VALUES ('B')");
    const counts = await stmt.executeBatch();
    expect(counts.length).toBe(2);
    expect(counts[0]).toBe(1);
    expect(counts[1]).toBe(1);
  });

  test('executeBatch records EXECUTE_FAILED and adds a warning on error', async () => {
    const stmt = makeStmt();
    stmt.addBatch("INSERT INTO T VALUES ('ok')");
    stmt.addBatch("fail-batch statement");
    const counts = await stmt.executeBatch();
    expect(counts[0]).toBe(1);
    expect(counts[1]).toBeLessThan(0);
    const w = stmt.getWarnings();
    expect(w).toBeInstanceOf(SqlWarning);
  });

  test('cancel() / isCancelled()', () => {
    const stmt = makeStmt();
    expect(stmt.isCancelled()).toBe(false);
    stmt.cancel();
    expect(stmt.isCancelled()).toBe(true);
  });

  test('getUpdateCount / getResultSet defaults', () => {
    const stmt = makeStmt();
    expect(stmt.getUpdateCount()).toBe(-1);
    expect(stmt.getResultSet()).toBeNull();
  });

  test('setters/getters on fetch/max/cursor', () => {
    const stmt = makeStmt();
    stmt.setFetchSize(100);
    stmt.setMaxRows(500);
    stmt.setMaxFieldSize(4096);
    stmt.setCursorName('MYCURSOR');
    stmt.setQueryTimeout(30);
    stmt.setEscapeProcessing(false);
    stmt.setPoolable(true);
    stmt.closeOnCompletion();
    expect(stmt.getFetchSize()).toBe(100);
    expect(stmt.getMaxRows()).toBe(500);
    expect(stmt.getMaxFieldSize()).toBe(4096);
    expect(stmt.getCursorName()).toBe('MYCURSOR');
    expect(stmt.getQueryTimeout()).toBe(30);
    expect(stmt.getEscapeProcessing()).toBe(false);
    expect(stmt.isPoolable()).toBe(true);
    expect(stmt.isCloseOnCompletion()).toBe(true);
  });

  test('RETURN_GENERATED_KEYS numeric code triggers wrapping', async () => {
    const preparedSqls = [];
    const dbc = {
      async prepareStatement(sql) {
        preparedSqls.push(sql);
        return { paramCount: 0, columnCount: /FINAL TABLE/i.test(sql) ? 1 : 0, paramDescriptors: [], columnDescriptors: [] };
      },
      statementManager: {
        async execute() {
          return { hasResultSet: true, rows: [{ ID: 7 }], columnDescriptors: [{ name: 'ID' }], endOfData: true };
        },
        async closeStatement() {},
      },
      cursorManager: {},
      async executeImmediate() { return { affectedRows: 1 }; },
    };
    const stmt = new Statement(dbc);
    const r = await stmt.execute("INSERT INTO T(X) VALUES (1)", RETURN_GENERATED_KEYS);
    expect(r.affectedRows).toBe(1);
    expect(r.generatedKeys).toEqual([{ ID: 7 }]);
    expect(preparedSqls.some(s => /FINAL TABLE/i.test(s))).toBe(true);
  });
});

// ─── DataSource ──────────────────────────────────────────────────────

describe('DataSource', () => {
  test('JTOpen-style setters round-trip via property bag', () => {
    const ds = new DataSource();
    ds.setServerName('myhost');
    ds.setUser('MYUSER');
    ds.setPassword('secret');
    ds.setLibraries('MYLIB,QGPL,QTEMP');
    ds.setNaming('sql');
    ds.setDateFormat('iso');
    ds.setBlockSize(128);
    ds.setPackage('QZDAPKG');
    ds.setPackageLibrary('QGPL');
    ds.setExtendedDynamic(true);
    ds.setExtendedMetaData(true);

    expect(ds.getServerName()).toBe('myhost');
    expect(ds.getUser()).toBe('MYUSER');
    expect(ds.getLibraries()).toBe('MYLIB,QGPL,QTEMP');
    expect(ds.getNaming()).toBe('sql');
    expect(ds.getPackageCache?.()).toBeUndefined(); // unset
    expect(ds.getExtendedDynamic()).toBe(true);
  });

  test('toConnectOptions maps to js400 keys', () => {
    const ds = new DataSource();
    ds.setServerName('h');
    ds.setDatabaseName('LIB1');
    ds.setUser('u');
    ds.setPassword('p');
    ds.setPortNumber(9471);
    ds.setSecure(true);
    const opts = ds.toConnectOptions();
    expect(opts.host).toBe('h');
    expect(opts.defaultSchema).toBe('LIB1');
    expect(opts.user).toBe('u');
    expect(opts.password).toBe('p');
    expect(opts.port).toBe(9471);
    expect(opts.secure).toBe(true);
  });

  test('getReference returns a plain-object descriptor', () => {
    const ds = new DataSource();
    ds.setServerName('h'); ds.setUser('u');
    const ref = ds.getReference();
    expect(ref.className).toBe('com.ibm.as400.access.AS400JDBCDataSource');
    expect(ref.properties.serverName).toBe('h');
    expect(ref.properties.user).toBe('u');
  });

  test('unmapped JTOpen properties are stored verbatim and round-trip to options', () => {
    const ds = new DataSource();
    ds.setPackageCache(true);
    ds.setQueryStorageLimit(500000);
    const opts = ds.toConnectOptions();
    expect(opts.packageCache).toBe(true);
    expect(opts.queryStorageLimit).toBe(500000);
  });

  test('known property list is non-empty', () => {
    expect(DataSource.knownProperties.length).toBeGreaterThan(50);
    expect(DataSource.knownProperties).toContain('serverName');
    expect(DataSource.knownProperties).toContain('extendedDynamic');
    expect(DataSource.knownProperties).toContain('enableClientAffinitiesList');
  });
});

describe('ConnectionPoolDataSource', () => {
  test('inherits DataSource property surface', () => {
    const cpds = new ConnectionPoolDataSource();
    cpds.setServerName('h'); cpds.setUser('u'); cpds.setPassword('p');
    expect(cpds.getServerName()).toBe('h');
    expect(cpds.getUser()).toBe('u');
  });

  test('getReference identifies as DataSource factory', () => {
    const cpds = new ConnectionPoolDataSource();
    cpds.setServerName('h');
    const ref = cpds.getReference();
    expect(ref.className).toBe('com.ibm.as400.access.AS400JDBCDataSource');
    expect(ref.properties.serverName).toBe('h');
  });
});
