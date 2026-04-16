# User Space

User spaces are IBM i objects that provide a block of storage accessible from programs. js400 manages user spaces through the QUSCRTUS, QUSRTVUS, QUSCHGUS, and QUSDLTUS system APIs.

## Create a user space

```js
import { AS400, UserSpace } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const us = new UserSpace(system, '/QSYS.LIB/MYLIB.LIB/MYSPACE.USRSPC');

await us.create({
  size: 4096,            // initial size in bytes
  initialValue: 0x00,    // fill byte
  authority: '*ALL',     // public authority
  description: 'My user space',
  replace: false,        // replace if exists
});
```

## Read from a user space

```js
const data = await us.read({
  offset: 0,
  length: 100,
});
console.log(data); // Buffer
```

## Write to a user space

```js
await us.write({
  offset: 0,
  data: Buffer.from('Hello from js400'),
});
```

## Delete a user space

```js
await us.delete();
```

## Constructor

```js
new UserSpace(system, path)
```

- `system` -- an `AS400` instance
- `path` -- IFS-style path, e.g. `/QSYS.LIB/MYLIB.LIB/MYSPACE.USRSPC`

## Properties

| Property | Type | Description |
| --- | --- | --- |
| `path` | `string` | Full IFS path |
| `library` | `string` | Library name |
| `name` | `string` | Object name |

## Create options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `size` | `number` | `1024` | Initial size in bytes |
| `initialValue` | `number` | `0x00` | Fill byte |
| `authority` | `string` | `'*ALL'` | Public authority |
| `description` | `string` | `''` | Text description |
| `extendedAttribute` | `string` | `''` | Extended attribute |
| `replace` | `boolean` | `false` | Replace existing |

Source: [`src/objects/UserSpace.js`](../src/objects/UserSpace.js)
