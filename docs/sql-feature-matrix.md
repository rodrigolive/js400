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
| Multiple result sets — general statement | Unsupported | A plain SELECT or DML never produces multiple result sets via `Statement.getMoreResults()`. `DatabaseMetaData.supportsMultipleResultSets()` returns `false`. |
| Multiple result sets — CALL replies | Partial | The engine decodes the *first* secondary result-set block when its descriptor (0x3805 / 0x3812) arrives inline with the CALL reply; rows surface on `result.resultSets[0]`. Streaming further blocks via `getMoreResults()` is staged. See the Stored Procedures section. |
| Scrollable cursors — forward-only | Supported | `DatabaseMetaData.supportsResultSetType(FORWARD_ONLY)` = true. Native host cursor shape. |
| Scrollable cursors — insensitive | Supported (in-memory) | `absolute()`, `relative()`, `previous()`, `first()`, `last()` work inside the buffered rows already materialized from the host cursor — not a server-side sensitive scroll. `DatabaseMetaData.supportsResultSetType(SCROLL_INSENSITIVE)` = true. |
| Scrollable cursors — sensitive | Unsupported | No server-side sensitive-scroll cursor open. `supportsResultSetType(SCROLL_SENSITIVE)` = false. |
| Updatable result sets | Unsupported | `supportsResultSetConcurrency()` returns true only for `CONCUR_READ_ONLY`. No `insertRow()`/`updateRow()`/`deleteRow()`. |
| Cursor holdability | Staged | Server-side cursor control |
| Positioned UPDATE / DELETE (`WHERE CURRENT OF`) | Supported | `Statement.setCursorName()` now flows into `StatementManager.prepareStatement()` via a `{ cursorName }` opts bag, which the engine forwards into `CREATE_RPB`'s `CURSOR_NAME` (CP `0x380B`) using the server CCSID, matching JTOpen's converter-based path. `Connection.prepare(sql, { cursorName })` bypasses the prepared-statement cache when a cursor name is set (a named cursor is statement-specific identity and must not be silently shared). Engine regressions assert the user-supplied name reaches the wire; live qualification on `a live IBM i host` confirmed both `UPDATE ... WHERE CURRENT OF <cursor>` and `DELETE ... WHERE CURRENT OF <cursor>` succeed against a real open cursor, so `DatabaseMetaData.supportsPositionedDelete()` / `supportsPositionedUpdate()` now return `true`. |
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

> **OUT / INOUT retrieval is Supported via protocol-level decode.**
> js400 now reads the CALL reply's parameter-row block (0x380E code
> point, gated by the ORS `RESULT_DATA` bit), mirroring JTOpen's
> `DBData parameterRow_` path. Function-return syntax
> `{ ? = call FUNC(?, ?) }` is parsed into a first-slot OUT `?` and
> classified as a CALL in the engine so the same decode path runs.
> A deterministic result-set heuristic is retained as fallback for
> older procedures that emit OUT values through `VALUES (...)`
> instead of real parameter markers.

| Feature | Status | API |
| --- | --- | --- |
| CALL execution | Supported | `conn.call(procedure, { in, out })` or `conn.prepareCall(callText)` |
| Call-text parsing | Supported | `prepareCall()` accepts `MYLIB.PROC`, `CALL MYLIB.PROC(?,?)`, `{ call MYLIB.PROC(?,?) }`, and `{ ? = call MYLIB.FUNC(?,?) }`. Function-return form reserves slot 1 as an OUT parameter for the return value. |
| IN parameters | Supported | `{ in: [value, ...] }` or `cstmt.setObject(...)` |
| OUT parameter registration | Supported | `cstmt.registerOutParameter(idx, sqlType, ...)` |
| OUT parameter retrieval | Supported | Protocol-level decode of the parameter row from code point 0x380E, mirroring JTOpen's `parameterRow_` (set via `ORS_BITMAP_RESULT_DATA`). Empty parameter names fall back to positional `col${idx}` matching. A result-set heuristic is still used when the host returns no parameter row (older procedures that emit OUT via `VALUES()`). |
| INOUT parameters | Supported | IN side encodes; OUT side decoded from the same parameter row. |
| Named parameters | Supported | `cstmt.setString("P_NAME", ...)` after `setParameterName()` |
| Multiple result sets | Partial | `getMoreResults()` drains an internal queue. CALL replies that return BOTH OUT params AND a server-side cursor are now decoded when a result-set descriptor (0x3805 / 0x3812) arrives inline with the CALL reply — the decoded rows land as `result.resultSets[0]`. When no descriptor arrives (e.g. older servers), the raw 0x380E buffers are preserved under `__raw` for a higher layer to decode. `supportsMultipleResultSets()` remains `false` until fully streaming multi-result semantics exist. |
| Typed OUT getters | Supported | `cstmt.getString()`, `getBlob()`, `getClob()`, `getSQLXML()`, `getArray()`, `getRowId()` |
| `wasNull()` | Supported | Tracks the last OUT getter |

