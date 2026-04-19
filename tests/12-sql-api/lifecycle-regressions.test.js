/**
 * Lifecycle-regression tests required by the review gate.
 *
 * Covers:
 *   - ConnectionPoolDataSource.getPooledConnection() no longer throws,
 *     logical close returns the connection to the pool, and repeated
 *     checkout reuses the same physical connection.
 *   - Statement.executeQuery() closes the prepared handle exactly once
 *     when the ResultSet or Statement closes.
 *   - Prepared-statement cache reuses a handle after close() without
 *     returning a server-closed handle (no more reuse-after-free bug).
 *   - PreparedStatement getGeneratedKeys() is cleared at the start of
 *     every execute().
 */
import { describe, test, expect } from 'bun:test';
import { ConnectionPoolDataSource } from '../../src/db/api/DataSource.js';
import { ConnectionPool } from '../../src/db/pool/ConnectionPool.js';
import { Statement } from '../../src/db/api/Statement.js';
import { PreparedStatement } from '../../src/db/api/PreparedStatement.js';
import { Connection } from '../../src/db/api/Connection.js';
import { PreparedStatementCache } from '../../src/db/api/PreparedStatementCache.js';
import { CallableStatement } from '../../src/db/api/CallableStatement.js';
import { SqlWarning } from '../../src/db/api/SqlWarning.js';

// ─── ConnectionPoolDataSource.getPooledConnection ─────────────────────

describe('ConnectionPoolDataSource.getPooledConnection', () => {
  function makeFakeConnection() {
    let closed = false;
    return {
      get closed() { return closed; },
      async close() { closed = true; },
      _pool: null,
      _poolEntry: null,
    };
  }

  function makeCpds(createCountRef) {
    const cpds = new ConnectionPoolDataSource();
    cpds.setServerName('host');
    cpds.setUser('u');
    cpds.setPassword('p');
    // Shim the pool with a test double that tracks physical creations.
    const pool = new ConnectionPool({
      max: 4,
      idleTimeout: 0, // disables the idle sweeper
      connect: async () => {
        createCountRef.count++;
        return makeFakeConnection();
      },
    });
    cpds.__setPool(pool);
    return { cpds, pool };
  }

  test('getPooledConnection() succeeds (was throwing on pool.acquire)', async () => {
    const cnt = { count: 0 };
    const { cpds, pool } = makeCpds(cnt);
    const pc = await cpds.getPooledConnection();
    expect(pc).toBeDefined();
    expect(pc.getConnection()).toBeDefined();
    expect(cnt.count).toBe(1);
    await pc.close();
    await pool.close();
  });

  test('logical close returns the physical connection to the pool', async () => {
    const cnt = { count: 0 };
    const { cpds, pool } = makeCpds(cnt);
    const pc = await cpds.getPooledConnection();
    const physical = pc.getConnection();
    await pc.close();
    expect(physical.closed).toBe(false); // not physically closed
    expect(pool.available).toBe(1);      // back in the idle set
    await pool.close();
  });

  test('repeated checkout reuses the same physical connection', async () => {
    const cnt = { count: 0 };
    const { cpds, pool } = makeCpds(cnt);
    const pc1 = await cpds.getPooledConnection();
    const first = pc1.getConnection();
    await pc1.close();

    const pc2 = await cpds.getPooledConnection();
    const second = pc2.getConnection();
    expect(second).toBe(first);     // SAME physical object
    expect(cnt.count).toBe(1);      // NO new signon
    await pc2.close();
    await pool.close();
  });

  test('close fires connectionClosed listeners exactly once', async () => {
    const cnt = { count: 0 };
    const { cpds, pool } = makeCpds(cnt);
    const pc = await cpds.getPooledConnection();
    let events = 0;
    pc.addConnectionEventListener({ connectionClosed() { events++; } });
    await pc.close();
    await pc.close(); // second close must be a no-op
    expect(events).toBe(1);
    await pool.close();
  });

  test('getPool() snapshots configuration; later setter calls do NOT mutate the live pool', async () => {
    // Contract: config is frozen after the first getPool(). A setter
    // called afterward must not rebuild the pool and must not change
    // the connect options the pool will use when creating its next
    // physical connection. Callers that need to reconfigure must call
    // closePool() first.
    const cpds = new ConnectionPoolDataSource();
    cpds.setServerName('host');
    cpds.setUser('u');
    cpds.setPassword('p');
    cpds.setLibraries('LIBA');

    // Capture connect-option bag seen at pool-creation time.
    const seen = [];
    const origConnect = (await import('../../src/db/pool/ConnectionPool.js')).ConnectionPool;
    // Avoid monkey-patching the real connect(); instead, inject a
    // stub pool and capture the snapshot via toConnectOptions().
    const snapshotAtCreate = cpds.toConnectOptions();
    const pool1 = cpds.getPool();
    // Mutate the DataSource AFTER pool was handed out.
    cpds.setLibraries('LIBB');
    const pool2 = cpds.getPool();
    expect(pool2).toBe(pool1);                          // SAME pool
    expect(snapshotAtCreate.libraries).toBe('LIBA');    // frozen
    // Current getter reflects the new mutation, but the pool was
    // created with the old snapshot.
    expect(cpds.getLibraries()).toBe('LIBB');

    // closePool() forgets the pool so a later getPool() picks up the
    // new configuration.
    await cpds.closePool();
    const pool3 = cpds.getPool();
    expect(pool3).not.toBe(pool1);
    await pool3.close();
  });

  test('statement listeners are accepted but fire no events today', async () => {
    // JDBC contract parity: addStatementEventListener must not throw.
    // js400 does not emit statementClosed / statementErrorOccurred
    // yet — calling through the listener is a silent no-op until the
    // Statement layer grows event wiring.
    const cnt = { count: 0 };
    const { cpds, pool } = makeCpds(cnt);
    const pc = await cpds.getPooledConnection();
    let events = 0;
    pc.addStatementEventListener({
      statementClosed() { events++; },
      statementErrorOccurred() { events++; },
    });
    await pc.close();
    expect(events).toBe(0);
    await pool.close();
  });

  test('getPooledConnection(user,password) bypasses the pool and physically closes', async () => {
    // The bypass branch uses DataSource.getConnection which invokes the
    // global connect(). That requires a network, so we can only assert
    // the pool stays untouched.
    const cnt = { count: 0 };
    const { cpds, pool } = makeCpds(cnt);
    // Fake the getConnection path by monkey-patching.
    let bypassCreated = 0;
    cpds.getConnection = async () => { bypassCreated++; return makeFakeConnection(); };
    const pc = await cpds.getPooledConnection('alt', 'alt');
    expect(bypassCreated).toBe(1);
    expect(pool.activeCount).toBe(0); // bypass did NOT touch the pool
    await pc.close();
    await pool.close();
  });
});

// ─── Statement.executeQuery resource ownership ─────────────────────────

