/**
 * SQL transaction example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-transactions.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-transactions.js
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
  // Setup: create temp tables
  await conn.execute(
    'CREATE TABLE QTEMP.ORDERS (ORDNO INTEGER, CUSTID VARCHAR(10), AMOUNT DECIMAL(9,2))'
  );
  await conn.execute(
    'CREATE TABLE QTEMP.CUSTBAL (CUSTID VARCHAR(10), BALANCE DECIMAL(11,2))'
  );
  await conn.execute(
    "INSERT INTO QTEMP.CUSTBAL VALUES('CUST01', 1000.00)"
  );
  console.log('Setup complete.');

  // Begin transaction
  await conn.begin();
  console.log('Transaction started.');

  try {
    await conn.execute(
      'INSERT INTO QTEMP.ORDERS VALUES(?, ?, ?)',
      [1001, 'CUST01', 250.00]
    );
    console.log('Inserted order.');

    await conn.execute(
      'UPDATE QTEMP.CUSTBAL SET BALANCE = BALANCE + ? WHERE CUSTID = ?',
      [250.00, 'CUST01']
    );
    console.log('Updated balance.');

    await conn.commit();
    console.log('Transaction committed.');
  } catch (err) {
    await conn.rollback();
    console.error('Transaction rolled back:', err.message);
    throw err;
  }

  // Verify
  const orders = await conn.query('SELECT * FROM QTEMP.ORDERS');
  const balance = await conn.query('SELECT * FROM QTEMP.CUSTBAL');
  console.log('\nOrders:', orders);
  console.log('Balance:', balance);
} finally {
  await conn.close();
}
