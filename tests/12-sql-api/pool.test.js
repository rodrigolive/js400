/**
 * Tests for ConnectionPool.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { ConnectionPool } from '../../src/db/pool/ConnectionPool.js';

function createMockConnection(id) {
  let closed = false;
  return {
    id,
    closed: false,
    async query(sql) { return [{ result: id }]; },
    async execute(sql) { return { affectedRows: 1 }; },
    async close() { closed = true; this.closed = true; },
    _isClosed() { return closed; },
  };
}

let connectionCounter = 0;
function mockConnectFn() {
  return Promise.resolve(createMockConnection(++connectionCounter));
}

describe('ConnectionPool', () => {
  let pool;

  afterEach(async () => {
    if (pool && !pool.closed) {
      await pool.close();
    }
    connectionCounter = 0;
  });

  test('creates pool with defaults', () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    expect(pool.size).toBe(0);
    expect(pool.available).toBe(0);
    expect(pool.activeCount).toBe(0);
    expect(pool.closed).toBe(false);
  });

  test('getConnection() creates a new connection', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    const conn = await pool.getConnection();
    expect(conn).toBeDefined();
    expect(conn.id).toBe(1);
    expect(pool.activeCount).toBe(1);
    pool.release(conn);
  });

  test('release() returns connection to pool', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    const conn = await pool.getConnection();
    expect(pool.activeCount).toBe(1);
    expect(pool.available).toBe(0);

    pool.release(conn);
    expect(pool.activeCount).toBe(0);
    expect(pool.available).toBe(1);
  });

  test('getConnection() reuses released connections', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    const conn1 = await pool.getConnection();
    pool.release(conn1);

    const conn2 = await pool.getConnection();
    expect(conn2.id).toBe(conn1.id);
    pool.release(conn2);
  });

  test('respects max pool size', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, max: 2, idleTimeout: 0 });

    const conn1 = await pool.getConnection();
    const conn2 = await pool.getConnection();
    expect(pool.size).toBe(2);

    // Release one so the third request can be served
    pool.release(conn1);

    const conn3 = await pool.getConnection();
    expect(conn3.id).toBe(conn1.id); // reused
    pool.release(conn2);
    pool.release(conn3);
  });

  test('query() shorthand acquires, queries, and releases', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    const rows = await pool.query('SELECT 1');
    expect(rows).toEqual([{ result: 1 }]);
    expect(pool.available).toBe(1);
    expect(pool.activeCount).toBe(0);
  });

  test('execute() shorthand', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    const result = await pool.execute('UPDATE T SET X = 1');
    expect(result.affectedRows).toBe(1);
    expect(pool.available).toBe(1);
  });

  test('close() shuts down pool', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    const conn = await pool.getConnection();
    pool.release(conn);

    await pool.close();
    expect(pool.closed).toBe(true);
    expect(pool.available).toBe(0);
  });

  test('close() is idempotent', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    await pool.close();
    await pool.close(); // should not throw
  });

  test('getConnection() throws after close', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    await pool.close();

    try {
      await pool.getConnection();
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err.message).toContain('closed');
    }
  });

  test('validateOnCheckout validates connections', async () => {
    let queryCount = 0;
    let failNext = false;

    const customConnect = () => {
      const conn = createMockConnection(++connectionCounter);
      conn.query = async () => {
        queryCount++;
        if (failNext) throw new Error('Connection dead');
        return [{ ok: 1 }];
      };
      return Promise.resolve(conn);
    };

    pool = new ConnectionPool({
      connect: customConnect,
      validateOnCheckout: true,
      validationQuery: 'VALUES 1',
      idleTimeout: 0,
    });

    // First connection
    const conn1 = await pool.getConnection();
    pool.release(conn1);

    // Mark for validation failure
    failNext = true;

    // Should create a new connection since the first one fails validation
    const conn2 = await pool.getConnection();
    expect(conn2.id).not.toBe(conn1.id);
    pool.release(conn2);
  });

  test('warmup() fills pool to min size', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, min: 3, max: 10, idleTimeout: 0 });
    await pool.warmup();
    expect(pool.available).toBe(3);
    expect(pool.size).toBe(3);
  });

  test('release() on closed pool closes the connection', async () => {
    pool = new ConnectionPool({ connect: mockConnectFn, idleTimeout: 0 });
    const conn = await pool.getConnection();
    await pool.close();
    pool.release(conn); // should close the connection, not throw
  });

  test('throws if no connect function', async () => {
    pool = new ConnectionPool({ idleTimeout: 0 });
    try {
      await pool.getConnection();
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toContain('No connect function');
    }
  });
});
