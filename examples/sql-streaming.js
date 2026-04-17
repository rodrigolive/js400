/**
 * SQL streaming large result sets example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-streaming.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-streaming.js
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
  // Stream rows from a system catalog (large result set)
  const stmt = await conn.prepare(
    'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM QSYS2.SYSTABLES FETCH FIRST 20 ROWS ONLY'
  );

  let count = 0;
  console.log('Streaming rows:');
  for await (const row of stmt.stream()) {
    count++;
    console.log(`  ${count}. ${row.TABLE_SCHEMA}.${row.TABLE_NAME} (${row.TABLE_TYPE})`);
  }

  console.log(`\nStreamed ${count} rows.`);
  await stmt.close();
} finally {
  await conn.close();
}
