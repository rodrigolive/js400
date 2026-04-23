# Getting Started

## Install

```sh
npm install js400
# or
bun add js400
```

js400 is a pure JavaScript client for IBM i (AS/400) host servers. It has zero production dependencies and runs on Node.js 20+ and Bun without native add-ons.

## Connect with password

```js
import { AS400 } from 'js400';

const system = new AS400({
  host: 'your-ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
});

await system.signon();
console.log('Signed on:', system.getSignonJobName());
```

## Connect securely (TLS)

```js
import { AS400 } from 'js400';

const system = new AS400({
  host: 'your-ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
  secure: true,
});

await system.signon();
```

If the IBM i system uses a self-signed certificate you can pass TLS options:

```js
const system = new AS400({
  host: 'your-ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
  secure: true,
  tlsOptions: { rejectUnauthorized: false },
});
```

## Call a program

```js
import { AS400 } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const result = await system.callProgram({
  program: '/QSYS.LIB/MYLIB.LIB/MYPGM.PGM',
  parameters: [
    { type: 'char', length: 10, value: 'HELLO', usage: 'input' },
    { type: 'char', length: 50, usage: 'output', trim: true },
  ],
});

console.log(result.parameters[1].value);
await system.close();
```

## Run a CL command

```js
const messages = await system.runCommand('CRTLIB LIB(TESTLIB)');
for (const msg of messages) {
  console.log(`${msg.id}: ${msg.text}`);
}
```

## Run SQL

```js
import { sql } from 'js400';

const conn = await sql.connect({
  host: 'your-ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
});

const rows = await conn.query('SELECT * FROM MYLIB.CUSTOMER');
for (const row of rows) {
  console.log(row.CUSNUM, row.CUSNAM);
}

await conn.close();
```

## Read an IFS file

```js
const system = new AS400({ host, user, password });
await system.signon();

const fs = system.ifs();
const data = await fs.readFile('/home/MYUSER/test.txt');
console.log(data.toString());

await system.close();
```

## Write an IFS file

```js
const fs = system.ifs();
await fs.writeFile('/tmp/output.txt', 'Hello from js400');
```

## Read a data queue

```js
import { AS400, DataQueue } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const dq = new DataQueue(system, '/QSYS.LIB/MYLIB.LIB/MYDQ.DTAQ');
const entry = await dq.read(10); // wait up to 10 seconds
if (entry) {
  console.log('Data:', entry.data.toString());
}

await system.close();
```

## Read a spooled file

```js
import { AS400, OutputQueue, SpooledFile } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const outq = new OutputQueue(system, '/QSYS.LIB/QUSRSYS.LIB/QPRINT.OUTQ');
const spooledFiles = await outq.list();

for (const sf of spooledFiles) {
  console.log(sf.name, sf.number, sf.status);
}

await system.close();
```

## Next steps

- [Authentication](./authentication.md) -- profile tokens, password levels, TLS
- [Program Call](./program-call.md) -- ProgramCall, ServiceProgramCall
- [Command Call](./command-call.md) -- running CL commands
- [SQL](./sql.md) -- queries, prepared statements, streaming
- [IFS](./ifs.md) -- file operations on the Integrated File System
- [Data Types](./data-types.md) -- AS400 binary type converters
- [Tracing](./tracing.md) -- diagnostic tracing and hex dumps

Source: [`src/core/AS400.js`](../src/core/AS400.js), [`src/db/connect.js`](../src/db/connect.js)

## JTOpen parity addendum

`js400` is a protocol-focused port of JTOpen, but it is not yet
fully equiparable to every JTOpen package and JDBC edge case.

- Java-only families such as proxy/RMI layers, GUI dialogs, JNDI/JTA/XA,
  RowSet, and BeanInfo metadata are intentionally not part of js400.
- The core IBM i paths are here, but some SQL/JDBC features are still
  partial, especially full multi-result-set streaming, updatable or
  sensitive result sets, and a few metadata/type edges.
- Some compatibility properties are accepted but not fully active at
  runtime yet, especially prefetch-related and reroute settings.
- Some newer JTOpen-faithful wire paths still need more live-host
  validation on real IBM i systems, especially package-cache reuse and
  wire cancel.

For the maintained detail, see [SQL Feature Matrix](./sql-feature-matrix.md)
and [Unsupported or Redesigned Upstream Surface](./unsupported.md).