## Generated keys

| Feature | Status | API |
| --- | --- | --- |
| Return generated keys (INSERT) | Supported | `stmt.execute(params, { returnGeneratedKeys: true })` rewrites as `SELECT * FROM FINAL TABLE (INSERT ...)`. The rewrite only runs when the flag is set; unflagged INSERTs take the normal fast path with no wrap. |
| Access generated keys as rows | Supported | `result.generatedKeys` — contains every column from `FINAL TABLE`, not just auto-generated identity columns. This is broader than the JDBC contract and reflects the DB2 for i `FINAL TABLE` shape; callers needing a narrower projection should re-select the specific identity column. |
| Access generated keys as ResultSet | Supported | `stmt.getGeneratedKeys()` — cleared at the start of every subsequent `execute()` / `executeForStream()` / `executeBatch()`. |
| Generated keys for UPDATE/DELETE/MERGE | Unsupported | Passing `returnGeneratedKeys: true` on non-INSERT DML is a silent no-op: the statement runs normally and `getGeneratedKeys()` returns an empty ResultSet. DB2 `FINAL TABLE` supports UPDATE/MERGE, but the rewrite is deliberately scoped to INSERT for JDBC parity. |

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
| `Statement.setQueryTimeout(n)` | Supported (wire cancel + post-RTT fallback) | Positive `n` arms a per-execute `setTimeout(n * 1000)` that fires `DbConnection.cancel()` on a dedicated side-channel DATABASE connection AND flips `isCancelled()`. The side channel sends `FUNCTIONID_CANCEL` (`0x1818`) with the server job identifier (`0x3826`), mirroring JTOpen's `AS400JDBCConnectionImpl.cancel`. When the side channel succeeds the in-flight RTT returns early with an interrupted SQLCA; when the server is below functional level 5 or the job identifier was not captured, the watchdog falls back cleanly to the post-RTT `SqlError(HY008)` "Query timeout exceeded" path. `n = 0` keeps the fast path: two boolean checks, no timer, no side-channel chatter, no allocation. |
| `Statement.cancel()` | Supported (wire cancel + post-RTT fallback) | Flips `isCancelled()` AND fires `DbConnection.cancel()` on the side channel. Next operation throws `SqlError(HY008)` "Statement was cancelled" and clears the flag so subsequent calls succeed. Wired on `PreparedStatement` too and applied to every execute path: `execute`, `executeForStream`, `executeCall`, `executeBatch`, generated-keys wrap, `Statement` ad-hoc immediate / batch. Mirrors JTOpen `AS400JDBCStatement.cancel` → `connection_.cancel(id_)`. |
| Side-channel cancel connection | Supported (lazy) | js400 opens a second DATABASE-service connection on first cancel (full seed / signon / exchange-attributes handshake). The socket is reused for subsequent cancels and closed on `conn.close()`. When `canCancelOnWire()` is false (server `functionalLevel < 5` or missing `serverJobIdentifier`), `DbConnection.cancel()` returns `{ sent: false, reason: … }` without opening the side channel. Diagnostic counters — `cancelCalls`, `cancelSent`, `cancelFallbacks`, `cancelChannelOpens` — are available via `conn.dbConnection.cancelMetrics`. |
| AbortSignal cancellation | Unsupported | No `signal` option on query/execute. |

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
| `ConnectionPoolDataSource` (pool lifecycle) | Supported | `cpds.getPool()` returns a `ConnectionPool`; `cpds.getPooledConnection()` checks out via `pool.getConnection()`; logical `close()` returns the physical connection to the pool. **Frozen configuration contract**: `getPool()` snapshots the DataSource's properties on first call. Subsequent mutations (e.g. `setLibraries()`) do NOT affect the live pool; call `cpds.closePool()` and then `getPool()` again to pick up new properties. This avoids silent pool churn and reconnect storms from innocent setter calls. |
| `PooledConnection` event listeners | Partial | `addConnectionEventListener` fires `connectionClosed` exactly once on logical `close()`. `addStatementEventListener` accepts listeners for JDBC shape parity but emits NO events today — do not rely on `statementClosed` / `statementErrorOccurred` until the Statement layer starts firing them. |
| `getPooledConnection(user, password)` (credentials branch) | Partial | Opens a fresh physical connection and bypasses the pool; logical `close()` physically closes it. No credential-keyed pool sub-partitioning yet. |
| JNDI `Referenceable` | Partial | `ds.getReference()` returns a plain-object descriptor; full JNDI `Context.bind()` is Java-only |
| `holdStatements` (cursor hold across commit) | Supported (opt-in) | When set on the DataSource / connect options, translates to the `HOLD_INDICATOR` code point (`0x380F`) on CREATE RPB with value `0x01`, so the server keeps cursors alive across `COMMIT`. Unset leaves DB2 on its default (cursor closes at commit). Zero on-wire change when the knob is off (regression test captures the CREATE_RPB packet and asserts the CP is absent). **Runtime impact note:** a live commit-heavy bench on a live IBM i host (30 iterations of prepare-once-and-commit-per-execute, in `.agent/bench.js` `BENCH_COMMIT=1`) shows the knob measured on the wire but *not* visible in the `prep=1 exec=30 fetch=60 closeCrsr=30` counters, because js400's `PreparedStatementCache` already keeps the prepared handle alive across commits and `PreparedStatement.execute()` auto-closes the cursor after `toArray()`. `holdStatements` will materially matter in patterns where the user keeps a cursor open across a commit (`executeForStream` + partial iteration + commit + continue) — that pattern isn't in the default benchmark but the hook is in place. |
| `extendedDynamic` / `packageCache` / `sqlPackage` / `packageLibrary` / `packageError` / `packageCriteria` | Supported (pending live-host qualification) | `extendedDynamic=true` + a `sqlPackage` name enables JTOpen `JDPackageManager` behavior. On first prepare or `executeImmediate`, js400 sends `CREATE_PACKAGE` (`0x180F`) on a dedicated connection-scoped RPB with `PACKAGE_NAME` (`0x3804`) + `LIBRARY_NAME` (`0x3801`). For prepared statements, `CREATE_RPB` also binds `LIBRARY_NAME` on the statement RPB. Subsequent packageable prepares / `EXECUTE_IMMEDIATE` emit `PACKAGE_NAME` + `prepareOption=1`; unpackageable prepares emit the empty `PACKAGE_NAME` codepoint (length-only). Package name normalization is byte-for-byte JTOpen — up to 6 chars + 4-char suffix over `commitMode`, `dateFormat`, `dateSeparator`, `timeFormat`, `timeSeparator`, `decimalSeparator`, `naming`, `translateHex`, including the `commitMode=4`/RR dateSep remap. `packageError` honors `none` / `warning` / `exception` — `warning` queues a `SqlWarning` via `DbConnection.drainPackageWarning()`. `packageCache=true` fires `RETURN_PACKAGE` (`0x1815`) after create, decodes the `DBReplyPackageInfo` blob (code point `0x380B`) and stores per-statement metadata (name, SQL text, result/parameter formats). On a cache hit, js400 **skips** `PREPARE_AND_DESCRIBE`, keeps the local prepared statement name, and reuses the cached package statement name as a JTOpen-style execute-time override. The subsequent `OPEN_AND_DESCRIBE` (SELECT) or `EXECUTE` (DML) sends `PREPARED_STATEMENT_NAME` (`0x3806`) only for cache hits, while packaged statements continue to send `PACKAGE_NAME` (`0x3804`) on the execution path. LOB/locator descriptors in the cached entry force a fallback to normal prepare (matching JTOpen). `packageCriteria` defaults to `"default"` (standard `isPackaged` heuristic); `"select"` additionally packages plain `SELECT` statements. `packageCriteria` flows through `connect()`, `createPool()`, `DbConnection`, and into `PackageManager`. Counters: `packageCreates`, `packageFetches`, `packageHits` on `StatementManager.metrics`. Knobs-off path is unchanged on the wire. **Pending:** live-host qualification for RETURN_PACKAGE decode, cached prepare bypass, and end-to-end SELECT/DML execution through a cached package entry. See [SQL Packages](sql-packages.md). |
| `blockSize` | Supported (opt-in, runtime) | Explicit `blockSize` now drives JTOpen-style row blocking for read-only SELECTs: js400 computes a row-count blocking factor as `floor(blockSizeKB * 1024 / rowLength)`, capped to `32767`, and uses that for the OPEN request and the default FETCH size when the caller did not set `Statement.setFetchSize()`. The knob is **opt-in only**: default callers keep js400's existing fetch behavior. Live a live IBM i host qualification showed that `blockSize=32` can be materially slower on wide-row scans (`80k` rows: Mode A `8575 rows/sec` without the knob vs `2580 rows/sec` with it; many more fetch RTTs), so this is parity behavior, not a new default tuning recommendation. |
| Driver properties (`prefetch`, `lazyClose`, `queryTimeoutMechanism`, ...) | Stored only | Stored verbatim on the DataSource and threaded through `connect()`. They do NOT yet drive runtime behavior; getters/setters exist for configuration round-trip only. Inline first-block prefetch is currently disabled on the default path because live-host qualification found broken `OPEN_DESCRIBE_FETCH` results on real singleton/catalog queries. |
| Client reroute / affinity | Stored only | Configuration accepted but the reroute / failover logic is not implemented |

