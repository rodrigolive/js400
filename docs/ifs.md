# IFS (Integrated File System)

js400 provides file operations on the IBM i Integrated File System through the IFS host server protocol.

## Convenience API via AS400.ifs()

The simplest approach uses the `system.ifs()` helper:

```js
import { AS400 } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();
const fs = system.ifs();

// Read a binary file
const data = await fs.readFile('/home/MYUSER/document.pdf');

// Read a text file (CCSID-aware)
const text = await fs.readTextFile('/home/MYUSER/notes.txt');

// Write a binary file
await fs.writeFile('/tmp/output.bin', Buffer.from([0x01, 0x02, 0x03]));

// Write a text file
await fs.writeTextFile('/tmp/hello.txt', 'Hello from js400');

// List directory
const names = await fs.readdir('/home/MYUSER');
console.log(names);

// Detailed directory listing
const entries = await fs.readdirDetail('/home/MYUSER');
for (const entry of entries) {
  console.log(entry.name, entry.isDirectory, entry.size);
}

// File info
const info = await fs.stat('/home/MYUSER/notes.txt');
console.log(info);
// { exists: true, isDirectory: false, isFile: true, size: 1024, modified: Date, created: Date, path: '...' }

// Create directories
await fs.mkdir('/tmp/newdir');
await fs.mkdirs('/tmp/a/b/c'); // creates parent dirs

// Delete, rename, copy
await fs.unlink('/tmp/old.txt');
await fs.rename('/tmp/a.txt', '/tmp/b.txt');
await fs.copyFile('/tmp/src.txt', '/tmp/dst.txt');

await system.close();
```

## IFSFile class

For more control, use `IFSFile` directly:

```js
import { AS400, IFSFile } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const file = new IFSFile(system, '/home/MYUSER/test.txt');

console.log('Exists:', await file.exists());
console.log('Is file:', await file.isFile());
console.log('Is dir:', await file.isDirectory());
console.log('Size:', await file.length());
console.log('Modified:', await file.lastModified());
console.log('Created:', await file.created());

// List directory contents
const dir = new IFSFile(system, '/home/MYUSER');
const names = await dir.list();
const files = await dir.listFiles(); // returns IFSFile objects

// File operations
await file.mkdir();
await file.mkdirs();
await file.delete();
await file.renameTo('/home/MYUSER/renamed.txt');
await file.copyTo('/home/MYUSER/copy.txt');

await system.close();
```

## Stream classes

### IFSFileInputStream -- read binary

```js
import { AS400, IFSFileInputStream } from 'js400';

const stream = new IFSFileInputStream(system, '/home/MYUSER/data.bin');
const chunk = await stream.read(1024); // read up to 1024 bytes
const all = await stream.readAll();    // read entire file
await stream.close();
```

### IFSFileOutputStream -- write binary

```js
import { AS400, IFSFileOutputStream } from 'js400';

const stream = new IFSFileOutputStream(system, '/tmp/output.bin');
await stream.write(Buffer.from('Hello'));
await stream.write(someBuffer);
await stream.close();
```

### IFSTextFileInputStream -- read text (CCSID-aware)

```js
import { AS400, IFSTextFileInputStream } from 'js400';

const stream = new IFSTextFileInputStream(system, '/home/MYUSER/notes.txt');
const text = await stream.readAll(); // returns a string
await stream.close();
```

### IFSTextFileOutputStream -- write text (CCSID-aware)

```js
import { AS400, IFSTextFileOutputStream } from 'js400';

const stream = new IFSTextFileOutputStream(system, '/tmp/hello.txt');
await stream.write('Hello from js400');
await stream.close();
```

### IFSRandomAccessFile -- read/write with seek

```js
import { AS400, IFSRandomAccessFile } from 'js400';

const raf = new IFSRandomAccessFile(system, '/tmp/data.bin', 'rw');
await raf.seek(100);               // seek to offset
const data = await raf.read(50);   // read 50 bytes
await raf.write(Buffer.from([0xFF]));
await raf.close();
```

## QSYS object paths

Use `QSYSObjectPathName` to build IFS-style paths for QSYS objects:

```js
import { QSYSObjectPathName } from 'js400';

const path = QSYSObjectPathName.toPath('MYLIB', 'MYFILE', 'FILE');
// -> '/QSYS.LIB/MYLIB.LIB/MYFILE.FILE'

const parsed = QSYSObjectPathName.parse('/QSYS.LIB/MYLIB.LIB/MYPGM.PGM');
// { library: 'MYLIB', object: 'MYPGM', type: 'PGM' }
```

Source: [`src/ifs/IFSFile.js`](../src/ifs/IFSFile.js), [`src/ifs/IFSFileInputStream.js`](../src/ifs/IFSFileInputStream.js), [`src/ifs/IFSFileOutputStream.js`](../src/ifs/IFSFileOutputStream.js), [`src/ifs/QSYSObjectPathName.js`](../src/ifs/QSYSObjectPathName.js)
