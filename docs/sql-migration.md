# Migrating from JDBC to js400 SQL

## JDBC is not available in JavaScript

JDBC is a Java standard API. Once the implementation moves to pure JavaScript, the question is not "how do we keep JDBC?" but "how do we preserve the DB2 capabilities people used through JDBC?"

js400 preserves DB2 feature parity while presenting a JS-native API surface. JDBC concepts like `DriverManager`, `DataSource`, `ResultSet`, and `java.sql.Connection` do not exist in JavaScript, but every database operation they supported is available.

## JDBC URL migration

js400 still accepts JTOpen-style JDBC URLs for migration convenience:

```js
import { sql } from 'js400';

// Legacy JDBC URL
const conn = await sql.connect('jdbc:as400://myhost/MYLIB;naming=sql;date format=iso');

// Preferred: options object
const conn2 = await sql.connect({
  host: 'myhost',
  user: 'MYUSER',
  password: 'secret',
  naming: 'sql',
  libraries: ['MYLIB'],
  dateFormat: '*ISO',
});
```

Use `parseJdbcUrl()` to inspect what a JDBC URL produces:

```js
import { sql } from 'js400';

const opts = sql.parseJdbcUrl('jdbc:as400://myhost/MYLIB;naming=sql;date format=iso');
console.log(opts);
// { host: 'myhost', defaultSchema: 'MYLIB', naming: 'sql', dateFormat: '*ISO' }
```

## Class mapping

| JTOpen JDBC class | js400 equivalent | Notes |
| --- | --- | --- |
| `AS400JDBCDriver` | `sql.connect()` | Connection factory and URL parser |
| `java.sql.Connection` | `Connection` (from `sql.connect()`) | Returned by `sql.connect()` |
| `java.sql.Statement` | `Statement` (internal) | Used by `conn.query()` |
| `java.sql.PreparedStatement` | `PreparedStatement` | From `conn.prepare()` |
| `java.sql.CallableStatement` | `CallableStatement` | From `conn.call()` |
| `java.sql.ResultSet` | Array of objects or async iterable | `conn.query()` returns `object[]` |
| `java.sql.DatabaseMetaData` | `DatabaseMetaData` | From `conn.metadata()` |
| `javax.sql.DataSource` | `sql.createPool()` | Simple factory, not JNDI |
| `javax.sql.ConnectionPoolDataSource` | `ConnectionPool` | JS pool wrapper |
| `java.sql.Savepoint` | `Savepoint` | From `conn.savepoint()` |
| `java.sql.Blob` | `Buffer` | BLOB data returned as `Buffer` |
| `java.sql.Clob` | `string` | CLOB data returned as `string` |
| `SQLXML` | `SQLXML` wrapper | `await value.text()` for string |
| `java.sql.Array` | `SqlArray` wrapper | JS-friendly array access |
| `java.sql.RowId` | `RowId` wrapper | Lightweight identifier |
| `XAConnection` / `XADataSource` | Not ported | JTA/XA not applicable in JS |
| `AS400JDBCObjectFactory` | Not ported | JNDI only |

## API mapping

| JDBC pattern | js400 equivalent |
| --- | --- |
| `stmt.executeQuery(sql)` | `conn.query(sql)` or `stmt.execute(params)` |
| `stmt.executeUpdate(sql)` | `conn.execute(sql)` returning `{ affectedRows }` |
| `stmt.executeBatch()` | `stmt.executeBatch(paramArrays)` |
| `rs.next()` loop | `for (const row of rows)` or `for await (const row of stmt.stream())` |
| `rs.getString("COL")` | `row.COL` (plain JS object) |
| `rs.getInt("COL")` | `row.COL` (JS number) |
| `conn.setAutoCommit(false)` | `conn.setAutoCommit(false)` or `conn.begin()` |
| `conn.commit()` | `conn.commit()` |
| `conn.rollback()` | `conn.rollback()` |
| `conn.setSavepoint("name")` | `conn.savepoint("name")` |
| `conn.rollback(savepoint)` | `conn.rollback(savepoint)` |
| `conn.prepareCall("CALL ...")` | `conn.call(procedure, { in, out })` |
| `stmt.getGeneratedKeys()` | `result.generatedKeys` |
| `rs.getMetaData()` | `result.metadata` |
| `conn.getMetaData()` | `conn.metadata()` |
| `ResultSet` streaming | `for await (const row of stmt.stream())` |

## JDBC property mapping

### P0: Supported

| JDBC property | js400 option | Notes |
| --- | --- | --- |
| `user` | `user` | User profile |
| `password` | `password` | Password |
| `secure` | `secure` | TLS mode |
| `naming` | `naming` | `'sql'` or `'system'` |
| `libraries` | `libraries` | Array of library names |
| `database name` | `defaultSchema` | Default collection |
| `date format` | `dateFormat` | `*ISO`, `*USA`, etc. |
| `date separator` | `dateSeparator` | `/`, `-`, `.`, `,`, ` ` |
| `time format` | `timeFormat` | `*ISO`, `*USA`, etc. |
| `time separator` | `timeSeparator` | `:`, `.`, `,`, ` ` |
| `transaction isolation` | `isolation` | `none`, `read-uncommitted`, `read-committed`, `repeatable-read`, `serializable` |
| `auto commit` | `autoCommit` | `true` or `false` |
| `block size` | `blockSize` | Fetch block size (0-512) |
| `prefetch` | `prefetch` | Prefetch result rows |

### P1: Considered

| JDBC property | js400 option | Notes |
| --- | --- | --- |
| `sort` | `sortType` | Sort sequence type |
| `sort language` | `sortLanguage` | Sort language |
| `sort table` | `sortTable` | Sort table name |
| `sort weight` | `sortWeight` | Sort weight |
| `decimal separator` | `decimalSeparator` | `.` or `,` |
| `block criteria` | `blockCriteria` | Block fetch criteria |
| `package` | `sqlPackage` | SQL package name |
| `package library` | `packageLibrary` | Package library |
| `package cache` | `packageCache` | Enable package caching |

### Dropped (Java-only)

These JDBC properties have no meaning in a JavaScript client:

- `driver` -- Java JDBC driver class name
- `prompt` -- GUI password prompt behavior
- `trace` -- Java JDBC trace (use `Trace` class instead)
- `errors` -- Java error handling mode
- `data truncation` -- Java-specific truncation behavior
- `access` -- Java security manager access level
- `remarks` -- JDBC metadata remarks source
- `data compression` -- Connection-level compression
- `extended dynamic` -- Java statement caching mode
- `full open` -- Java cursor mode
- `lazy close` -- Java statement close timing
- `lob threshold` -- Java LOB inline threshold
- `maximum precision` / `maximum scale` -- Java decimal limits
- All JNDI/DataSource bean properties

Source: [`src/db/connect.js`](../src/db/connect.js), [`src/db/url.js`](../src/db/url.js), [`src/db/properties.js`](../src/db/properties.js)
