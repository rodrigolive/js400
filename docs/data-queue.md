# Data Queue

Data queues are a lightweight inter-process communication mechanism on IBM i. js400 supports both standard and keyed data queues through the data queue host server protocol.

## DataQueue (non-keyed)

```js
import { AS400, DataQueue } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const dq = new DataQueue(system, '/QSYS.LIB/MYLIB.LIB/MYDQ.DTAQ');
```

### Write to a queue

```js
await dq.write('Hello from js400');
await dq.write(Buffer.from([0x01, 0x02, 0x03])); // binary data
```

### Read from a queue

```js
// Read with wait (seconds), -1 = wait forever, 0 = no wait
const entry = await dq.read(10);
if (entry) {
  console.log('Data:', entry.data);          // Buffer
  console.log('Sender:', entry.senderInfo);  // sender information
}
```

### Peek (read without removing)

```js
const entry = await dq.peek(5);
```

### Clear the queue

```js
await dq.clear();
```

### Create and delete

```js
await dq.create({ maxEntryLength: 256 });
await dq.delete();
```

### Get attributes

```js
const attrs = await dq.getAttributes();
console.log(attrs.maxEntryLength);
console.log(attrs.currentEntryCount);
```

## KeyedDataQueue

Keyed data queues allow reading entries by key value:

```js
import { AS400, KeyedDataQueue } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const kdq = new KeyedDataQueue(system, '/QSYS.LIB/MYLIB.LIB/MYKEYDQ.DTAQ');
```

### Write with key

```js
await kdq.write('ORDERKEY01', 'Order data here');
```

### Read by key

```js
// Search types: 'EQ' (equal), 'GE' (>=), 'GT' (>), 'LE' (<=), 'LT' (<)
const entry = await kdq.read('ORDERKEY01', 10, 'EQ');
if (entry) {
  console.log('Key:', entry.key);
  console.log('Data:', entry.data);
}
```

### Peek by key

```js
const entry = await kdq.peek('ORDERKEY01', 5, 'EQ');
```

### Create keyed queue

```js
await kdq.create({ maxEntryLength: 256, keyLength: 10 });
```

## DataQueueEntry

Entries returned from `read()` or `peek()` contain:

| Field | Type | Description |
| --- | --- | --- |
| `data` | `Buffer` | Entry data |
| `senderInfo` | `string` | Sender identification |

## KeyedDataQueueEntry

Extends `DataQueueEntry` with:

| Field | Type | Description |
| --- | --- | --- |
| `key` | `Buffer` | Entry key |

## DataQueueAttributes

Returned from `getAttributes()`:

| Field | Type | Description |
| --- | --- | --- |
| `maxEntryLength` | `number` | Maximum entry length in bytes |
| `keyLength` | `number` | Key length (0 for non-keyed) |
| `currentEntryCount` | `number` | Number of entries currently in the queue |
| `saveSenderInfo` | `boolean` | Whether sender info is saved |
| `fifo` | `boolean` | FIFO ordering (vs LIFO) |
| `forceToStorage` | `boolean` | Force entries to auxiliary storage |

Source: [`src/objects/data-queue.js`](../src/objects/data-queue.js)
