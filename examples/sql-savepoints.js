/**
 * SQL savepoint example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-savepoints.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-savepoints.js
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
  // Setup
  await conn.execute(
    'CREATE TABLE QTEMP.INVENTORY (ITEMNO INTEGER, ONHAND INTEGER)'
  );
  await conn.execute(
    'CREATE TABLE QTEMP.SHIPLOG (ITEMNO INTEGER, STATUS VARCHAR(20))'
  );
  await conn.execute('INSERT INTO QTEMP.INVENTORY VALUES(1001, 100)');
  console.log('Setup complete. Inventory: 100 units.');

  // Transaction with savepoint
  await conn.begin();

  try {
    // Reduce inventory
    await conn.execute(
      'UPDATE QTEMP.INVENTORY SET ONHAND = ONHAND - ? WHERE ITEMNO = ?',
      [5, 1001]
    );
    console.log('Reduced inventory by 5.');

    // Create savepoint after inventory update
    const sp = await conn.savepoint('after_inventory');
    console.log('Savepoint created: after_inventory');

    // Log shipment (this will be rolled back)
    await conn.execute(
      "INSERT INTO QTEMP.SHIPLOG VALUES(?, ?)",
      [1001, 'SHIPPED']
    );
    console.log('Inserted shipment log (will be rolled back).');

    // Roll back only the shipment log
    await conn.rollback(sp);
    console.log('Rolled back to savepoint. Shipment log undone.');

    // Commit the inventory change
    await conn.commit();
    console.log('Transaction committed.');
  } catch (err) {
    await conn.rollback();
    console.error('Transaction rolled back:', err.message);
  }

  // Verify
  const inv = await conn.query('SELECT * FROM QTEMP.INVENTORY');
  const log = await conn.query('SELECT * FROM QTEMP.SHIPLOG');
  console.log('\nInventory:', inv);   // ONHAND should be 95
  console.log('Ship log:', log);       // Should be empty
} finally {
  await conn.close();
}
