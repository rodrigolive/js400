/**
 * SQL stored procedure call example.
 *
 * Requires a stored procedure on the system. Create one with:
 *   CREATE OR REPLACE PROCEDURE JS400TEST.TESTPROC (
 *     IN INVAL CHAR(10), OUT OUTVAL CHAR(10)
 *   ) LANGUAGE SQL BEGIN SET OUTVAL = INVAL; END
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/sql-call-procedure.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/sql-call-procedure.js
 */

import { sql } from 'js400';

const host = process.env.JS400_HOST;
const user = process.env.JS400_USER;
const password = process.env.JS400_PASS;
const lib = process.env.JS400_LIB || 'JS400TEST';

if (!host || !user || !password) {
  console.error('Set JS400_HOST, JS400_USER, and JS400_PASS environment variables.');
  process.exit(1);
}

const conn = await sql.connect({ host, user, password });

try {
  // Call a stored procedure with IN and OUT parameters
  const result = await conn.call(`${lib}.TESTPROC`, {
    in: ['HELLO'],
    out: [
      { type: 'char', length: 10 },
    ],
  });

  console.log('Procedure result:');
  console.log('  Output parameter:', result.out[0]);
} finally {
  await conn.close();
}
