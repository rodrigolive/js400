# Migrating from JDBC to js400 SQL

## JDBC is not available in JavaScript

JDBC is a Java standard API. Once the implementation moves to pure JavaScript, the question is not "how do we keep JDBC?" but "how do we preserve the DB2 capabilities people used through JDBC?"

js400 preserves most of the common DB2 capabilities a JTOpen JDBC caller relied on, behind a JS-native API surface. JDBC concepts like `DriverManager`, `DataSource`, `ResultSet`, and `java.sql.Connection` are exposed as JS classes (`Connection`, `PreparedStatement`, `ResultSet`, `DataSource`) so that most ports can happen one-for-one.

Some features are still staged or partial — see the [SQL feature matrix](sql-feature-matrix.md) for the current coverage and gap list. Notable items that still diverge from strict JDBC parity:

- server-side scrollable and updatable result sets (scroll semantics work against materialized rows only; `SCROLL_INSENSITIVE` is supported through in-memory buffering, `SCROLL_SENSITIVE` is not)
- true wire-level positioned `UPDATE / DELETE` (`WHERE CURRENT OF <cursor>`) now works: `setCursorName()` reaches `CREATE_RPB` using the server CCSID, and live qualification on IBM i confirmed both positioned `UPDATE` and `DELETE`
- generated-keys wrapping only supports `INSERT` (UPDATE/DELETE/MERGE is staged)
- mid-RTT preemption for `cancel()` / `setQueryTimeout()` — both are honored client-side (the wrapper throws `SqlError(HY008)` after the in-flight RTT returns), but neither preempts the in-flight execute. Real preemption needs a side connection (JTOpen `AS400JDBCConnectionImpl.cancel`).
- XA, RowSet, and full JNDI integration are intentionally not ported

