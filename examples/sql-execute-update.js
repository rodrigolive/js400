/**
 * SQL execute (INSERT/UPDATE/DELETE) example.
 *
 * Uses QTEMP for temporary tables that auto-clean.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-execute-update.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-execute-update.js
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
    'CREATE TABLE QTEMP.EXAMPLE_TBL (ID INTEGER, NAME VARCHAR(50), AMOUNT DECIMAL(9,2))'
  );
  console.log('Created QTEMP.EXAMPLE_TBL');

  // Insert rows
  const ins1 = await conn.execute(
    'INSERT INTO QTEMP.EXAMPLE_TBL VALUES(?, ?, ?)',
    [1, 'Alice', 100.50]
  );
  console.log('Insert 1 affected rows:', ins1.affectedRows);

  const ins2 = await conn.execute(
    'INSERT INTO QTEMP.EXAMPLE_TBL VALUES(?, ?, ?)',
    [2, 'Bob', 200.75]
  );
  console.log('Insert 2 affected rows:', ins2.affectedRows);

  // Update
  const upd = await conn.execute(
    'UPDATE QTEMP.EXAMPLE_TBL SET AMOUNT = AMOUNT + ? WHERE ID = ?',
    [50.25, 1]
  );
  console.log('Update affected rows:', upd.affectedRows);

  // Verify
  const rows = await conn.query('SELECT * FROM QTEMP.EXAMPLE_TBL ORDER BY ID');
  console.log('\nFinal data:');
  for (const row of rows) {
    console.log(`  ID=${row.ID}  NAME=${row.NAME}  AMOUNT=${row.AMOUNT}`);
  }

  // Delete
  const del = await conn.execute('DELETE FROM QTEMP.EXAMPLE_TBL WHERE ID = ?', [2]);
  console.log('\nDelete affected rows:', del.affectedRows);
} finally {
  await conn.close();
}
