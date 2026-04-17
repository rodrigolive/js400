# SQL Feature Matrix

This document explicitly lists which DB2 features are supported, staged, or intentionally unsupported in js400.

## Feature status legend

- **Supported** -- implemented and tested
- **Staged** -- planned or partially implemented
- **Unsupported** -- intentionally not ported (Java-only or out of scope)

## Querying

| Feature | Status | API |
| --- | --- | --- |
| Direct query execution | Supported | `conn.query(sql)` |
| Parameterized query | Supported | `conn.query(sql, params)` |
| Column-named result objects | Supported | Rows are plain `{ COL: value }` objects |
| Result set streaming | Supported | `for await (const row of stmt.stream())` |
| Multiple result sets | Staged | `result.resultSets` from procedure calls |
| Cursor holdability | Staged | Server-side cursor control |
| Result shape control (array vs object rows) | Staged | Future option for array-mode rows |

## Updating

| Feature | Status | API |
| --- | --- | --- |
| INSERT | Supported | `conn.execute(sql, params)` |
| UPDATE | Supported | `conn.execute(sql, params)` |
| DELETE | Supported | `conn.execute(sql, params)` |
| MERGE | Supported | `conn.execute(sql, params)` |
| DDL (CREATE, ALTER, DROP) | Supported | `conn.execute(sql)` |
| Affected row count | Supported | `result.affectedRows` |

## Prepared statements

| Feature | Status | API |
| --- | --- | --- |
| Prepare and execute | Supported | `conn.prepare(sql)`, `stmt.execute(params)` |
| Parameter markers | Supported | `?` placeholders |
| Streaming results | Supported | `stmt.stream(params)` |
| Batch execution | Supported | `stmt.executeBatch(paramArrays)` |
| Statement close | Supported | `stmt.close()` |

## Transactions

| Feature | Status | API |
| --- | --- | --- |
| Begin transaction | Supported | `conn.begin()` |
| Commit | Supported | `conn.commit()` |
| Rollback | Supported | `conn.rollback()` |
| Auto-commit control | Supported | `conn.setAutoCommit(bool)` |
| Savepoints | Supported | `conn.savepoint(name)` |
| Rollback to savepoint | Supported | `conn.rollback(savepoint)` |
| Isolation levels | Supported | `isolation` connection property |

### Supported isolation levels

| Level | Wire value | Description |
| --- | --- | --- |
| `none` | `0xF0` | No commitment control |
| `read-uncommitted` | `0xF1` | Dirty reads allowed |
| `read-committed` | `0xF2` | Only committed data visible |
| `repeatable-read` | `0xF3` | Consistent reads within transaction |
| `serializable` | `0xF4` | Full serialization |

## LOB handling

| Feature | Status | API |
| --- | --- | --- |
| BLOB read (wrapper) | Supported | `rs.getBlob(col)` returns a `Blob` wrapper |
| BLOB read (raw) | Supported | `rs.getBytes(col)` returns `Buffer` |
| CLOB read (wrapper) | Supported | `rs.getClob(col)` returns a `Clob` wrapper |
| CLOB read (raw) | Supported | `rs.getString(col)` returns `string` |
| BLOB streaming | Supported | `blob.getReadableStream()` |
| CLOB streaming | Supported | `clob.getReadableStream()` |
| BLOB write | Supported | Pass `Buffer` or `Blob` wrapper as parameter |
| CLOB write | Supported | Pass `string` or `Clob` wrapper as parameter |
| SQLXML read (wrapper) | Supported | `rs.getSQLXML(col)` returns `SQLXML` wrapper |
| SQLXML write | Supported | Pass `SQLXML` wrapper or string via `setSQLXML()` |
| ARRAY (locator integration) | Staged | `rs.getArray(col)` returns `SqlArray` wrapper; server-side ARRAY protocol is not yet wired |
| ROWID (locator integration) | Staged | `rs.getRowId(col)` returns `RowId` wrapper |

## Metadata

| Feature | Status | API |
| --- | --- | --- |
| List tables | Supported | `meta.getTables({ schema })` |
| List columns | Supported | `meta.getColumns({ schema, table })` |
| List indexes | Supported | `meta.getIndexes({ schema, table })` |
| List schemas | Supported | `meta.getSchemas()` |
| List catalogs | Supported | `meta.getCatalogs()` |
| List primary keys | Supported | `meta.getPrimaryKeys({ schema, table })` |
| List procedures | Staged | `meta.getProcedures({ schema })` |

## Stored procedures

> **OUT / INOUT parity is Partial, NOT Supported.** js400 does not yet
> decode the host server's CALL reply parameter-row block (JTOpen's
> `DBData parameterRow_`, sourced from the 0x3810-family reply code
> points). Applications that require real protocol-level OUT retrieval
> must either migrate those procedures to emit OUT values as a result-
> set row (the DB2 `VALUES (...)` pattern) or wait for engine-layer
> support.

