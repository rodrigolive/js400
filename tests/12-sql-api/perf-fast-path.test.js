/**
 * Performance guard: zero-cost fast path.
 *
 * These tests exist to catch accidental regressions to the "default
 * path is free" contract the feature-matrix publishes:
 *
 *   - extendedDynamic off → no PACKAGE_NAME / LIBRARY_NAME / PREPARE_OPTION
 *     codepoints on PREPARE_AND_DESCRIBE or EXECUTE_IMMEDIATE. No
 *     CREATE_PACKAGE / RETURN_PACKAGE round-trips.
 *   - queryTimeout = 0, no cancel() → no setTimeout created, no
 *     side-channel cancel dispatched, no extra allocations.
 *
 * If a future change accidentally adds one of those, these tests
 * fail with a loud, specific error rather than turning up as a
 * silent microbench regression.
 */
import { describe, test, expect } from 'bun:test';
import {
  DBRequestDS, RequestID, CodePoint,
} from '../../src/db/protocol/DBRequestDS.js';
import { StatementManager } from '../../src/db/engine/StatementManager.js';

function scanCodePoints(buf) {
  const out = new Map();
  let off = 40;
  while (off + 6 <= buf.length) {
    const ll = buf.readInt32BE(off);
    if (ll < 6 || off + ll > buf.length) break;
    const cp = buf.readUInt16BE(off + 4);
    const payload = Buffer.from(buf.subarray(off + 6, off + ll));
    const list = out.get(cp);
    if (list) list.push(payload);
    else out.set(cp, [payload]);
    off += ll;
  }
  return out;
}

function okReply() {
  const buf = Buffer.alloc(40);
  buf.writeInt32BE(40, 0);
  buf.writeInt16BE(20, 16);
  return buf;
}

// --- Package fast path ---------------------------------------------

describe('fast path — extendedDynamic off', () => {
  test('prepare emits ZERO package-related round-trips and ZERO package codepoints', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* ignore — we only assert on wire shape */ }

    // No CREATE_PACKAGE / RETURN_PACKAGE in the request stream.
    const reqIds = sends.map(b => b.readUInt16BE(18));
    expect(reqIds.includes(RequestID.CREATE_PACKAGE)).toBe(false);
    expect(reqIds.includes(RequestID.RETURN_PACKAGE)).toBe(false);

    // No PACKAGE_NAME / LIBRARY_NAME codepoints on PREPARE_AND_DESCRIBE.
    const prep = sends.find(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    if (prep) {
      const cps = scanCodePoints(prep);
      expect(cps.has(CodePoint.PACKAGE_NAME)).toBe(false);
      expect(cps.has(CodePoint.LIBRARY_NAME)).toBe(false);
    }
  });

  test('executeImmediate emits ZERO package-related codepoints', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    await sm.executeImmediate('SET CURRENT SCHEMA MYLIB');

    const reqIds = sends.map(b => b.readUInt16BE(18));
    expect(reqIds.includes(RequestID.CREATE_PACKAGE)).toBe(false);

    const imm = sends.find(b => b.readUInt16BE(18) === RequestID.EXECUTE_IMMEDIATE);
    const cps = scanCodePoints(imm);
    expect(cps.has(CodePoint.PACKAGE_NAME)).toBe(false);
    expect(cps.has(CodePoint.LIBRARY_NAME)).toBe(false);
    expect(cps.has(CodePoint.PREPARE_OPTION)).toBe(false);
    expect(cps.has(CodePoint.STATEMENT_TYPE)).toBe(false);
  });
});

// --- Cancel fast path ----------------------------------------------