describe('Statement.executeQuery prepared-handle cleanup', () => {
  function makeDbConnection(state = {}) {
    state.prepared = state.prepared ?? 0;
    state.closed = state.closed ?? 0;
    return {
      async prepareStatement(sql) {
        state.prepared++;
        return {
          id: state.prepared,
          paramCount: 0,
          columnCount: 1,
          paramDescriptors: [],
          columnDescriptors: [{ name: 'X' }],
        };
      },
      cursorManager: { async closeCursor() {} },
      statementManager: {
        async execute(handle) {
          return {
            hasResultSet: true,
            rows: [{ X: 1 }],
            columnDescriptors: [{ name: 'X' }],
            rpbId: 1,
            endOfData: true,
          };
        },
        async closeStatement(handle) { state.closed++; },
      },
    };
  }

  test('ResultSet.close() closes the prepared handle exactly once', async () => {
    const state = {};
    const stmt = new Statement(makeDbConnection(state));
    const rs = await stmt.executeQuery('SELECT X FROM T');
    expect(state.prepared).toBe(1);
    expect(state.closed).toBe(0); // not yet
    await rs.close();
    expect(state.closed).toBe(1);
    // Second close on the ResultSet is a no-op
    await rs.close();
    expect(state.closed).toBe(1);
  });

  test('Statement.close() closes the handle if the caller dropped the ResultSet', async () => {
    const state = {};
    const stmt = new Statement(makeDbConnection(state));
    await stmt.executeQuery('SELECT X FROM T');
    // Caller never closed the ResultSet — Statement.close() must clean up.
    await stmt.close();
    expect(state.closed).toBe(1);
  });

  test('Statement.close() is idempotent with respect to handle close', async () => {
    const state = {};
    const stmt = new Statement(makeDbConnection(state));
    const rs = await stmt.executeQuery('SELECT X FROM T');
    await rs.close();
    await stmt.close();
    await stmt.close();
    expect(state.closed).toBe(1); // exactly one physical close
  });

  test('A second executeQuery on the same Statement closes the old handle first', async () => {
    const state = {};
    const stmt = new Statement(makeDbConnection(state));
    await stmt.executeQuery('SELECT X FROM T');
    expect(state.closed).toBe(0);
    // Caller did NOT close the first ResultSet — new executeQuery must reap it
    await stmt.executeQuery('SELECT X FROM T2');
    expect(state.closed).toBe(1);
    await stmt.close();
    expect(state.closed).toBe(2);
  });
});

// ─── Prepared-statement cache lease semantics ──────────────────────────

describe('PreparedStatementCache lease semantics', () => {
  test('acquire removes handle from idle set; release returns it', () => {
    const cache = new PreparedStatementCache(4);
    const h1 = { id: 1 };
    cache.release('SELECT 1', h1);
    expect(cache.size).toBe(1);
    expect(cache.acquire('SELECT 1')).toBe(h1);
    expect(cache.size).toBe(0);       // lease removed it
    expect(cache.acquire('SELECT 1')).toBeNull(); // second lease is a miss
    expect(cache.release('SELECT 1', h1)).toBeNull();
    expect(cache.acquire('SELECT 1')).toBe(h1);
  });

  test('release returns the evicted handle when at capacity', () => {
    const cache = new PreparedStatementCache(2);
    const a = { id: 'A' };
    const b = { id: 'B' };
    const c = { id: 'C' };
    expect(cache.release('A', a)).toBeNull();
    expect(cache.release('B', b)).toBeNull();
    const evicted = cache.release('C', c); // evicts A (LRU)
    expect(evicted).toBe(a);
    expect(cache.acquire('A')).toBeNull();
    expect(cache.acquire('B')).toBe(b);
    expect(cache.acquire('C')).toBe(c);
  });

  test('drain() returns all idle handles and empties the cache', () => {
    const cache = new PreparedStatementCache(4);
    cache.release('A', { id: 'A' });
    cache.release('B', { id: 'B' });
    const drained = cache.drain();
    expect(drained.length).toBe(2);
    expect(cache.size).toBe(0);
  });
});

describe('Connection.prepare reuses cached handle after close', () => {
  function makeFakeDbConnection(state) {
    state.prepareCount = 0;
    state.closeCount = 0;
    return {
      connected: true,
      async prepareStatement(sql) {
        state.prepareCount++;
        return {
          id: state.prepareCount,
          sql,
          paramCount: 0,
          columnCount: 0,
          paramDescriptors: [],
          columnDescriptors: [],
        };
      },
      cursorManager: { async closeCursor() {} },
      statementManager: {
        async execute() {
          return { hasResultSet: false, rows: [], columnDescriptors: [], affectedRows: 1, endOfData: true };
        },
        async closeStatement() { state.closeCount++; },
      },
      async close() {},
    };
  }

  test('prepare, close, prepare same SQL, execute — second prepare avoids server round-trip', async () => {
    const state = {};
    const db = makeFakeDbConnection(state);
    const conn = new Connection(db);

    const s1 = await conn.prepare('INSERT INTO T VALUES (?)');
    expect(state.prepareCount).toBe(1);
    await s1.close();
    // Handle was returned to cache, NOT physically closed
    expect(state.closeCount).toBe(0);

    const s2 = await conn.prepare('INSERT INTO T VALUES (?)');
    // Cached — no new prepareStatement call
    expect(state.prepareCount).toBe(1);

    // Execute succeeds — the underlying handle is still live on the server.
    const r = await s2.execute([42]);
    expect(r.affectedRows).toBe(1);

    await s2.close();
    expect(state.closeCount).toBe(0);   // still in cache

    await conn.close();
    expect(state.closeCount).toBe(1);   // drained on connection close
  });

  test('cached prepared SELECT closes cursor before release (no -502 on reuse)', async () => {
    // Models the real host behavior that bit us on a live IBM i host: a cached
    // prepared SELECT whose cursor was left open on the server fails
    // the next execute with SQLCODE -502 ("cursor already open"). We
    // simulate that by tracking open cursor state and having the
    // fake engine throw on execute when the cursor is still open.
    const state = { open: new Set(), prepareCount: 0, closeCount: 0 };
    const cursorMgr = {
      registerCursor(rpbId) { state.open.add(rpbId); },
      async closeCursor(rpbId) { state.open.delete(rpbId); },
      async fetch(_rpbId, _n) { return []; },
    };
    const db = {
      connected: true,
      async prepareStatement(sql) {
        state.prepareCount++;
        return {
          id: state.prepareCount,
          sql,
          rpbId: 42, // same rpbId on reuse to force the collision path
          paramCount: 0,
          columnCount: 1,
          paramDescriptors: [],
          columnDescriptors: [{ name: 'X' }],
        };
      },
      cursorManager: cursorMgr,
      statementManager: {
        async execute(handle) {
          if (state.open.has(handle.rpbId)) {
            // Simulate SQLCODE -502.
            const err = new Error('SQL0502: cursor already open (cached handle)');
            err.sqlCode = -502;
            throw err;
          }
          state.open.add(handle.rpbId);
          return {
            hasResultSet: true,
            rows: [{ X: 1 }],
            columnDescriptors: handle.columnDescriptors,
            rpbId: handle.rpbId,
            endOfData: false,
            affectedRows: 0,
            sqlca: { sqlCode: 0 },
          };
        },
        async closeStatement() { state.closeCount++; },
      },
      async close() {},
    };
    const conn = new Connection(db);
    const s1 = await conn.prepare('SELECT X FROM T');
    const r1 = await s1.execute([]);
    expect(Array.isArray(r1)).toBe(true);
    await s1.close();                  // returns to cache
    expect(state.closeCount).toBe(0);  // no physical close

    // Reuse — must NOT throw -502.
    const s2 = await conn.prepare('SELECT X FROM T');
    expect(state.prepareCount).toBe(1); // cache hit
    const r2 = await s2.execute([]);
    expect(Array.isArray(r2)).toBe(true);
    await s2.close();

    await conn.close();
    expect(state.closeCount).toBe(1);
  });

  test('Connection.close physically closes every idle cached handle', async () => {
    const state = {};
    const db = makeFakeDbConnection(state);
    const conn = new Connection(db);

    const a = await conn.prepare('SELECT 1');
    const b = await conn.prepare('SELECT 2');
    await a.close();
    await b.close();
    expect(state.closeCount).toBe(0);

    await conn.close();
    expect(state.closeCount).toBe(2);
  });

  test('cache disabled (capacity 0) closes handles physically on statement close', async () => {
    const state = {};
    const db = makeFakeDbConnection(state);
    const conn = new Connection(db, { statementCacheSize: 0 });

    const s = await conn.prepare('SELECT 1');
    await s.close();
    expect(state.closeCount).toBe(1);
    await conn.close();
  });
});

