# SQL Packages (extendedDynamic)

js400 ports JTOpen's `JDPackageManager` family to JavaScript so a
shared server-side SQL package can cache the access plans for
parameterized statements across connections. Two clients with the
same connection properties — whether both are js400, both are JTOpen,
or one of each — converge on the same package name and can reuse
each other's cached plans.

Upstream:

- [`JDPackageManager.java`](../JTOpen/src/main/java/com/ibm/as400/access/JDPackageManager.java)
- [`AS400JDBCStatement#commonPrepare`](../JTOpen/src/main/java/com/ibm/as400/access/AS400JDBCStatement.java)
- [`JDSQLStatement#analyzeBody`](../JTOpen/src/main/java/com/ibm/as400/access/JDSQLStatement.java) for the `isPackaged` heuristic
- [`DBReplyServerAttributes`](../JTOpen/src/main/java/com/ibm/as400/access/DBReplyServerAttributes.java) for the functional-level / job-id extraction

## When to use it

Turn `extendedDynamic` on when your app does a lot of **repeated
parameterized prepares** and you want the server to cache each one's
access plan on its side. Typical patterns:

- Batch jobs that open a connection, prepare the same SQL shapes
  thousands of times, and close.
- Pooled web apps where each new physical connection re-prepares
  the same set of parameterized queries.
- Inter-client compatibility with JTOpen apps that are already
  targeting a specific package.

If your app only runs a handful of prepares per connection, leave
the knob off — the default path is already the fast path.

## Quick start

```js
import { sql } from 'js400';

const conn = await sql.connect({
  host, user, password,

  // Enable extended dynamic. Off by default.
  extendedDynamic: true,

  // Package identity. Truncated to 6 chars + a 4-char suffix
  // encoding the connection's semantics. Default library is QGPL.
  sqlPackage: 'MYAPP',
  packageLibrary: 'QGPL',

  // Optional: pull the package blob down after create. Sets up
  // the cache-hit skip-prepare path once live qualification lands.
  packageCache: true,

  // Failure policy: 'none' | 'warning' (default) | 'exception'.
  packageError: 'warning',
});
```

The full example lives at [`examples/sql-packages.js`](../examples/sql-packages.js).

## Configuration reference

| Property | Type | Default | Effect |
| --- | --- | --- | --- |
| `extendedDynamic` | boolean | `false` | Master switch. When false, every knob below is ignored and the engine emits no package codepoints. |
| `sqlPackage` | string | — | Package name. Required when `extendedDynamic=true`; missing/empty disables the manager with a warning-equivalent (`JDError.WARN_EXTENDED_DYNAMIC_DISABLED`). |
| `packageLibrary` | string | `QGPL` | Library that owns the package. Uppercased. |
| `packageCache` | boolean | `false` | When true, fires `FUNCTIONID_RETURN_PACKAGE` (`0x1815`) after create and caches the raw reply blob. |
| `packageError` | `'none'` \| `'warning'` \| `'exception'` | `'warning'` | Controls what happens when `CREATE_PACKAGE` fails on the wire. See below. |
| `holdStatements` | boolean | — | Orthogonal. Keeps cursors across commit; often paired with extended-dynamic workloads. |

## Package name normalization

js400 mirrors `JDPackageManager.getSuffix` byte-for-byte. The
normalized name is `toUpperCase(first-6-chars-of-sqlPackage)` with
spaces mapped to `_`, followed by a 4-character suffix derived from:

| Suffix char | Encodes | JTOpen index (0-based) |
| --- | --- | --- |
| 1 | `translateHex` | 0 = character, 1 = binary |
| 2 | `commitMode << 3 \| dateFormat` | commitMode 0..3; the `commitMode = 4` (*RR*) case is remapped — see below |
| 3 | `decimalSeparator << 4 \| naming << 3 \| dateSeparator` | |
| 4 | `timeFormat << 2 \| timeSeparator` | |

The **RR remap**: `*RR` (commitMode=4) doesn't fit in the two
commit-mode bits, so JTOpen repurposes unused dateSep values 5–7
to carry the RR state, and stores the real dateSep in what looks
like the commit-mode slot. The bijection is preserved: given any
suffix character you can recover `(commitMode, dateSep)`.

Because the encoding is deterministic and identical across clients,
two connections with the same property values will produce the same
package name. Two connections that differ — say, `dateFormat='*ISO'`
vs `dateFormat='*USA'` — will deliberately produce different package
names so they don't poison each other's cached plans.

## Packageable vs unpackageable SQL

Not every statement is eligible for the package. js400 ports
`JDSQLStatement#analyzeBody`'s 2011-11-29 rule:

