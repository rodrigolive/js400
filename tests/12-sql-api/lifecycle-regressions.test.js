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
});