// ─── Stale generated-key state ──────────────────────────────────────────

describe('PreparedStatement.getGeneratedKeys resets between executes', () => {
  function makeDbConnection(state) {
    state.prepared = 0;
    return {
      async prepareStatement(sql) {
        state.prepared++;
        return {
          id: state.prepared,
          sql,
          paramCount: 1,
          columnCount: /FINAL TABLE/i.test(sql) ? 1 : 0,
          paramDescriptors: [],
          columnDescriptors: /FINAL TABLE/i.test(sql) ? [{ name: 'ID' }] : [],
        };
      },
      cursorManager: { async closeCursor() {} },
      statementManager: {
        async execute(handle) {
          if (/FINAL TABLE/i.test(handle.sql)) {
            return {
              hasResultSet: true,
              rows: [{ ID: 7 }],
              columnDescriptors: [{ name: 'ID' }],
              endOfData: true,
            };
          }
          return { hasResultSet: false, rows: [], affectedRows: 1, columnDescriptors: [], endOfData: true };
        },
        async closeStatement() {},
      },
    };
  }

  test('first execute with returnGeneratedKeys; second without — keys cleared', async () => {
    const state = {};
    const db = makeDbConnection(state);
    const handle = {
      id: 0, sql: 'INSERT INTO T (X) VALUES (?)',
      paramCount: 1, columnCount: 0,
      paramDescriptors: [], columnDescriptors: [],
    };
    const ps = new PreparedStatement(db, handle, 'INSERT INTO T (X) VALUES (?)');

    const r1 = await ps.execute(['a'], { returnGeneratedKeys: true });
    expect(r1.generatedKeys).toEqual([{ ID: 7 }]);
    const keysRs1 = ps.getGeneratedKeys();
    expect(await keysRs1.toArray()).toEqual([{ ID: 7 }]);

    // Now execute again WITHOUT returnGeneratedKeys — state must clear.
    const r2 = await ps.execute(['b']);
    expect(r2.generatedKeys).toBeUndefined();
    const keysRs2 = ps.getGeneratedKeys();
    expect(await keysRs2.toArray()).toEqual([]);
  });

  test('generated-keys rewrite only fires when returnGeneratedKeys is requested', async () => {
    // Counter regression: `SELECT * FROM FINAL TABLE (INSERT ...)` wraps
    // the INSERT and adds one extra prepare RTT. That cost must not be
    // paid for unflagged INSERTs on the hot path.
    const state = {};
    const db = makeDbConnection(state);
    const handle = {
      id: 0, sql: 'INSERT INTO T (X) VALUES (?)',
      paramCount: 1, columnCount: 0,
      paramDescriptors: [], columnDescriptors: [],
    };
    const ps = new PreparedStatement(db, handle, 'INSERT INTO T (X) VALUES (?)');

    // Plain execute: must NOT prepare a FINAL TABLE wrapper.
    const before = state.prepared;
    await ps.execute(['a']);
    expect(state.prepared).toBe(before); // zero extra prepares

    // With the flag: exactly ONE extra prepare for the FINAL TABLE wrap.
    await ps.execute(['b'], { returnGeneratedKeys: true });
    expect(state.prepared).toBe(before + 1);

    // Back to plain: zero extras again.
    await ps.execute(['c']);
    expect(state.prepared).toBe(before + 1);
  });

  test('executeForStream also clears generated-keys state', async () => {
    const state = {};
    const db = makeDbConnection(state);
    const handle = {
      id: 0, sql: 'INSERT INTO T (X) VALUES (?)',
      paramCount: 1, columnCount: 0,
      paramDescriptors: [], columnDescriptors: [],
    };
    const ps = new PreparedStatement(db, handle, 'INSERT INTO T (X) VALUES (?)');
    await ps.execute(['a'], { returnGeneratedKeys: true });
    expect(await ps.getGeneratedKeys().toArray()).toEqual([{ ID: 7 }]);
    // Streaming execute must reset the stale state.
    const rs = await ps.executeForStream(['b']);
    await rs.close();
    expect(await ps.getGeneratedKeys().toArray()).toEqual([]);
  });
});

// ─── fetchSize unit regression (rows, not bytes) ───────────────────────