Automatic SQLCA-to-warning propagation is active for `Statement` (`query`, `execute(sql)` including the immediate and FINAL-TABLE wrap paths, `executeQuery`, `executeBatch`), `PreparedStatement` (`execute`, `executeForStream`, `executeCall`, `executeBatch`, generated-keys wrap), `CallableStatement` (which absorbs the inner prepared statement's chain), and `Connection` (`execute(sql)` immediate + parameterized prepare paths, `commit`, `rollback`, savepoint lifecycle, and connection-level control statements like `SET SCHEMA` / `SET CURRENT ISOLATION`). Warnings on `Statement` / `PreparedStatement` are cleared at the start of every execute (JTOpen `AS400JDBCStatement.commonExecuteBefore` lifecycle); `Connection` warnings are JDBC-cumulative (only `clearWarnings()` resets).

`cancel()` and `setQueryTimeout()` are wired on every execute path. `cancel()` flips an internal flag; the next operation throws `SqlError(HY008)` "Statement was cancelled" and clears the flag. `setQueryTimeout(n>0)` arms a per-execute `setTimeout(n*1000)` that flips the same flag; after the in-flight RTT returns the wrapper throws `SqlError(HY008)` "Query timeout exceeded". The fast path (`n = 0`) is a single boolean check and does not allocate.

`CallableStatement` has moved out of the partial list: OUT / INOUT values are now decoded at the protocol level from the CALL reply's parameter-row block (code point `0x380E`, gated by the `ORS_BITMAP_RESULT_DATA` bit), matching JTOpen's `parameterRow_` path. JDBC call-text forms `{ call PROC(?,?) }`, `{ ? = call FUNC(?,?) }`, and bare `CALL PROC(?,?)` all parse and classify as CALL end-to-end. A deterministic result-set heuristic remains as a fallback for procedures that emit OUT through `VALUES(...)` instead of real markers.

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
| `java.sql.DatabaseMetaData` | `DatabaseMetaData` | From `conn.getMetaData()` / `conn.metadata()` |
| `java.sql.ResultSetMetaData` | `ResultSetMetaData` | From `rs.getMetaData()` |
| `java.sql.ParameterMetaData` | `ParameterMetaData` | From `stmt.getParameterMetaData()` |
| `java.sql.SQLWarning` | `SqlWarning` | From `conn/stmt/rs.getWarnings()` |
| `AS400JDBCDataSource` | `DataSource` | Property-based configuration with `getConnection()` |
| `AS400JDBCConnectionPoolDataSource` | `ConnectionPoolDataSource` | Exposes `getPool()` and `getPooledConnection()` |
| `javax.sql.PooledConnection` | Return value of `cpds.getPooledConnection()` | Supports connection/statement event listeners |
| `javax.sql.DataSource` (simple pool) | `sql.createPool()` | Simple factory returning a `ConnectionPool` |
| `java.sql.Savepoint` | `Savepoint` | From `conn.savepoint()` |
| `java.sql.Blob` | `Blob` wrapper | `rs.getBlob(col)` returns a `Blob`; call `await blob.toBuffer()` |
| `java.sql.Clob` | `Clob` wrapper | `rs.getClob(col)` returns a `Clob`; call `await clob.text()` |
| `SQLXML` | `SQLXML` wrapper | `await value.getString()` for string |
| `java.sql.Array` | `SqlArray` wrapper | JS-friendly array access |
| `java.sql.RowId` | `RowId` wrapper | Lightweight identifier |
| `XAConnection` / `XADataSource` | Not ported | JTA/XA not applicable in JS |
| JNDI `Referenceable` full binding | Partial (`ds.getReference()`) | Returns a plain-object descriptor; no `InitialContext.bind()` analogue |

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
| `conn.prepareCall("CALL ...")` | `conn.prepareCall(procedure)` or `conn.call(procedure, { in, out })` |
| `stmt.getGeneratedKeys()` | `stmt.getGeneratedKeys()` — returns a `ResultSet` (or `result.generatedKeys` for plain rows) |
| `rs.getMetaData()` | `rs.getMetaData()` — returns a `ResultSetMetaData` |
| `conn.getMetaData()` | `conn.getMetaData()` — returns a `DatabaseMetaData` |
| `ResultSet` streaming | `for await (const row of stmt.stream())` |
| `cstmt.registerOutParameter(i, Types.INTEGER)` | `cstmt.registerOutParameter(i, 'integer')` or pass `java.sql.Types` number |
| `cstmt.setString("P_NAME", "X")` | `cstmt.setString("P_NAME", "X")` (after `cstmt.setParameterName(i, "P_NAME")`) |

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
| `hold statements` | `holdStatements` | Boolean (or byte). When true, emits `HOLD_INDICATOR=0x01` on `CREATE RPB` so cursors survive `COMMIT`. Unset leaves DB2 on its default. |

### P1: Runtime-wired or stored-only knobs

Some properties are now runtime-wired; others are still accepted only for configuration round-trip. The important distinction is explicit opt-in: js400 only changes runtime behavior when the caller actually set the property, not when a library default happens to exist in normalized options.

| JDBC property | js400 option | Notes |
| --- | --- | --- |
| `block size` | `blockSize` | Runtime-wired when explicitly set. js400 now computes a JTOpen-style row-count blocking factor from row length (`floor(blockSizeKB * 1024 / rowLength)`, capped to `32767`) and uses that for the OPEN request plus the default FETCH size when the caller did not set `Statement.setFetchSize()`. The knob remains opt-in only; default callers keep js400's existing fetch behavior. Live live IBM i qualification showed `blockSize=32` was materially slower on the current wide-row benchmark, so this is parity behavior, not a recommended default. |
| `prefetch` | `prefetch` | Stored only. js400 currently uses the correctness-first `OPEN_AND_DESCRIBE` + `FETCH` path by default; inline first-block prefetch via `OPEN_DESCRIBE_FETCH` is deferred until it is re-qualified against live hosts. |
| `extended dynamic` | `extendedDynamic` | Stored only. No server-side SQL package integration yet. |
| `lazy close` | `lazyClose` | Stored only. Handles already defer via the statement cache; no wire-level lazy close yet. |
| `package cache` | `packageCache` | Stored only. |
| `query timeout mechanism` | `queryTimeoutMechanism` | Stored only. `setQueryTimeout()` itself is wired client-side (throws `SqlError(HY008)` after the in-flight RTT when the timer fires) — no server RPB timeout, no mid-RTT preemption. The mechanism property still doesn't switch between `QQRYTIMLMT` and the cancel-thread strategies; that selection is a JTOpen-only concept today. |

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
- `full open` -- Java cursor mode
- `lob threshold` -- Java LOB inline threshold
- `maximum precision` / `maximum scale` -- Java decimal limits
- All JNDI/DataSource bean properties

(`extended dynamic` and `lazy close` are not dropped — they are
accepted as stored-only properties today and are candidates for a
future runtime-knob pass; see the P1 table above.)

Source: [`src/db/connect.js`](../src/db/connect.js), [`src/db/url.js`](../src/db/url.js), [`src/db/properties.js`](../src/db/properties.js)
