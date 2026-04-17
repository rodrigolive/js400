/**
 * SQL batch execution example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-batch.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-batch.js
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
  // Create a temporary table
  await conn.execute(
    'CREATE TABLE QTEMP.BATCH_TBL (EVENT_ID INTEGER, EVENT_TEXT VARCHAR(100))'
  );
  console.log('Created QTEMP.BATCH_TBL');

  // Prepare for batch insert
  const stmt = await conn.prepare(
    'INSERT INTO QTEMP.BATCH_TBL(EVENT_ID, EVENT_TEXT) VALUES(?, ?)'
  );

  // Execute batch
  const result = await stmt.executeBatch([
    [1, 'Application started'],
    [2, 'User authenticated'],
    [3, 'Data validated'],
    [4, 'Transaction committed'],
    [5, 'Session ended'],
  ]);

  console.log('Batch update counts:', result.updateCounts);
  await stmt.close();

  // Verify
  const rows = await conn.query('SELECT * FROM QTEMP.BATCH_TBL ORDER BY EVENT_ID');
  console.log('\nInserted rows:');
  for (const row of rows) {
    console.log(`  ${row.EVENT_ID}: ${row.EVENT_TEXT}`);
  }
} finally {
  await conn.close();
}