describe('ResultSet.fetchSize unit safety', () => {
  test('default fetch row count is NOT taken from engine blockingFactor (which is bytes)', async () => {
    // Regression: the engine's OPEN BLOCKING_FACTOR is byte-sized, but the
    // FETCH BLOCKING_FACTOR is row-count. Passing the byte value into
    // ResultSet.fetchSize silently turned later FETCH requests into
    // per-fetch row counts measured in tens of thousands. We assert the
    // default row count stays inside a sane row-based bound regardless of
    // the byte value the engine reported on OPEN.
    const fetchCalls = [];
    const fakeCursorMgr = {
      async fetch(rpbId, rows) {
        fetchCalls.push(rows);
        return [];
      },
    };
    const handle = {
      id: 1, sql: 'SELECT X FROM T',
      paramCount: 0, columnCount: 1,
      paramDescriptors: [],
      columnDescriptors: [{ name: 'X' }],
    };
    const db = {
      async prepareStatement() { return handle; },
      cursorManager: fakeCursorMgr,
      statementManager: {
        async execute() {
          // Engine reports OPEN blockingFactor (bytes) — this MUST NOT
          // become the ResultSet fetchSize.
          return {
            hasResultSet: true,
            rows: [],
            columnDescriptors: handle.columnDescriptors,
            rpbId: 1,
            endOfData: false,
            blockingFactor: 65_536, // 64 KB OPEN block
          };
        },
        async closeStatement() {},
      },
    };
    const ps = new PreparedStatement(db, handle, 'SELECT X FROM T');
    const rs = await ps.executeForStream();
    // Force a fetch.
    await rs.next();
    await rs.close();
    expect(fetchCalls.length).toBeGreaterThan(0);
    // Sanity bound: a row-count default in the low thousands is fine; a
    // byte value of 65_536 is not. Anything ≥ the engine byte default
    // would mean the unit confusion crept back in.
    for (const n of fetchCalls) {
      expect(n).toBeLessThan(10_000);
      expect(n).toBeGreaterThan(0);
    }
  });
});

// ─── cancel() + setQueryTimeout() ──────────────────────────────────────

