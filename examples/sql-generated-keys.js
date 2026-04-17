/**
 * SQL generated keys example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-generated-keys.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-generated-keys.js
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
  // Create a table with an identity column
  await conn.execute(
    'CREATE TABLE QTEMP.GENKEYS_TBL (ID INTEGER GENERATED ALWAYS AS IDENTITY, NAME VARCHAR(50), AMOUNT DECIMAL(9,2))'
  );
  console.log('Created QTEMP.GENKEYS_TBL with identity column.');

  // Insert and retrieve generated keys
  const result = await conn.execute(
    'INSERT INTO QTEMP.GENKEYS_TBL(NAME, AMOUNT) VALUES(?, ?)',
    ['Alice', 100.50],
    { returnGeneratedKeys: true }
  );

  console.log('Insert result:');
  console.log('  Affected rows:', result.affectedRows);
  console.log('  Generated keys:', result.generatedKeys);

  // Insert another row
  const result2 = await conn.execute(
    'INSERT INTO QTEMP.GENKEYS_TBL(NAME, AMOUNT) VALUES(?, ?)',
    ['Bob', 200.75],
    { returnGeneratedKeys: true }
  );
  console.log('  Second insert keys:', result2.generatedKeys);

  // Verify
  const rows = await conn.query('SELECT * FROM QTEMP.GENKEYS_TBL ORDER BY ID');
  console.log('\nAll rows:');
  for (const row of rows) {
    console.log(`  ID=${row.ID}  NAME=${row.NAME}  AMOUNT=${row.AMOUNT}`);
  }
} finally {
  await conn.close();
}
