# Print (Output Queues and Spooled Files)

js400 provides access to IBM i output queues and spooled files through the print host server protocol.

## List spooled files in an output queue

```js
import { AS400, OutputQueue } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const outq = new OutputQueue(system, '/QSYS.LIB/QUSRSYS.LIB/QPRINT.OUTQ');
const spooledFiles = await outq.list();

for (const sf of spooledFiles) {
  console.log(sf.name, sf.number, sf.status, sf.jobName);
}

await system.close();
```

## Read a spooled file

```js
import { AS400, SpooledFile } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

// Create a SpooledFile reference from known attributes
const sf = new SpooledFile(system, {
  name: 'QSYSPRT',
  number: 1,
  jobName: 'MYUSER',
  jobUser: 'MYUSER',
  jobNumber: '123456',
});

const content = await sf.read();
console.log(content.toString());

await system.close();
```

## OutputQueue

### Constructor

```js
new OutputQueue(system, path)
```

- `path` -- IFS-style path, e.g. `/QSYS.LIB/MYLIB.LIB/MYOUTQ.OUTQ`

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `list()` | `Promise<SpooledFile[]>` | List spooled files in the queue |

## SpooledFile

### Constructor

```js
new SpooledFile(system, attributes)
```

### Attributes

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Spooled file name |
| `number` | `number` | Spooled file number |
| `jobName` | `string` | Job name |
| `jobUser` | `string` | Job user |
| `jobNumber` | `string` | Job number |
| `status` | `string` | Spooled file status |

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `read()` | `Promise<Buffer>` | Read the spooled file content |

## Additional print classes

js400 also exports these print-related classes for advanced use:

- `SpooledFileOutputStream` -- create new spooled files
- `Printer` -- printer information
- `PrinterFile` -- printer file attributes
- `WriterJob` -- writer job control
- `AFPResource` -- AFP resource management
- `PrintObject` -- base class for print objects
- `PrintParameterList` -- parameter list for print operations

Source: [`src/print/OutputQueue.js`](../src/print/OutputQueue.js), [`src/print/SpooledFile.js`](../src/print/SpooledFile.js)
