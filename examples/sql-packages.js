/**
 * SQL package (extendedDynamic) example.
 *
 * Demonstrates the `extendedDynamic` / `sqlPackage` family of
 * connection properties — the js400 port of JTOpen's
 * `JDPackageManager` behavior. When enabled, the server-side SQL
 * package captures each packageable prepare so a peer caller (js400
 * or JTOpen) with the same connection properties can reuse the same
 * cached access plan on subsequent connects.
 *
 * Defaults stay on the fast path: if `extendedDynamic` is left off,
 * NO additional code points, round-trips, or allocations happen on
 * prepare.
 *
 * JTOpen upstream:
 *   - JDPackageManager.java (package identity, CREATE/RETURN_PACKAGE)
 *   - AS400JDBCStatement.java#commonPrepare (per-prepare wire binding)
 *   - JDSQLStatement.java#analyzeBody (isPackaged heuristic)
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-packages.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-packages.js
 *
 * Optional environment:
 *   JS400_PACKAGE       — package name (≤6 chars recommended; default JS400A)
 *   JS400_PACKAGE_LIB   — library the package lives in (default QGPL)
 *   JS400_PACKAGE_ERROR — failure policy: none | warning | exception
 */

import { sql } from 'js400';

const host = process.env.JS400_HOST;
const user = process.env.JS400_USER;
const password = process.env.JS400_PASS;
const sqlPackage = process.env.JS400_PACKAGE || 'JS400A';
const packageLibrary = process.env.JS400_PACKAGE_LIB || 'QGPL';
const packageError = process.env.JS400_PACKAGE_ERROR || 'warning';

if (!host || !user || !password) {
  console.error('Set JS400_HOST, JS400_USER, and JS400_PASS environment variables.');
  process.exit(1);
}

const conn = await sql.connect({
  host, user, password,
  // Enable extended dynamic. When false (the default) every knob
  // below is ignored and the connection runs on the plain-prepare
  // fast path — no PACKAGE_NAME / LIBRARY_NAME codepoints emitted,
  // no lazy CREATE_PACKAGE round-trip.
  extendedDynamic: true,

  // Package identity. js400 normalizes the name the same way JTOpen
  // does: up to 6 characters + a 4-character suffix encoding the
  // commit mode, date/time formats, separators, decimal separator,
  // naming convention, and translate-hex choice. Two connections
  // with the same knobs will converge on the same package name —
  // that is the whole point.
  sqlPackage,
  packageLibrary,

  // Opt into the optional RETURN_PACKAGE round-trip after
  // CREATE_PACKAGE. This pulls the server's current package blob
  // down so a future pass can map cached statements to prepared
  // names and skip the PREPARE round-trip entirely. For now the
  // blob is kept opaque and `packageFetches` simply ticks.
  packageCache: true,

  // Failure policy when CREATE_PACKAGE fails on the wire:
  //   'exception' → throw a SQL error from the prepare path. Good
  //                 for CI / tests where a misconfigured package is
  //                 a hard failure.
  //   'warning'   → disable the manager for this connection and
  //                 post a warning on Connection.getWarnings().
  //                 Matches JTOpen's default.
  //   'none'      → disable silently. Useful for long-lived pools
  //                 where the app keeps running even if the
  //                 package isn't available.
  packageError,
});

try {
  // Run a packageable prepare (parameterized SELECT). The engine
  // lazily creates the server-side package on the first prepare,
  // then attaches PACKAGE_NAME + LIBRARY_NAME + prepareOption=1 to
  // this and every subsequent packageable prepare.
  const stmt = await conn.prepare(
    'SELECT TABLE_SCHEMA, TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = ? FETCH FIRST 3 ROWS ONLY'
  );
  const rows1 = await stmt.execute(['QSYS2']);
  console.log(`First execute: ${rows1.length} row(s)`);

  // Re-execute the same prepared statement — no new CREATE_PACKAGE.
  const rows2 = await stmt.execute(['SYSIBM']);
  console.log(`Second execute: ${rows2.length} row(s)`);

  // Unpackageable SQL (plain SELECT, no parameters) still flows
  // through the normal prepare path. The engine emits an empty
  // PACKAGE_NAME codepoint (LL-only, no value) — JTOpen parity —
  // so the server knows this particular statement isn't eligible
  // for the package even though the connection IS package-bound.
  const plain = await conn.query('SELECT 1 FROM SYSIBM.SYSDUMMY1');
  console.log(`Plain SELECT: ${plain.length} row(s)`);

  // Surface package-level counters. These live on the engine's
  // StatementManager for bench / diagnostic use.
  const metrics = conn.dbConnection?.statementManager?.metrics;
  if (metrics) {
    console.log('\nPackage counters:');
    console.log(`  packageCreates: ${metrics.packageCreates}`);
    console.log(`  packageFetches: ${metrics.packageFetches}`);
    console.log(`  packageHits:    ${metrics.packageHits}  (0 until DBReplyPackageInfo decode lands)`);
  }

  await stmt.close();

  // If CREATE_PACKAGE failed AND packageError='warning', the
  // connection has a warning queued here that names the SQLCODE /
  // SQLSTATE returned by the server.
  const w = conn.getWarnings?.();
  if (w) {
    for (const warn of w) {
      console.log(`[warning ${warn.sqlState}] ${warn.message}`);
    }
  }
} finally {
  await conn.close();
}
