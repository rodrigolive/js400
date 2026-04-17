/**
 * SQL query example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-query.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-query.js
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
  // Simple query
  const rows = await conn.query('SELECT * FROM SYSIBM.SYSDUMMY1');
  console.log('SYSDUMMY1 result:', rows);

  // Query with parameters
  const tables = await conn.query(
    'SELECT TABLE_SCHEMA, TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = ? FETCH FIRST 5 ROWS ONLY',
    ['QSYS2']
  );

  console.log('\nFirst 5 tables in QSYS2:');
  for (const row of tables) {
    console.log(`  ${row.TABLE_SCHEMA}.${row.TABLE_NAME}`);
  }
} finally {
  await conn.close();
}