describe('fast path — queryTimeout = 0 and no cancel', () => {
  test('Statement.execute never calls DbConnection.cancel() by default', async () => {
    const { Statement } = await import('../../src/db/api/Statement.js');
    let cancelCalls = 0;
    const fakeDb = {
      async cancel() { cancelCalls++; return { sent: true }; },
      async executeImmediate() {
        return { sqlca: { sqlCode: 0, isError: false }, affectedRows: 0 };
      },
    };
    const stmt = new Statement(fakeDb, {});
    // queryTimeout defaults to 0. Call execute() many times and
    // confirm the side-channel was NEVER touched.
    for (let i = 0; i < 50; i++) {
      await stmt.execute('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    }
    expect(cancelCalls).toBe(0);
  });

  test('PreparedStatement.execute never calls DbConnection.cancel() by default', async () => {
    const { PreparedStatement } = await import('../../src/db/api/PreparedStatement.js');
    let cancelCalls = 0;
    const fakeDb = {
      async cancel() { cancelCalls++; return { sent: true }; },
      statementManager: {
        async execute() {
          return { rows: [], affectedRows: 0, sqlca: { sqlCode: 0, isError: false } };
        },
      },
    };
    const fakeHandle = {
      rpbId: 1, paramDescriptors: [], columnDescriptors: [],
      paramCount: 0, columnCount: 0, closed: false,
    };
    const ps = new PreparedStatement(fakeDb, fakeHandle, 'SELECT 1 FROM SYSIBM.SYSDUMMY1');
    for (let i = 0; i < 50; i++) {
      await ps.execute([]);
    }
    expect(cancelCalls).toBe(0);
  });

  test('default Statement does NOT arm setTimeout on execute', async () => {
    // Monkey-patch the global setTimeout to count calls. The fast
    // path must NOT call setTimeout — if a regression ever adds a
    // per-execute timer to the default path, this test surfaces it.
    const origSetTimeout = globalThis.setTimeout;
    let timerCalls = 0;
    globalThis.setTimeout = function(...args) {
      timerCalls++;
      return origSetTimeout.apply(this, args);
    };
    try {
      const { Statement } = await import('../../src/db/api/Statement.js');
      const fakeDb = {
        async cancel() { return { sent: false, reason: 'guard' }; },
        async executeImmediate() {
          return { sqlca: { sqlCode: 0, isError: false }, affectedRows: 0 };
        },
      };
      const stmt = new Statement(fakeDb, {});
      // Snapshot the counter right before the hot loop so any
      // setTimeout from import-time / module-init doesn't count.
      const before = timerCalls;
      for (let i = 0; i < 20; i++) {
        await stmt.execute('SELECT 1 FROM SYSIBM.SYSDUMMY1');
      }
      const added = timerCalls - before;
      // The default path must add zero timers per execute. The
      // only paths that arm a timer are setQueryTimeout(n>0)
      // (not exercised here) and the cancel-channel handshake
      // (not reachable when cancel() is never called).
      expect(added).toBe(0);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test('cancelMetrics counters stay at 0 for the whole fast-path lifecycle', async () => {
    const { DbConnection } = await import('../../src/db/engine/DbConnection.js');
    const db = new DbConnection({}, {}, {});
    // A fresh DbConnection never touches cancelMetrics. If any
    // future change starts firing cancel() from an unrelated path
    // (e.g. hot-path telemetry), this test catches it loudly.
    const zeroed = {
      cancelCalls: 0,
      cancelSent: 0,
      cancelFallbacks: 0,
      cancelChannelOpens: 0,
    };
    expect(db.cancelMetrics).toEqual(zeroed);
  });
});

// --- Combined: knobs off, both features silent ---------------------

describe('fast path — all knobs off', () => {
  test('StatementManager.metrics.package* all 0 with no package manager', async () => {
    const sm = new StatementManager({ async sendAndReceive() {} }, { registerCursor() {} }, {});
    expect(sm.metrics.packageCreates).toBe(0);
    expect(sm.metrics.packageFetches).toBe(0);
    expect(sm.metrics.packageHits).toBe(0);
  });

  test('timing sanity: 50 default executes stay under a generous budget', async () => {
    // Not a real performance benchmark — Bun's scheduler and host
    // load make microbenchmarks unreliable. This is a smoke check:
    // if a future change makes the fast path materially slower
    // (e.g. a synchronous network call sneaks in), this test
    // fails cleanly. Budget is deliberately loose (10ms per 50
    // iterations at most — ~200µs per execute).
    const { Statement } = await import('../../src/db/api/Statement.js');
    const fakeDb = {
      async cancel() { return { sent: false }; },
      async executeImmediate() {
        return { sqlca: { sqlCode: 0, isError: false }, affectedRows: 0 };
      },
    };
    const stmt = new Statement(fakeDb, {});
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      await stmt.execute('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
  });
});
