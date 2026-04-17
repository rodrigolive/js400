/**
 * SQL metadata (schema discovery) example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-metadata.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-metadata.js
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
  const meta = await conn.metadata();

  // List tables in QSYS2
  const tables = await meta.getTables({ schema: 'QSYS2', type: 'TABLE' });
  console.log(`Found ${tables.length} tables in QSYS2.`);
  for (const t of tables.slice(0, 5)) {
    console.log(`  ${t.TABLE_SCHEMA}.${t.TABLE_NAME} (${t.TABLE_TYPE})`);
  }

  if (tables.length > 0) {
    // Get columns for the first table
    const tableName = tables[0].TABLE_NAME;
    const columns = await meta.getColumns({ schema: 'QSYS2', table: tableName });
    console.log(`\nColumns in QSYS2.${tableName}:`);
    for (const col of columns.slice(0, 10)) {
      console.log(`  ${col.COLUMN_NAME}  ${col.TYPE_NAME}(${col.COLUMN_SIZE})`);
    }
  }
} finally {
  await conn.close();
}