```
isPackaged =   ((numberOfParameters > 0) && !isCurrentOf)
            || (isInsert && isSubSelect)
            || ((isSelect OR isWith OR isValues) && isForUpdate)
            || isDeclare
```

Concretely:

- `SELECT * FROM T WHERE ID = ?` → packageable.
- `SELECT * FROM T` (no params) → not packageable.
- `INSERT INTO T1 SELECT * FROM T2` → packageable (INSERT + sub-select).
- `UPDATE T SET X = ? WHERE CURRENT OF MYCURSOR` → **not** packageable (positioned update).
- `DECLARE MYCUR CURSOR FOR SELECT …` → packageable.

Critically, the classifier is **tokenizer-correct**: `?` inside a
string literal, double-quoted identifier, line comment, or block
comment is **not** counted as a parameter marker. Regression tests
in `tests/12-sql-api/package-manager.test.js` pin this down against
the cases JTOpen's tokenizer handles.

When the manager is enabled but the statement is unpackageable,
js400 emits an **empty PACKAGE_NAME codepoint** (length-only, no
value). This mirrors JTOpen's `setPackageName(null, converter)` —
the server understands "this statement is not eligible for the
package" even though the connection itself is package-bound.

## Connection-scoped RPB

JTOpen's `JDPackageManager` sends `CREATE_PACKAGE` / `RETURN_PACKAGE`
on the connection's `id_`, NOT on any individual statement's RPB.
js400 matches this: `DbConnection.connect()` reserves a dedicated
connection-scoped RPB id for the package manager. The first prepare
sees `pkg.rpbId`, not `stmt.rpbId`, on the CREATE_PACKAGE request —
so a failed create never corrupts in-flight statement state, and
the package binding on subsequent prepares is wholly decoupled from
the statement the first create happened to ride alongside.

## packageError policy

What happens when `CREATE_PACKAGE` fails on the wire:

| Policy | Behavior |
| --- | --- |
| `exception` | Throws a `SqlError`-shape error from the prepare path. Manager disables. Best for CI / test environments where a mis-configured package is a hard failure. |
| `warning` (default) | Manager disables. A `SqlWarning` with the server's SQLSTATE + SQLCODE is queued for `Connection.getWarnings()` via `DbConnection.drainPackageWarning()`. The prepare proceeds on the plain prepare path. Matches JTOpen's default. |
| `none` | Manager disables. No warning posted. Prepare continues. |

JTOpen handles `SQLCODE -601` ("package already exists") specially:
it still counts as "created" for `isCreated()`. js400 does the same.

## Counters

`StatementManager.metrics` exposes three read-through counters:

| Counter | When it ticks |
| --- | --- |
| `packageCreates` | Every successful `FUNCTIONID_CREATE_PACKAGE` round-trip (including SQLCODE -601). |
| `packageFetches` | Every successful `FUNCTIONID_RETURN_PACKAGE` round-trip when `packageCache=true`. |
| `packageHits` | Stays at `0` until the cache-hit skip-prepare path lands (see "Open work" below). |

Read them via `conn.dbConnection.statementManager.metrics` or through
the bench harness (`.agent/bench.js` prints them when any is non-zero).

## Performance notes

- **Knob off is free.** `extendedDynamic=false` (the default) skips
  every package code path. No CREATE_PACKAGE round-trip, no extra
  codepoints on PREPARE_AND_DESCRIBE / EXECUTE_IMMEDIATE, no extra
  allocations.
- **First prepare pays once.** When the knob is on, the first
  eligible prepare pays one extra `FUNCTIONID_CREATE_PACKAGE`
  round-trip. Every subsequent prepare attaches the PACKAGE_NAME
  + LIBRARY_NAME codepoints but does not re-create.
- **`packageCreates = 1` is not a speed win by itself** — it's an
  extra round-trip. The real win happens once the server starts
  reusing cached access plans across connections with the same
  package name, and (when it lands) once the skip-prepare path
  bypasses `PREPARE_AND_DESCRIBE` for cached statements.

## Open work (deferred, tracked in `.agent/DB2-AGENT-GAP-REPORT.md`)

1. **`DBReplyPackageInfo` decode + `packageHits` skip-prepare.**
   Needs live-host evidence against a real DB2 for i before it's
   worth implementing, because the `DBReplyPackageInfo` layout is
   server-version-dependent.
2. **`packageCriteria` property.** JTOpen defaults to `"default"`,
   which is already what js400 emits; the `"select"` variant that
   adds plain SELECTs to the packageable set is unimplemented.
3. **Live-host qualification** of the whole flow against a real
   server.

None of these affect callers who use the feature today — packages
are created, per-prepare binding works, and the failure policy is
honored; what's deferred is the final hop that lets the client
**skip** a prepare entirely when the cached plan is already there.