| Feature | Status | API |
| --- | --- | --- |
| CALL execution | Supported | `conn.call(procedure, { in, out })` |
| IN parameters | Supported | `{ in: [value, ...] }` or `cstmt.setObject(...)` |
| OUT parameter registration | Supported | `cstmt.registerOutParameter(idx, sqlType, ...)` |
| OUT parameter retrieval | Partial | Deterministic fallback: if the procedure emits exactly one result-set row, OUT slots are matched to columns by registered parameter name first, then declared column-descriptor order. Full host-server OUT protocol decoding is NOT implemented. |
| INOUT parameters | Partial | IN side works; OUT side uses the same result-set fallback |
| Named parameters | Supported | `cstmt.setString("P_NAME", ...)` after `setParameterName()` |
| Multiple result sets | Partial | Single result set captured today; `getMoreResults()` drains the queue but only ever holds one entry |
| Typed OUT getters | Supported | `cstmt.getString()`, `getBlob()`, `getClob()`, `getSQLXML()`, `getArray()`, `getRowId()` |
| `wasNull()` | Supported | Tracks the last OUT getter |

## Generated keys

| Feature | Status | API |
| --- | --- | --- |
| Return generated keys (INSERT) | Supported | `stmt.execute(params, { returnGeneratedKeys: true })` rewrites as `SELECT * FROM FINAL TABLE (INSERT ...)` |
| Access generated keys as rows | Supported | `result.generatedKeys` |
| Access generated keys as ResultSet | Supported | `stmt.getGeneratedKeys()` — cleared at the start of every subsequent `execute()` |
| Generated keys for UPDATE/DELETE/MERGE | Staged | DB2 `FINAL TABLE` supports it, but the wrapper only rewrites INSERT today |

## Batching

| Feature | Status | API |
| --- | --- | --- |
| Batch inserts | Supported | `stmt.executeBatch(paramArrays)` |
| Batch updates | Supported | `stmt.executeBatch(paramArrays)` |
| Update counts | Supported | `result.updateCounts` |

## Connection pooling

| Feature | Status | API |
| --- | --- | --- |
| Pool creation | Supported | `sql.createPool(options)` |
| Min/max connections | Supported | `min`, `max` options |
| Idle timeout | Supported | `idleTimeout` option |
| Validation on checkout | Supported | `validateOnCheckout` option |
| Pool query shorthand | Supported | `pool.query(sql)` |
| Connection release | Supported | `conn.release()` |
| Pool close | Supported | `pool.close()` |

## Cancellation

| Feature | Status | API |
| --- | --- | --- |
| Statement timeout | Staged | Future: timeout option on queries |
| AbortSignal cancellation | Staged | Future: pass `signal` to operations |

## JDBC metadata objects

| Feature | Status | API |
| --- | --- | --- |
| `ResultSetMetaData` as a separate object | Supported | `rs.getMetaData()` returns a `ResultSetMetaData` |
| `ParameterMetaData` as a separate object | Supported | `stmt.getParameterMetaData()` returns a `ParameterMetaData` |
| `DatabaseMetaData` | Supported | `conn.getMetaData()` returns a `DatabaseMetaData` |
| `SQLWarning` chain | Supported | `conn/stmt/rs.getWarnings()` returns a `SqlWarning` chain |

## DataSource / configuration surface

| Feature | Status | API |
| --- | --- | --- |
| JDBC URL `jdbc:as400://` parsing | Supported | `sql.parseJdbcUrl()` |
| `DataSource` with JTOpen property surface | Supported | `new DataSource(); ds.setServerName(...); ds.getConnection()` |
| `ConnectionPoolDataSource` (pool lifecycle) | Supported | `cpds.getPool()` returns a `ConnectionPool`; `cpds.getPooledConnection()` checks out via `pool.getConnection()` and logical `close()` returns the physical connection to the pool |
| `PooledConnection` event listeners | Partial | `addConnectionEventListener` fires `connectionClosed` exactly once on logical close; `addStatementEventListener` accepts listeners but no statement events are emitted yet |
| `getPooledConnection(user, password)` (credentials branch) | Partial | Opens a fresh physical connection and bypasses the pool; logical `close()` physically closes it. No credential-keyed pool sub-partitioning yet. |
| JNDI `Referenceable` | Partial | `ds.getReference()` returns a plain-object descriptor; full JNDI `Context.bind()` is Java-only |
| Driver properties (extendedDynamic, packageCache, blockSize, etc.) | Stored only | Stored verbatim on the DataSource and threaded through `connect()`. Most do NOT yet drive new runtime behavior. |
| Client reroute / affinity | Stored only | Configuration accepted but the reroute / failover logic is not implemented |

## Intentionally unsupported

| Feature | Reason |
| --- | --- |
| XA transactions | JTA/XA is a Java enterprise pattern with no direct JS equivalent |
| Full JNDI integration | Java naming integration does not map to JS modules |
| JDBC RowSet wrappers | Java-specific convenience; use arrays and iterables |
| DriverManager service-provider loading | Use `sql.connect()` or `new DataSource()` directly |
| Java stream adapters (`InputStream`, `OutputStream`, `Reader`, `Writer`) | Use Node.js streams and `Buffer` |
| Swing/`vaccess` SQL UI classes | Out of scope |
| `com.ibm.as400.micro` JDBC-ME | Out of scope |

Source: [`src/db/index.js`](../src/db/index.js), [`src/db/properties.js`](../src/db/properties.js)
