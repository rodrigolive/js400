# js400

`js400` is a pure JavaScript IBM i client library for Node.js and Bun.
It is built as a protocol-focused port of IBM's JTOpen project, with
special attention to host-server wire compatibility instead of JVM-only
infrastructure.

## Install

```sh
npm install js400
# or
bun add js400
```

## Quick start

```js
import { sql } from 'js400';

const conn = await sql.connect({
  host: 'your-ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
});

const rows = await conn.query('SELECT * FROM MYLIB.CUSTOMER');
console.log(rows);

await conn.close();
```

## Main docs

- [Getting Started](docs/getting-started.md)
- [SQL](docs/sql.md)
- [SQL Feature Matrix](docs/sql-feature-matrix.md)
- [Unsupported or Redesigned Upstream Surface](docs/unsupported.md)

## JTOpen parity addendum

`js400` is not yet a drop-in replacement for every JTOpen class or JDBC
edge case. The main remaining gaps are:

- Some Java-only JTOpen families are intentionally not ported:
  proxy/RMI layers, GUI dialogs, JNDI/JTA/XA glue, RowSet/BeanInfo
  scaffolding, and other JVM-only support code.
- Some SQL/JDBC behavior is still partial:
  full multi-result-set streaming via `getMoreResults()`, updatable or
  sensitive result sets, and a few metadata and type-system edges.
- Some connection properties are accepted for compatibility but are not
  fully active at runtime yet, especially prefetch-related and reroute
  settings.
- Some JTOpen-faithful wire paths are implemented but still need more
  live IBM i qualification, especially SQL package cache reuse and
  wire-level cancel on real hosts.

For the maintained detail, see
[docs/sql-feature-matrix.md](docs/sql-feature-matrix.md) and
[docs/unsupported.md](docs/unsupported.md).