describe('cancel + setQueryTimeout watchdog', () => {
  function fakeDb({ delayMs = 0 } = {}) {
    return {
      connected: true,
      async prepareStatement() {
        return { id: 1, paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
      },
      cursorManager: { async closeCursor() {}, async fetch() { return []; } },
      statementManager: {
        async execute() {
          if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
          return {
            hasResultSet: false, rows: [], affectedRows: 1,
            columnDescriptors: [], endOfData: true,
            sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
          };
        },
        async closeStatement() {},
      },
      async executeImmediate(sql) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        return {
          affectedRows: 0,
          sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
        };
      },
      async close() {},
    };
  }

  test('PreparedStatement.execute throws HY008 when cancelled before invocation', async () => {
    const db = fakeDb();
    const handle = { id: 1, sql: 'UPDATE T SET X = ?', paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
    const ps = new PreparedStatement(db, handle, 'UPDATE T SET X = ?');
    ps.cancel();
    let err = null;
    try { await ps.execute(['x']); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.name).toBe('SqlError');
    expect(err.messageId ?? err.cause?.messageId ?? '').toMatch(/HY008/);
  });

  test('PreparedStatement.cancel resets after the throw — next execute succeeds', async () => {
    const db = fakeDb();
    const handle = { id: 1, sql: 'UPDATE T SET X = ?', paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
    const ps = new PreparedStatement(db, handle, 'UPDATE T SET X = ?');
    ps.cancel();
    let err = null;
    try { await ps.execute(['x']); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    // Flag was cleared by the throw; next execute must succeed.
    const r = await ps.execute(['y']);
    expect(r.affectedRows).toBe(1);
    expect(ps.isCancelled()).toBe(false);
  });

  test('queryTimeout fires after slow RTT; throw HY008 with watchdog set', async () => {
    const db = fakeDb({ delayMs: 80 });
    const handle = { id: 1, sql: 'UPDATE T SET X = ?', paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
    const ps = new PreparedStatement(db, handle, 'UPDATE T SET X = ?');
    // Timeout is in seconds per JDBC; floor of 1s vs an 80ms RTT
    // would never fire. Use a sub-second timeout via the conversion
    // boundary: setQueryTimeout(1) arms a 1000 ms timer. Make the
    // RTT take 1500 ms so the timer wins.
    ps.setQueryTimeout(1);
    db.statementManager.execute = async () => {
      await new Promise(r => setTimeout(r, 1500));
      return {
        hasResultSet: false, rows: [], affectedRows: 1,
        columnDescriptors: [], endOfData: true,
        sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
      };
    };
    let err = null;
    try { await ps.execute(['x']); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.name).toBe('SqlError');
    expect(err.messageId ?? '').toMatch(/HY008/);
  }, 4000);

  test('queryTimeout = 0 takes the fast path (no watchdog, no error)', async () => {
    // Verify: when timeout is 0, even a slow RTT completes normally.
    const db = fakeDb({ delayMs: 50 });
    const handle = { id: 1, sql: 'UPDATE T SET X = ?', paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
    const ps = new PreparedStatement(db, handle, 'UPDATE T SET X = ?');
    expect(ps.getQueryTimeout()).toBe(0);
    const r = await ps.execute(['x']);
    expect(r.affectedRows).toBe(1);
    expect(ps.isCancelled()).toBe(false);
  });

  test('Statement.execute(sql) honors cancel and timeout', async () => {
    const db = fakeDb();
    const stmt = new Statement(db);
    stmt.cancel();
    let err = null;
    try { await stmt.execute('UPDATE T SET X = 1'); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.name).toBe('SqlError');
    // After throw, cancel is cleared; next execute succeeds.
    const r = await stmt.execute('UPDATE T SET X = 2');
    expect(r.affectedRows).toBe(0);
  });
});

// ─── Automatic SQLCA → warning chain ───────────────────────────────────

describe('Automatic SQLCA-to-warning propagation', () => {
  function makeDb(sqlcaSupplier) {
    return {
      async prepareStatement(sql) {
        return {
          id: 1, sql,
          paramCount: 0, columnCount: 0,
          paramDescriptors: [], columnDescriptors: [],
        };
      },
      cursorManager: { async closeCursor() {}, async fetch() { return []; } },
      statementManager: {
        async execute() {
          return {
            hasResultSet: false,
            rows: [],
            affectedRows: 1,
            columnDescriptors: [],
            endOfData: true,
            sqlca: sqlcaSupplier(),
          };
        },
        async closeStatement() {},
      },
    };
  }

  test('SQLCODE +100 is NOT a warning (end-of-data marker)', async () => {
    const db = makeDb(() => ({
      sqlCode: 100, sqlState: '02000', messageTokens: '',
      sqlwarn: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    }));
    const handle = {
      id: 1, sql: 'INSERT INTO T (X) VALUES (?)',
      paramCount: 1, columnCount: 0,
      paramDescriptors: [], columnDescriptors: [],
    };
    const ps = new PreparedStatement(db, handle, 'INSERT INTO T (X) VALUES (?)');
    await ps.execute(['a']);
    expect(ps.getWarnings()).toBeNull();
  });

  test('SQLCODE > 0 (other than 100) lands on the warning chain', async () => {
    const db = makeDb(() => ({
      sqlCode: 1, sqlState: '01004', messageTokens: 'string truncated',
      sqlwarn: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    }));
    const handle = {
      id: 1, sql: 'UPDATE T SET X = ?',
      paramCount: 1, columnCount: 0,
      paramDescriptors: [], columnDescriptors: [],
    };
    const ps = new PreparedStatement(db, handle, 'UPDATE T SET X = ?');
    await ps.execute(['longstring']);
    const w = ps.getWarnings();
    expect(w).not.toBeNull();
    expect(w.sqlState).toBe('01004');
    expect(w.message).toBe('string truncated');
    expect(w.vendorCode).toBe(1);
  });

  test('sqlwarn bits without a SQLCODE still produce a warning', async () => {
    const db = makeDb(() => ({
      sqlCode: 0, sqlState: '01000', messageTokens: '',
      sqlwarn: [0, 0, 0, 0, 'W'.charCodeAt(0), 0, 0, 0, 0, 0, 0],
    }));
    const handle = {
      id: 1, sql: 'UPDATE T SET X = ?',
      paramCount: 1, columnCount: 0,
      paramDescriptors: [], columnDescriptors: [],
    };
    const ps = new PreparedStatement(db, handle, 'UPDATE T SET X = ?');
    await ps.execute(['x']);
    expect(ps.getWarnings()).not.toBeNull();
  });

  test('Statement.execute(sql) immediate path propagates SQLCA warnings', async () => {
    // Regression: the ad-hoc executeImmediate branch (no generated
    // keys, no params) previously returned without folding the
    // SQLCA warning into the statement chain. It must now do so.
    const db = {
      async executeImmediate(sql) {
        return {
          affectedRows: 1,
          sqlca: {
            sqlCode: 1, sqlState: '01004',
            messageTokens: 'string truncated', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0],
          },
        };
      },
    };
    const stmt = new Statement(db);
    await stmt.execute(`UPDATE T SET X = 'very long string'`);
    const w = stmt.getWarnings();
    expect(w).not.toBeNull();
    expect(w.sqlState).toBe('01004');
    expect(w.vendorCode).toBe(1);
  });

  test('Statement warning chain resets on the next execute', async () => {
    // JTOpen parity: getWarnings() must reflect only THIS execute.
    // Running the same warning-producing query twice must yield a
    // chain of length 1, not 2.
    let kind = 'warn';
    const db = {
      async executeImmediate() {
        if (kind === 'warn') {
          return {
            affectedRows: 1,
            sqlca: { sqlCode: 1, sqlState: '01004', messageTokens: 'truncated', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
          };
        }
        return {
          affectedRows: 1,
          sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
        };
      },
    };
    const stmt = new Statement(db);
    await stmt.execute('UPDATE T SET X = 1');
    expect(stmt.getWarnings()).not.toBeNull();

    // Second warning-producing call: chain length must stay at 1.
    await stmt.execute('UPDATE T SET X = 2');
    let len = 0;
    for (const _ of stmt.getWarnings() ?? []) len++;
    expect(len).toBe(1);

    // Clean call: chain must now be null, not stale.
    kind = 'clean';
    await stmt.execute('UPDATE T SET X = 3');
    expect(stmt.getWarnings()).toBeNull();
  });

  test('PreparedStatement warning chain resets on the next execute', async () => {
    let warning = true;
    const sqlca = () => warning
      ? { sqlCode: 1, sqlState: '01004', messageTokens: 'truncated', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }
      : { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] };
    const db = {
      async prepareStatement() { return { id: 1, paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] }; },
      cursorManager: { async closeCursor() {}, async fetch() { return []; } },
      statementManager: {
        async execute() {
          return { hasResultSet: false, rows: [], affectedRows: 1, columnDescriptors: [], endOfData: true, sqlca: sqlca() };
        },
        async closeStatement() {},
      },
    };
    const handle = {
      id: 1, sql: 'UPDATE T SET X = ?',
      paramCount: 1, columnCount: 0,
      paramDescriptors: [], columnDescriptors: [],
    };
    const ps = new PreparedStatement(db, handle, 'UPDATE T SET X = ?');

    await ps.execute(['a']);
    expect(ps.getWarnings()).not.toBeNull();
    // Second warning-producing call.
    await ps.execute(['b']);
    let len = 0;
    for (const _ of ps.getWarnings() ?? []) len++;
    expect(len).toBe(1);
    // Clean call clears the chain.
    warning = false;
    await ps.execute(['c']);
    expect(ps.getWarnings()).toBeNull();
  });

  test('CallableStatement.getWarnings() reflects a warning-bearing CALL reply', async () => {
    // Regression: CallableStatement previously ignored the inner
    // PreparedStatement's warnings so getWarnings() stayed null even
    // when the host sent a +1 / 01004 back on the CALL reply.
    const conn = {
      async prepare() {
        return {
          async executeCall() {
            return {
              parameterRow: { RESULT: 7 },
              parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
              sqlca: { sqlCode: 1, sqlState: '01004', messageTokens: 'truncated on OUT', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
            };
          },
          getWarnings() {
            // Simulate that PreparedStatement.executeCall() folded
            // the reply warning onto its own chain.
            return new SqlWarning('truncated on OUT', { sqlState: '01004', vendorCode: 1 });
          },
          async close() {},
        };
      },
    };
    const cstmt = new CallableStatement(conn, '{ call MYLIB.WARN(?) }');
    cstmt.registerOutParameter(1, 'integer');
    await cstmt.execute();
    const w = cstmt.getWarnings();
    expect(w).not.toBeNull();
    expect(w.sqlState).toBe('01004');
    expect(w.message).toBe('truncated on OUT');
  });

  test('CallableStatement warning chain clears between executes', async () => {
    let warning = true;
    const conn = {
      async prepare() {
        return {
          async executeCall() {
            return {
              parameterRow: { RESULT: 7 },
              parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
              sqlca: warning
                ? { sqlCode: 1, sqlState: '01004', messageTokens: 'w', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }
                : { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
            };
          },
          getWarnings() {
            return warning ? new SqlWarning('w', { sqlState: '01004', vendorCode: 1 }) : null;
          },
          async close() {},
        };
      },
    };
    const cstmt = new CallableStatement(conn, '{ call MYLIB.P(?) }');
    cstmt.registerOutParameter(1, 'integer');
    await cstmt.execute();
    expect(cstmt.getWarnings()).not.toBeNull();
    warning = false;
    await cstmt.execute();
    expect(cstmt.getWarnings()).toBeNull();
  });

  test('Statement.executeBatch() folds per-element SQLCA warnings', async () => {
    const sqlcas = [
      { sqlCode: 1, sqlState: '01004', messageTokens: 'truncated on row 0', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
      { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
      { sqlCode: 1, sqlState: '01004', messageTokens: 'truncated on row 2', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
    ];
    let idx = 0;
    const db = {
      async executeImmediate() {
        return { affectedRows: 1, sqlca: sqlcas[idx++] };
      },
    };
    const stmt = new Statement(db);
    stmt.addBatch('UPDATE T SET X = 1');
    stmt.addBatch('UPDATE T SET X = 2');
    stmt.addBatch('UPDATE T SET X = 3');
    await stmt.executeBatch();
    let len = 0;
    for (const _ of stmt.getWarnings() ?? []) len++;
    // Two warning-bearing rows → two warnings on the chain.
    expect(len).toBe(2);
  });

  test('Connection.execute(sql) immediate path folds SQLCA warning onto the connection chain', async () => {
    const db = {
      connected: true,
      async prepareStatement() { throw new Error('should not prepare'); },
      cursorManager: { async closeCursor() {} },
      statementManager: { async execute() { throw new Error('should not execute'); } },
      async executeImmediate() {
        return {
          affectedRows: 0,
          sqlca: { sqlCode: 1, sqlState: '01004', messageTokens: 'truncated', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
        };
      },
      async commit() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async rollback() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async close() {},
    };
    const conn = new Connection(db);
    await conn.execute(`UPDATE T SET X = 'long'`);
    const w = conn.getWarnings();
    expect(w).not.toBeNull();
    expect(w.sqlState).toBe('01004');
  });

  test('Connection.commit() folds reply SQLCA warning onto the connection chain', async () => {
    let commitWarn = true;
    const db = {
      connected: true,
      async prepareStatement() { throw new Error('should not prepare'); },
      cursorManager: { async closeCursor() {} },
      statementManager: { async execute() {} },
      async executeImmediate() { return { affectedRows: 0, sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] } }; },
      async commit() {
        return commitWarn
          ? { sqlCode: 1, sqlState: '01002', messageTokens: 'commit warning', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }
          : { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] };
      },
      async rollback() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async close() {},
    };
    const conn = new Connection(db);
    await conn.commit();
    expect(conn.getWarnings()).not.toBeNull();
    expect(conn.getWarnings().sqlState).toBe('01002');
    // Connection warnings are CUMULATIVE (per JDBC), unlike Statement
    // warnings — a second op should append, not reset.
    await conn.commit();
    let len = 0;
    for (const _ of conn.getWarnings() ?? []) len++;
    expect(len).toBe(2);
    // clearWarnings() resets the chain explicitly.
    conn.clearWarnings();
    expect(conn.getWarnings()).toBeNull();
    // Clean commit after clear leaves chain null (no false positive).
    commitWarn = false;
    await conn.commit();
    expect(conn.getWarnings()).toBeNull();
  });

  test('Connection.rollback() folds reply SQLCA warning onto the connection chain', async () => {
    const db = {
      connected: true,
      async prepareStatement() {},
      cursorManager: { async closeCursor() {} },
      statementManager: { async execute() {} },
      async executeImmediate() { return { affectedRows: 0, sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] } }; },
      async commit() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async rollback() {
        return { sqlCode: 1, sqlState: '01002', messageTokens: 'rollback warn', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] };
      },
      async close() {},
    };
    const conn = new Connection(db);
    await conn.rollback();
    expect(conn.getWarnings()).not.toBeNull();
    expect(conn.getWarnings().message).toBe('rollback warn');
  });

  test('Connection.execute(sql, params) drains inner PreparedStatement warnings', async () => {
    const db = {
      connected: true,
      async prepareStatement() {
        return { id: 1, paramCount: 1, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
      },
      cursorManager: { async closeCursor() {} },
      statementManager: {
        async execute() {
          return {
            hasResultSet: false,
            rows: [],
            affectedRows: 1,
            columnDescriptors: [],
            endOfData: true,
            sqlca: { sqlCode: 1, sqlState: '01004', messageTokens: 'inner warn', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
          };
        },
        async closeStatement() {},
      },
      async executeImmediate() { throw new Error('should not hit immediate path'); },
      async close() {},
    };
    const conn = new Connection(db);
    await conn.execute('UPDATE T SET X = ?', ['v']);
    const w = conn.getWarnings();
    expect(w).not.toBeNull();
    expect(w.sqlState).toBe('01004');
    expect(w.message).toBe('inner warn');
  });

  test('Connection.savepoint() preserves the Savepoint return value and folds reply SQLCA warning', async () => {
    const sp = { id: 7, name: 'SP_WARN' };
    const db = {
      connected: true,
      async prepareStatement() {},
      cursorManager: { async closeCursor() {} },
      statementManager: { async execute() {} },
      async executeImmediate() { return { affectedRows: 0, sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] } }; },
      async commit() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async rollback() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async setSavepoint() {
        return {
          savepoint: sp,
          sqlca: { sqlCode: 1, sqlState: '01004', messageTokens: 'savepoint warn', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
        };
      },
      async close() {},
    };
    const conn = new Connection(db);
    const actual = await conn.savepoint('SP_WARN');
    expect(actual).toBe(sp);
    expect(conn.getWarnings()).not.toBeNull();
    expect(conn.getWarnings().message).toBe('savepoint warn');
  });

  test('Connection.rollback(savepoint) folds reply SQLCA warning onto the connection chain', async () => {
    const db = {
      connected: true,
      async prepareStatement() {},
      cursorManager: { async closeCursor() {} },
      statementManager: { async execute() {} },
      async executeImmediate() { return { affectedRows: 0, sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] } }; },
      async commit() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async rollback() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async rollbackToSavepoint() {
        return { sqlCode: 1, sqlState: '01002', messageTokens: 'rollback savepoint warn', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] };
      },
      async close() {},
    };
    const conn = new Connection(db);
    await conn.rollback({ id: 1, name: 'SP1' });
    expect(conn.getWarnings()).not.toBeNull();
    expect(conn.getWarnings().message).toBe('rollback savepoint warn');
  });

  test('Connection.releaseSavepoint() folds reply SQLCA warning onto the connection chain', async () => {
    const db = {
      connected: true,
      async prepareStatement() {},
      cursorManager: { async closeCursor() {} },
      statementManager: { async execute() {} },
      async executeImmediate() { return { affectedRows: 0, sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] } }; },
      async commit() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async rollback() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async releaseSavepoint() {
        return { sqlCode: 1, sqlState: '01002', messageTokens: 'release savepoint warn', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] };
      },
      async close() {},
    };
    const conn = new Connection(db);
    await conn.releaseSavepoint({ id: 1, name: 'SP1' });
    expect(conn.getWarnings()).not.toBeNull();
    expect(conn.getWarnings().message).toBe('release savepoint warn');
  });

  test('Connection.setSchema() folds reply SQLCA warning from direct executeImmediate control statements', async () => {
    const executedSql = [];
    const db = {
      connected: true,
      async prepareStatement() {},
      cursorManager: { async closeCursor() {} },
      statementManager: { async execute() {} },
      libraryList: { defaultSchema: '' },
      async executeImmediate(sql) {
        executedSql.push(sql);
        return {
          affectedRows: 0,
          sqlca: { sqlCode: 1, sqlState: '01004', messageTokens: 'schema warn', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] },
        };
      },
      async commit() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async rollback() { return { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] }; },
      async close() {},
    };
    const conn = new Connection(db);
    await conn.setSchema('MYLIB');
    expect(executedSql).toEqual(['SET SCHEMA "MYLIB"']);
    expect(conn.getWarnings()).not.toBeNull();
    expect(conn.getWarnings().message).toBe('schema warn');
  });

  test('clean SQLCA leaves the warning chain untouched (no fast-path cost)', async () => {
    const db = makeDb(() => ({
      sqlCode: 0, sqlState: '00000', messageTokens: '',
      sqlwarn: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    }));
    const handle = {
      id: 1, sql: 'UPDATE T SET X = ?',
      paramCount: 1, columnCount: 0,
      paramDescriptors: [], columnDescriptors: [],
    };
    const ps = new PreparedStatement(db, handle, 'UPDATE T SET X = ?');
    await ps.execute(['x']);
    expect(ps.getWarnings()).toBeNull();
  });
});

