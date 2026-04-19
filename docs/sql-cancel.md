# Cancel and Query Timeout

js400 mirrors JTOpen's two-connection cancel model:
`AS400JDBCConnectionImpl.cancel` + `AS400JDBCQueryCancelThread`.
A long-running `executeQuery`, `executeUpdate`, or streaming fetch
can be interrupted mid-round-trip by sending `FUNCTIONID_CANCEL`
(`0x1818`) on a **second** DATABASE-service connection that names
the primary connection's server job.

Upstream:

- [`AS400JDBCConnectionImpl.cancel(int id)`](../JTOpen/src/main/java/com/ibm/as400/access/AS400JDBCConnectionImpl.java)
- [`AS400JDBCQueryCancelThread`](../JTOpen/src/main/java/com/ibm/as400/access/AS400JDBCQueryCancelThread.java)
- [`DBSQLRequestDS#setJobIdentifier`](../JTOpen/src/main/java/com/ibm/as400/access/DBSQLRequestDS.java) for the 0x3826 code point
- [`DBReplyServerAttributes#getServerJobIdentifier`](../JTOpen/src/main/java/com/ibm/as400/access/DBReplyServerAttributes.java)

## Two APIs, one mechanism

Both `Statement.cancel()` / `PreparedStatement.cancel()` and the
`setQueryTimeout(n)` watchdog drive the same pipeline:

1. **Local flag.** Flip `#cancelled`. The next operation throws
   `SqlError(HY008)` and clears the flag, so a cancelled statement
   stays usable afterwards.
2. **Wire cancel (best-effort).** Fire
   `DbConnection.cancel()` as a fire-and-forget on a side-channel
   DATABASE connection. When it succeeds the primary `sendAndReceive`
   returns early with an interrupted SQLCA; when it fails, the
   post-RTT `HY008` throw still fires.

```js
import { sql } from 'js400';

const conn = await sql.connect({ host, user, password });
const stmt = conn.createStatement();

// Arms a 2-second watchdog.
stmt.setQueryTimeout(2);

try {
  await stmt.executeQuery(/* long-running SQL */);
} catch (err) {
  // err.messageId === 'HY008' — either because the watchdog expired
  // OR because an external cancel() fired. Same exception shape.
  console.log(err.message);
}
```

Full walkthrough at [`examples/sql-cancel.js`](../examples/sql-cancel.js).

## The guard: `canCancelOnWire()`

JTOpen's cancel is gated by **two** conditions:

```java
if ((serverJobIdentifier_ != null) && (serverFunctionalLevel_ >= 5))
```

js400 exposes the same guard on `DbConnection`:

```js
const db = conn.dbConnection;
db.canCancelOnWire();  // true only when both conditions hold
```

Both halves come from the exchange-attributes reply (code point
`0x3804`):

- `serverFunctionalLevel` — a 10-char decimal string at offset +50
  in the reply. Levels ≥ 5 implement `FUNCTIONID_CANCEL`.
- `serverJobIdentifier` — a 26-byte job identifier (job name + user
  + number) at offset +88 in the server CCSID. The side channel
  uses this to name the target job in the cancel request.

When the guard is false — older servers, missing job id — `cancel()`
still works at the api level (the `#cancelled` flag flips and the
next op throws), but no wire cancel is sent. Long queries then
have to wait for their natural RTT finish before `HY008` fires.

## The side channel

js400 opens the cancel channel **lazily** on the first `cancel()`
call that passes the guard. The second connection goes through the
full DATABASE-service handshake (seed exchange → server start →
exchange attributes) using the same AS400 credentials as the primary.

After that the socket is cached and reused; subsequent cancels pay
only the round-trip for the cancel packet itself.

```js
// The cancel channel is NOT open here — fast-path connect.
const conn = await sql.connect({ host, user, password });

// Still not open: default path never touches it.
await conn.query('SELECT 1 FROM SYSIBM.SYSDUMMY1');

// Opens the side channel now (one-time signon cost), sends
// FUNCTIONID_CANCEL, returns.
stmt.cancel();

// Reuses the same socket from now on.
stmt2.cancel();
```

The channel closes when `conn.close()` closes the primary.

### Concurrent first-cancel coalescing

If two cancels fire before the first handshake finishes, js400
coalesces them via a shared promise — we don't spin up two side
channels for a race.

## Diagnostic counters

Four counters on `conn.dbConnection.cancelMetrics` let tests and
benches tell whether a cancel took the wire path or fell back:

| Counter | When it ticks |
| --- | --- |
| `cancelCalls` | Every `DbConnection.cancel()` invocation (i.e. every time the api layer dispatched a cancel, from `cancel()` or the watchdog). |
| `cancelSent` | Every completed `FUNCTIONID_CANCEL` round-trip on the side channel. |
| `cancelFallbacks` | Every cancel that went to the post-RTT `HY008` fallback — server below functional level 5, missing job id, side channel refused, or the cancel send threw. |
| `cancelChannelOpens` | Increments the first time the side channel comes up. A healthy long-lived connection with many cancels should see this stay at `1`. |

These stay at 0 on the default path — `queryTimeout = 0` and no
explicit `cancel()` never touches the metrics.

## Performance contract

**Zero-cost when you don't ask for cancellation.** The fast path
in `Statement.#runWithCancellation` and its PreparedStatement twin
is:

```js
if (this.#cancelled) { /* throw HY008 */ }
if (this.#queryTimeout <= 0) return invoke();
```

Two boolean checks, no `setTimeout`, no `Promise.race`, no side
channel, no extra heap allocation. Every other path — including
the watchdog's `setTimeout` and the side-channel dispatch — only
runs when the caller explicitly opts in.

A regression test (`tests/12-sql-api/cancel-side-channel.test.js` —
"queryTimeout = 0 takes the fast path") asserts that a normal
execute under `queryTimeout = 0` never calls `DbConnection.cancel()`.

## Fire-and-forget semantics

`Statement.cancel()` **does not await** the wire cancel. It flips
the local flag, kicks off `DbConnection.cancel()`, and returns
synchronously. This matches JTOpen's `AS400JDBCQueryCancelThread`
pattern (JTOpen uses a real thread; js400 uses a setTimeout +
microtask, but the observable contract is identical).

If the caller depends on the cancel completing before their next
operation runs, they should check `stmt.isCancelled()` or await the
in-flight promise first — the cancel and the running execute race
by design.

## Known limitations

1. **Live-host qualification is still the final gate.** All paths
   are covered by unit / wire-shape / mock-engine tests, but a real
   DB2 for i interrupt of a long-running SELECT is what will let
   docs drop the "pending live qualification" language.
2. **`queryTimeoutMechanism` property.** JTOpen offers two modes
   (server-side RPB timeout vs client-side watchdog). js400
   currently implements only the client-side watchdog; the property
   is stored verbatim but not acted on.
3. **AbortSignal.** Not supported. Feature request-sized work;
   tracked as the `AbortSignal cancellation` row in
   `docs/sql-feature-matrix.md`.
