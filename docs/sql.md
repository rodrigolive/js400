# SQL

js400 provides a JS-native SQL client for IBM i DB2. The API replaces JDBC with an ergonomic JavaScript interface while preserving full DB2 capability.

## Connect

```js
import { sql } from 'js400';

const conn = await sql.connect({
  host: 'your-ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
  libraries: ['MYLIB', 'QGPL'],
  naming: 'sql',
  dateFormat: '*ISO',
});
```

You can also connect with a JDBC-style URL for migration convenience:

```js
const conn = await sql.connect('jdbc:as400://myhost/MYLIB;naming=sql;date format=iso');
```

Or pass an existing `AS400` system instance:

```js
import { AS400, sql } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();
const conn = await sql.connect(system, { libraries: ['MYLIB'] });
```

## Query

```js
const rows = await conn.query('SELECT CUSNUM, CUSNAM, CUSBAL FROM MYLIB.CUSTOMER');
for (const row of rows) {
  console.log(row.CUSNUM, row.CUSNAM, row.CUSBAL);
}
```

With parameter markers:

```js
const rows = await conn.query(
  'SELECT * FROM MYLIB.CUSTOMER WHERE CUSST = ? AND CUSBAL > ?',
  ['CA', 1000.00]
);
```

## Execute (INSERT, UPDATE, DELETE)

```js
const result = await conn.execute(
  'UPDATE MYLIB.CUSTOMER SET CUSBAL = CUSBAL + ? WHERE CUSNUM = ?',
  [25.50, 1000123]
);
console.log(result.affectedRows);
```

## Prepared statements

```js
const stmt = await conn.prepare(
  'SELECT * FROM MYLIB.CUSTOMER WHERE CUSBAL > ? AND CUSST = ?'
);
const rows = await stmt.execute([1000.00, 'CA']);
console.log(`Found ${rows.length} customers`);
await stmt.close();
```

## Streaming large result sets

```js
const stmt = await conn.prepare('SELECT * FROM LARGE_TABLE');
for await (const row of stmt.stream()) {
  process.stdout.write(`${row.ID}\n`);
}
await stmt.close();
```

## Batch execution

```js
const stmt = await conn.prepare(
  'INSERT INTO MYLIB.AUDITLOG(EVENT_ID, EVENT_TEXT) VALUES(?, ?)'
);

const batch = await stmt.executeBatch([
  [1, 'started'],
  [2, 'validated'],
  [3, 'completed'],
]);

console.log(batch.updateCounts);
await stmt.close();
```

## Transactions

```js
await conn.begin();
try {
  await conn.execute(
    'INSERT INTO ORDERS VALUES(?, ?, ?)',
    [1001, 'CUST01', 250.00]
  );
  await conn.execute(
    'UPDATE CUSTOMER SET CUSBAL = CUSBAL + 250.00 WHERE CUSNUM = ?',
    ['CUST01']
  );
  await conn.commit();
} catch (err) {
  await conn.rollback();
  throw err;
}
```

## Savepoints

```js
await conn.begin();
try {
  await conn.execute(
    'UPDATE INVENTORY SET ONHAND = ONHAND - 5 WHERE ITEMNO = ?',
    [1001]
  );
  const sp = await conn.savepoint('after_inventory');

  await conn.execute(
    'UPDATE ORDERS SET STATUS = ? WHERE ORDNO = ?',
    ['SHIPPED', 7001]
  );

  // Roll back only the order update
  await conn.rollback(sp);
  await conn.commit();
} catch (err) {
  await conn.rollback();
  throw err;
}
```

## Stored procedure calls

```js
const result = await conn.call('MYLIB.GET_CUSTOMER_STATS', {
  in: ['CA'],
  out: [
    { type: 'integer' },
    { type: 'decimal', precision: 15, scale: 2 },
  ],
});

console.log(result.out[0]); // customer count
console.log(result.out[1]); // total balance
```

## Metadata

```js
const meta = await conn.metadata();

const tables = await meta.getTables({ schema: 'MYLIB', type: 'TABLE' });
const columns = await meta.getColumns({ schema: 'MYLIB', table: 'CUSTOMER' });
const indexes = await meta.getIndexes({ schema: 'MYLIB', table: 'CUSTOMER' });
```

## Generated keys

```js
const result = await conn.execute(
  'INSERT INTO MYLIB.CUSTOMER(CUSNAM, CUSST) VALUES(?, ?)',
  ['ACME', 'CA'],
  { returnGeneratedKeys: true }
);
console.log(result.generatedKeys);
```

## Connection pool

```js
const pool = sql.createPool({
  host: 'your-ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
  max: 20,
  min: 2,
  idleTimeout: 60_000,
  libraries: ['MYLIB', 'QGPL'],
});

const conn = await pool.getConnection();
const rows = await conn.query('SELECT * FROM CUSTOMER');
conn.release(); // return to pool

// Shorthand
const rows2 = await pool.query('SELECT COUNT(*) AS CNT FROM CUSTOMER');

await pool.close();
```

## Connection properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | | IBM i hostname |
| `user` | `string` | | User profile |
| `password` | `string` | | Password |
| `secure` | `boolean` | `false` | Use TLS |
| `naming` | `string` | `'sql'` | `'sql'` (schema.table) or `'system'` (library/file) |
| `libraries` | `string[]` | `[]` | Library list |
| `defaultSchema` | `string` | | Default schema/collection |
| `dateFormat` | `string` | `'*ISO'` | Date format (`*ISO`, `*USA`, `*EUR`, `*JIS`, `*MDY`, `*DMY`, `*YMD`, `*JUL`) |
| `timeFormat` | `string` | `'*ISO'` | Time format (`*ISO`, `*USA`, `*EUR`, `*JIS`, `*HMS`) |
| `dateSeparator` | `string` | `'-'` | Date separator |
| `timeSeparator` | `string` | `':'` | Time separator |
| `decimalSeparator` | `string` | `'.'` | Decimal separator |
| `isolation` | `string` | `'read-uncommitted'` | Transaction isolation level |
| `autoCommit` | `boolean` | `true` | Auto-commit mode |
| `blockSize` | `number` | `32` | Fetch block size (0-512) |
| `extendedDynamic` | `boolean` | `false` | Enable server-side SQL package (see [SQL Packages](sql-packages.md)) |
| `sqlPackage` | `string` | | Package name when `extendedDynamic` is on |
| `packageLibrary` | `string` | `'QGPL'` | Library the package lives in |
| `packageCache` | `boolean` | `false` | Fetch the package blob after create |
| `packageError` | `string` | `'warning'` | `CREATE_PACKAGE` failure policy: `'none'`, `'warning'`, or `'exception'` |
| `holdStatements` | `boolean` | `false` | Cursor hold across `COMMIT` (`HOLD_INDICATOR` on wire) |

## Cancel and query timeout

Long-running queries can be interrupted with `stmt.cancel()` or
`stmt.setQueryTimeout(n)` — js400 routes both through a lazily-
opened side-channel DATABASE connection that issues
`FUNCTIONID_CANCEL` (`0x1818`), mirroring JTOpen's two-connection
cancel model. The default path pays two boolean checks and no
timer when `queryTimeout = 0` and no cancel() is in flight. See
[Cancel and Query Timeout](sql-cancel.md).

## Close

```js
await conn.close();
```

Source: [`src/db/connect.js`](../src/db/connect.js), [`src/db/api/Connection.js`](../src/db/api/Connection.js), [`src/db/api/PreparedStatement.js`](../src/db/api/PreparedStatement.js), [`src/db/properties.js`](../src/db/properties.js)