// ─── CallableStatement protocol-level OUT decode ───────────────────────

describe('CallableStatement protocol-level OUT decode', () => {
  /**
   * Build a mock connection whose prepare() returns a stub
   * PreparedStatement-like object. The stub's `executeCall()` returns a
   * fixed `parameterRow` to stand in for engine-layer 0x380E decode; the
   * stub's `executeForStream()` records how many times it was called so
   * tests can assert "no full result-set materialization on the fast
   * path" as a counter-based regression.
   */
  function makeConn({ parameterRow, parameterDescriptors = [], fallbackRows = null }) {
    const counters = { executeCall: 0, executeForStream: 0, prepared: 0, closed: 0 };
    const conn = {
      async prepare(sql) {
        counters.prepared++;
        return {
          async executeCall() {
            counters.executeCall++;
            return {
              hasResultSet: false,
              parameterRow,
              parameterDescriptors,
              affectedRows: 1,
              sqlca: { sqlCode: 0, rowCount: 0 },
            };
          },
          async executeForStream() {
            counters.executeForStream++;
            const rows = fallbackRows || [];
            return {
              columns: parameterDescriptors.length > 0
                ? parameterDescriptors
                : Object.keys(rows[0] || {}).map((name, index) => ({ index, name })),
              async toArray() { return rows; },
              async close() {},
            };
          },
          async close() { counters.closed++; },
        };
      },
    };
    return { conn, counters };
  }

  test('OUT value decoded from parameterRow — named descriptor', async () => {
    const { conn, counters } = makeConn({
      parameterRow: { RESULT: 42 },
      parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
    });
    const cstmt = new CallableStatement(conn, 'LIB.P1');
    cstmt.registerOutParameter(1, 'integer');
    await cstmt.execute();
    expect(cstmt.getInt(1)).toBe(42);
    expect(cstmt.wasNull()).toBe(false);
    // Counter regression: protocol path MUST NOT fall through to
    // executeForStream()/toArray() — that would re-materialize a whole
    // result set for every CALL even when the server returned the
    // values inline.
    expect(counters.executeCall).toBe(1);
    expect(counters.executeForStream).toBe(0);
    expect(counters.closed).toBe(1);
  });

  test('OUT value decoded positionally when parameter descriptor name is blank', async () => {
    // Parameter descriptors parsed from code point 0x3808 often carry
    // empty `name` strings. decodeResultData keys those columns as
    // `col${desc.index}`, so the CallableStatement must use the same
    // positional fallback.
    const { conn } = makeConn({
      parameterRow: { col0: 'alpha', col1: 99 },
      parameterDescriptors: [
        { index: 0, name: '', sqlType: 448 },
        { index: 1, name: '', sqlType: 496 },
      ],
    });
    const cstmt = new CallableStatement(conn, 'LIB.P2');
    cstmt.registerOutParameter(1, 'varchar');
    cstmt.registerOutParameter(2, 'integer');
    await cstmt.execute();
    expect(cstmt.getString(1)).toBe('alpha');
    expect(cstmt.getInt(2)).toBe(99);
  });

  test('INOUT slot populated from parameterRow', async () => {
    const { conn } = makeConn({
      parameterRow: { X: 200 },
      parameterDescriptors: [{ index: 0, name: 'X', sqlType: 496 }],
    });
    const cstmt = new CallableStatement(conn, 'LIB.DOUBLE_IT');
    cstmt.setInt(1, 100);
    cstmt.registerOutParameter(1, 'integer'); // promotes to INOUT
    await cstmt.execute();
    expect(cstmt.getInt(1)).toBe(200);
  });

  test('null OUT value from parameterRow sets wasNull()', async () => {
    const { conn } = makeConn({
      parameterRow: { RESULT: null },
      parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 448 }],
    });
    const cstmt = new CallableStatement(conn, 'LIB.P3');
    cstmt.registerOutParameter(1, 'varchar');
    await cstmt.execute();
    expect(cstmt.getString(1)).toBeNull();
    expect(cstmt.wasNull()).toBe(true);
  });

  test('CALL with OUT params + 2 result sets — getMoreResults() advances real ResultSet objects', async () => {
    // Streaming-style multi-result-set support: each secondary
    // 0x380E block surfaces as its own group via
    // `resultSetGroups`. CallableStatement queues a real ResultSet
    // per group; getResultSet() returns the head; getMoreResults()
    // advances to the next.
    const conn = {
      async prepare() {
        return {
          async executeCall() {
            return {
              hasResultSet: false,
              parameterRow: { RESULT: 99 },
              parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
              resultSetGroups: [
                { rows: [{ A: 1 }, { A: 2 }], descriptors: [{ index: 0, name: 'A', sqlType: 496 }] },
                { rows: [{ B: 'x' }],          descriptors: [{ index: 0, name: 'B', sqlType: 448 }] },
              ],
              sqlca: { sqlCode: 0, rowCount: 0 },
            };
          },
          async close() {},
        };
      },
    };
    const cstmt = new CallableStatement(conn, '{ call MYLIB.MULTI(?) }');
    cstmt.registerOutParameter(1, 'integer');
    await cstmt.execute();
    expect(cstmt.getInt(1)).toBe(99);

    const first = cstmt.getResultSet();
    expect(first).not.toBeNull();
    expect(await first.toArray()).toEqual([{ A: 1 }, { A: 2 }]);
    expect(first.getMetaData().getColumnCount()).toBe(1);

    expect(await cstmt.getMoreResults()).toBe(true);
    const second = cstmt.getResultSet();
    expect(await second.toArray()).toEqual([{ B: 'x' }]);

    expect(await cstmt.getMoreResults()).toBe(false);
    expect(cstmt.getResultSet()).toBeNull();
  });

  test('CALL multi-result CLOSE_ALL_RESULTS drains every queued ResultSet', async () => {
    const { CLOSE_ALL_RESULTS } = await import('../../src/db/api/Statement.js');
    const conn = {
      async prepare() {
        return {
          async executeCall() {
            return {
              parameterRow: { RESULT: 1 },
              parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
              resultSetGroups: [
                { rows: [{ A: 1 }], descriptors: [{ index: 0, name: 'A', sqlType: 496 }] },
                { rows: [{ B: 2 }], descriptors: [{ index: 0, name: 'B', sqlType: 496 }] },
                { rows: [{ C: 3 }], descriptors: [{ index: 0, name: 'C', sqlType: 496 }] },
              ],
              sqlca: { sqlCode: 0, rowCount: 0 },
            };
          },
          async close() {},
        };
      },
    };
    const cstmt = new CallableStatement(conn, '{ call MYLIB.MANY(?) }');
    cstmt.registerOutParameter(1, 'integer');
    await cstmt.execute();
    // After CLOSE_ALL_RESULTS, every queued ResultSet is closed and
    // getResultSet() returns null.
    expect(await cstmt.getMoreResults(CLOSE_ALL_RESULTS)).toBe(false);
    expect(cstmt.getResultSet()).toBeNull();
    // Subsequent getMoreResults() also returns false.
    expect(await cstmt.getMoreResults()).toBe(false);
  });

  test('CALL multi-result KEEP_CURRENT_RESULT leaves the prior ResultSet open', async () => {
    const { KEEP_CURRENT_RESULT } = await import('../../src/db/api/Statement.js');
    const conn = {
      async prepare() {
        return {
          async executeCall() {
            return {
              parameterRow: { RESULT: 1 },
              parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
              resultSetGroups: [
                { rows: [{ A: 1 }], descriptors: [{ index: 0, name: 'A', sqlType: 496 }] },
                { rows: [{ B: 2 }], descriptors: [{ index: 0, name: 'B', sqlType: 496 }] },
              ],
              sqlca: { sqlCode: 0, rowCount: 0 },
            };
          },
          async close() {},
        };
      },
    };
    const cstmt = new CallableStatement(conn, '{ call MYLIB.HOLD(?) }');
    cstmt.registerOutParameter(1, 'integer');
    await cstmt.execute();
    const head = cstmt.getResultSet();
    expect(head).not.toBeNull();
    expect(await cstmt.getMoreResults(KEEP_CURRENT_RESULT)).toBe(true);
    // The prior ResultSet is NOT closed because KEEP_CURRENT_RESULT
    // hands ownership to the caller.
    expect(head.closed).toBe(false);
    await head.close();
  });

  test('Re-executing a CallableStatement clears the prior result-set queue', async () => {
    let callNum = 0;
    const conn = {
      async prepare() {
        return {
          async executeCall() {
            callNum++;
            return {
              parameterRow: { RESULT: callNum },
              parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
              resultSetGroups: callNum === 1
                ? [
                    { rows: [{ A: 1 }, { A: 2 }], descriptors: [{ index: 0, name: 'A', sqlType: 496 }] },
                    { rows: [{ B: 9 }],           descriptors: [{ index: 0, name: 'B', sqlType: 496 }] },
                  ]
                : [],
              sqlca: { sqlCode: 0, rowCount: 0 },
            };
          },
          async close() {},
        };
      },
    };
    const cstmt = new CallableStatement(conn, '{ call MYLIB.RESET(?) }');
    cstmt.registerOutParameter(1, 'integer');
    await cstmt.execute();
    expect(cstmt.getResultSet()).not.toBeNull();
    // Re-execute: queue must be drained; the second call has no
    // result sets so getResultSet() is null.
    await cstmt.execute();
    expect(cstmt.getResultSet()).toBeNull();
    expect(await cstmt.getMoreResults()).toBe(false);
  });

  test('CALL with OUT params + result-set descriptor — rows are decoded', async () => {
    // When the engine surfaces `resultSetRows` (meaning a descriptor
    // arrived inline with the CALL reply), the CallableStatement
    // exposes those rows directly on `result.resultSets[0]` — not as
    // raw buffers.
    const conn = {
      async prepare() {
        return {
          async executeCall() {
            return {
              hasResultSet: false,
              parameterRow: { RESULT: 7 },
              parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
              resultSetRows: [{ COL1: 'a' }, { COL1: 'b' }],
              resultSetDescriptors: [{ index: 0, name: 'COL1', sqlType: 448 }],
              affectedRows: 0,
              sqlca: { sqlCode: 0, rowCount: 0 },
            };
          },
          async close() {},
        };
      },
    };
    const cstmt = new CallableStatement(conn, '{ call MYLIB.RS(?) }');
    cstmt.registerOutParameter(1, 'integer');
    const r = await cstmt.execute();
    expect(cstmt.getInt(1)).toBe(7);
    expect(r.resultSets.length).toBe(1);
    expect(Array.isArray(r.resultSets[0])).toBe(true);
    expect(r.resultSets[0]).toEqual([{ COL1: 'a' }, { COL1: 'b' }]);
  });

  test('CALL with OUT params + extra result-set buffers — buffers surfaced (partial)', async () => {
    // Documenting behavior: when the engine reports `extraResultBuffers`
    // alongside parameterRow, CallableStatement surfaces them via
    // resultSets in raw form — full descriptor-driven decoding is still
    // staged. The regression locks in the deterministic surface so a
    // future protocol pass can detect the change cleanly.
    const conn = {
      async prepare() {
        return {
          async executeCall() {
            return {
              hasResultSet: false,
              parameterRow: { RESULT: 5 },
              parameterDescriptors: [{ index: 0, name: 'RESULT', sqlType: 496 }],
              extraResultBuffers: [Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])],
              affectedRows: 0,
              sqlca: { sqlCode: 0, rowCount: 0 },
            };
          },
          async close() {},
        };
      },
    };
    const cstmt = new CallableStatement(conn, '{ call MYLIB.MIXED(?) }');
    cstmt.registerOutParameter(1, 'integer');
    const r = await cstmt.execute();
    expect(cstmt.getInt(1)).toBe(5);
    expect(r.resultSets.length).toBe(1);
    expect(r.resultSets[0].__raw?.length).toBe(1);
    expect(r.resultSets[0].note).toMatch(/result set alongside OUT/);
  });

  test('fallback to result-set heuristic when parameterRow is absent', async () => {
    // Older servers or procedures that emit OUT via VALUES() do not
    // produce a parameterRow. The fallback scans the first (and only)
    // result-set row, preserving the prior behavior.
    const { conn, counters } = makeConn({
      parameterRow: null,
      parameterDescriptors: [],
      fallbackRows: [{ RESULT: 7 }],
    });
    const cstmt = new CallableStatement(conn, 'LIB.P4');
    cstmt.setParameterName(1, 'RESULT');
    cstmt.registerOutParameter(1, 'integer');
    await cstmt.execute();
    expect(cstmt.getInt(1)).toBe(7);
    // Fallback path must call executeForStream exactly once.
    expect(counters.executeCall).toBe(1);
    expect(counters.executeForStream).toBe(1);
  });
});
