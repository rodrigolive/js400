/**
 * SQL prepared statement example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-prepare.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-prepare.js
 */

import { sql } from 'js400';

const host = process.env.JS400_HOST;
const user = process.env.JS400_USER;
const password = process.env.JS400_PASS;

if (!host || !user || !password) {
  console.error('Set JS400_HOST, JS400_USER, and JS400_PASS environment variables.');
  process.exit(1);
}

const conn = await sql.connect({ host, user, password });

try {
  // Prepare a parameterized query
  const stmt = await conn.prepare(
    'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?'
  );

  // Execute with different parameters
  const views = await stmt.execute(['QSYS2', 'VIEW']);
  console.log(`Found ${views.length} views in QSYS2.`);

  const tables = await stmt.execute(['QSYS2', 'TABLE']);
  console.log(`Found ${tables.length} tables in QSYS2.`);

  if (tables.length > 0) {
    console.log('\nFirst table:', tables[0].TABLE_NAME);
  }

  await stmt.close();
} finally {
  await conn.close();
}
