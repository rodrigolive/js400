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
| BLOB read | Supported | Returned as `Buffer` |
| CLOB read | Supported | Returned as `string` |
| BLOB streaming | Supported | `blob.getReadableStream()` |
| CLOB streaming | Supported | `clob.getReadableStream()` |
| BLOB write | Supported | Pass `Buffer` as parameter |
| CLOB write | Supported | Pass `string` as parameter |
| SQLXML read | Supported | `await value.text()` |

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

| Feature | Status | API |
| --- | --- | --- |
| CALL execution | Supported | `conn.call(procedure, { in, out })` |
| IN parameters | Supported | `{ in: [value, ...] }` |
| OUT parameters | Supported | `{ out: [{ type, ... }] }` |
| INOUT parameters | Staged | Combined in/out parameters |
| Multiple result sets | Staged | `result.resultSets` |

## Generated keys

| Feature | Status | API |
| --- | --- | --- |
| Return generated keys | Supported | `conn.execute(sql, params, { returnGeneratedKeys: true })` |
| Access generated keys | Supported | `result.generatedKeys` |

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

## Intentionally unsupported

| Feature | Reason |
| --- | --- |
| XA transactions | JTA/XA is a Java enterprise pattern with no JS equivalent |
| JNDI DataSource | Java naming integration does not map to JS modules |
| JDBC RowSet wrappers | Java-specific convenience; use arrays and iterables |
| DriverManager | Java service-provider pattern; use `sql.connect()` |
| Connection redirect | Java-specific failover mechanism |
| Java stream adapters (`InputStream`, `OutputStream`, `Reader`, `Writer`) | Use Node.js streams and `Buffer` |
| ResultSetMetaData as separate object | Inline in result objects |
| ParameterMetaData as separate object | Inline in prepared statement |

Source: [`src/db/index.js`](../src/db/index.js), [`src/db/properties.js`](../src/db/properties.js)
