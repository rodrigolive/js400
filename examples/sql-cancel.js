/**
 * SQL cancel / query timeout example.
 *
 * Demonstrates Statement.cancel() and setQueryTimeout with
 * wire-level FUNCTIONID_CANCEL (0x1818) dispatched on a side-channel
 * DATABASE connection. The js400 port mirrors JTOpen's
 * AS400JDBCConnectionImpl.cancel + AS400JDBCQueryCancelThread:
 *
 *   - `cancel()` fires-and-forgets a cancel on a second DB socket,
 *     identified by the server's JOB_IDENTIFIER (26-char string
 *     captured during the exchange-attributes handshake).
 *   - `setQueryTimeout(n)` arms a client-side watchdog; on expiry
 *     it fires the same wire cancel AND flips a local flag so the
 *     next operation throws SqlError(HY008).
 *   - When the side channel can't open (server < functional level
 *     5, job identifier missing, refused socket), the cancel falls
 *     back gracefully to the post-RTT HY008 path — the app still
 *     sees the timeout, it just has to wait for the natural RTT
 *     finish.
 *
 * Fast-path contract: `queryTimeout = 0` and no explicit cancel()
 * pays TWO boolean checks per execute — no timer, no side channel,
 * no allocation.
 *
 * JTOpen upstream:
 *   - AS400JDBCConnectionImpl.cancel (side channel + job id cancel)
 *   - AS400JDBCQueryCancelThread (watchdog)
 *   - DBSQLRequestDS.setJobIdentifier (0x3826)
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-cancel.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-cancel.js
 */

import { sql } from 'js400';
import { SqlError } from 'js400';

const host = process.env.JS400_HOST;
const user = process.env.JS400_USER;
const password = process.env.JS400_PASS;

if (!host || !user || !password) {
  console.error('Set JS400_HOST, JS400_USER, and JS400_PASS environment variables.');
  process.exit(1);
}

const conn = await sql.connect({ host, user, password });
const db = conn.dbConnection;

console.log('Cancel capability:');
console.log(`  serverFunctionalLevel: ${db.serverFunctionalLevel}`);
console.log(`  serverJobIdentifier:   ${db.serverJobIdentifier || '<unknown>'}`);
console.log(`  canCancelOnWire():     ${db.canCancelOnWire()}`);
console.log('');

try {
  // ---- Example 1: setQueryTimeout on a Statement ----
  //
  // Build a synthetic slow query using a recursive CTE so we don't
  // need any state on the host. A 2-second timeout will expire
  // before the recursion finishes.
  const stmt = conn.createStatement();
  stmt.setQueryTimeout(2);
  console.log('Example 1: setQueryTimeout(2) on a long-running query');
  try {
    await stmt.executeQuery(`
      WITH RECURSIVE T (N) AS (
        SELECT 1 FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT N + 1 FROM T WHERE N < 5000000
      )
      SELECT COUNT(*) FROM T
    `);
    console.log('  (query finished before the watchdog fired)');
  } catch (err) {
    if (err instanceof SqlError && (err.messageId === 'HY008' || /HY008/.test(err.message))) {
      console.log(`  timed out → ${err.message}`);
    } else {
      throw err;
    }
  }
  await stmt.close();

  // Observe whether the side channel actually fired a wire cancel
  // or whether we fell back to the post-RTT HY008 path.
  const m = db.cancelMetrics;
  console.log('  cancel metrics:', JSON.stringify(m));
  console.log('');

  // ---- Example 2: manual cancel() from another task ----
  //
  // Kick off a long query, then after 500ms call cancel() from
  // outside the execute. The watchdog dispatches FUNCTIONID_CANCEL
  // via the side channel; once the primary execute returns (or
  // short-circuits on an interrupted SQLCA) the wrapper throws
  // HY008.
  const stmt2 = conn.createStatement();
  setTimeout(() => {
    console.log('  [async] calling stmt2.cancel() …');
    stmt2.cancel();
  }, 500);
  console.log('Example 2: manual cancel() mid-execute');
  try {
    await stmt2.executeQuery(`
      WITH RECURSIVE T (N) AS (
        SELECT 1 FROM SYSIBM.SYSDUMMY1
        UNION ALL
        SELECT N + 1 FROM T WHERE N < 5000000
      )
      SELECT COUNT(*) FROM T
    `);
    console.log('  (query finished before the cancel landed)');
  } catch (err) {
    if (err instanceof SqlError && (err.messageId === 'HY008' || /HY008/.test(err.message))) {
      console.log(`  cancelled → ${err.message}`);
    } else {
      throw err;
    }
  }
  await stmt2.close();

  // ---- Example 3: default path pays nothing ----
  //
  // No setQueryTimeout, no cancel(): the fast path runs. The
  // `cancelCalls` counter stays flat, the side channel is never
  // opened, and there is no extra timer allocation per execute.
  const before = { ...db.cancelMetrics };
  const stmt3 = conn.createStatement();
  await stmt3.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
  await stmt3.close();
  const after = { ...db.cancelMetrics };
  console.log('\nExample 3: default path (queryTimeout=0, no cancel)');
  console.log(`  before: ${JSON.stringify(before)}`);
  console.log(`  after:  ${JSON.stringify(after)}`);
  const delta = Object.keys(after).every(k => after[k] === before[k]);
  console.log(`  counters unchanged: ${delta}`);
} finally {
  await conn.close();
}