## Intentionally unsupported

These families are **out of scope for js400** and will not be implemented
unless a separate plan is filed for them. They are Java-enterprise or
Java-ecosystem patterns that do not translate usefully to JavaScript, or
that are deliberately superseded by Node-native idioms. The `src/db/`
barrel does not export any of these class names, so callers that import
them will get a static `undefined` instead of a half-built implementation.

| Feature | Reason |
| --- | --- |
| XA transactions (`XADataSource`, `XAConnection`, `XAResource`) | JTA/XA is a Java enterprise pattern with no direct JS equivalent. Distributed-transaction coordination is outside the SQL-client scope. |
| JDBC RowSet family (`JdbcRowSet`, `CachedRowSet`, `FilteredRowSet`, `WebRowSet`) | Java-specific convenience layer on top of ResultSet. Node code uses arrays and async iterables; there is no parity target. |
| Full JNDI integration (`Context.bind`, `InitialContext.lookup`, `Referenceable` via JNDI) | `DataSource.getReference()` returns a plain-object snapshot so configuration round-trips, but full JNDI directory binding is a JVM-only concept. |
| DriverManager service-provider loading | Use `sql.connect()` or `new DataSource()` directly. |
| Java stream adapters (`InputStream`, `OutputStream`, `Reader`, `Writer`) | Use Node.js streams and `Buffer`. |
| Swing / `vaccess` SQL UI classes | Out of scope (JVM UI). |
| `com.ibm.as400.micro` JDBC-ME | Out of scope (obsolete mobile profile). |

Source: [`src/db/index.js`](../src/db/index.js), [`src/db/properties.js`](../src/db/properties.js)
