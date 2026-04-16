# Record-Level Access

js400 supports native record-level access (RLA) to IBM i physical and logical files using the DDM/DRDA host server protocol. This provides keyed and sequential file operations without SQL overhead.

## SequentialFile

Read records sequentially (first, next, previous, last):

```js
import { AS400, SequentialFile, RecordFormat, FieldDescription, FIELD_TYPE, DIRECTION } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const format = new RecordFormat('CUSTREC');
format.addFieldDescription(new FieldDescription('CUSTID', FIELD_TYPE.CHAR, 6));
format.addFieldDescription(new FieldDescription('CUSTNAME', FIELD_TYPE.CHAR, 30));
format.addFieldDescription(new FieldDescription('BALANCE', FIELD_TYPE.PACKED, 11, 2));

const file = new SequentialFile(system, '/QSYS.LIB/MYLIB.LIB/CUSTMAS.FILE', format);
await file.open(DIRECTION.READ);

// Read first record
const first = await file.readFirst();
console.log(first.CUSTID, first.CUSTNAME, first.BALANCE);

// Read all records sequentially
let record;
while ((record = await file.readNext()) !== null) {
  console.log(record.CUSTID, record.CUSTNAME);
}

await file.close();
await system.close();
```

### DIRECTION constants

| Constant | Description |
| --- | --- |
| `DIRECTION.READ` | Open for reading |
| `DIRECTION.WRITE` | Open for writing |
| `DIRECTION.READ_WRITE` | Open for reading and writing |

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `open(direction)` | `Promise<void>` | Open the file |
| `close()` | `Promise<void>` | Close the file |
| `readFirst()` | `Promise<Record>` | Read first record |
| `readNext()` | `Promise<Record>` | Read next record |
| `readPrevious()` | `Promise<Record>` | Read previous record |
| `readLast()` | `Promise<Record>` | Read last record |
| `write(record)` | `Promise<void>` | Write a record |
| `update(record)` | `Promise<void>` | Update the current record |
| `deleteRecord()` | `Promise<void>` | Delete the current record |

## KeyedFile

Read records by key:

```js
import { AS400, KeyedFile, RecordFormat, FieldDescription, FIELD_TYPE, KEY_SEARCH } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const format = new RecordFormat('CUSTREC');
format.addFieldDescription(new FieldDescription('CUSTID', FIELD_TYPE.CHAR, 6));
format.addFieldDescription(new FieldDescription('CUSTNAME', FIELD_TYPE.CHAR, 30));
format.addFieldDescription(new FieldDescription('BALANCE', FIELD_TYPE.PACKED, 11, 2));

const file = new KeyedFile(system, '/QSYS.LIB/MYLIB.LIB/CUSTMAS.FILE/CUSTIDX.MBR', format);
await file.open();

// Read by exact key
const record = await file.read(['C00001']);
console.log(record.CUSTID, record.CUSTNAME, record.BALANCE);

// Read with search type
const ge = await file.read(['C00002'], KEY_SEARCH.GE);

await file.close();
await system.close();
```

### KEY_SEARCH constants

| Constant | Description |
| --- | --- |
| `KEY_SEARCH.EQ` | Equal |
| `KEY_SEARCH.GE` | Greater than or equal |
| `KEY_SEARCH.GT` | Greater than |
| `KEY_SEARCH.LE` | Less than or equal |
| `KEY_SEARCH.LT` | Less than |

## RecordFormat

Describes the field layout of a physical or logical file:

```js
const format = new RecordFormat('MYFORMAT');
format.addFieldDescription(new FieldDescription('FIELD1', FIELD_TYPE.CHAR, 10));
format.addFieldDescription(new FieldDescription('FIELD2', FIELD_TYPE.PACKED, 7, 2));
format.addFieldDescription(new FieldDescription('FIELD3', FIELD_TYPE.BINARY, 4));
```

## FieldDescription

| Constructor | Description |
| --- | --- |
| `new FieldDescription(name, type, length)` | Character or binary field |
| `new FieldDescription(name, type, length, precision)` | Packed or zoned decimal |

### FIELD_TYPE constants

| Constant | Description |
| --- | --- |
| `FIELD_TYPE.CHAR` | Character (EBCDIC) |
| `FIELD_TYPE.PACKED` | Packed decimal |
| `FIELD_TYPE.ZONED` | Zoned decimal |
| `FIELD_TYPE.BINARY` | Binary integer |
| `FIELD_TYPE.FLOAT` | Floating point |
| `FIELD_TYPE.DATE` | Date |
| `FIELD_TYPE.TIME` | Time |
| `FIELD_TYPE.TIMESTAMP` | Timestamp |

## RecordFormatDocument (RFML)

Load record formats from RFML (Record Format Markup Language) XML:

```js
import { RecordFormatDocument } from 'js400';

const doc = new RecordFormatDocument('/path/to/format.rfml');
await doc.load();
const format = doc.getRecordFormat('MYFORMAT');
```

## FileRecordDescription

Retrieve the record format directly from the file on the system:

```js
import { FileRecordDescription } from 'js400';

const frd = new FileRecordDescription(system, '/QSYS.LIB/MYLIB.LIB/CUSTMAS.FILE');
const formats = await frd.retrieveRecordFormat();
const format = formats[0];
```

Source: [`src/record/SequentialFile.js`](../src/record/SequentialFile.js), [`src/record/KeyedFile.js`](../src/record/KeyedFile.js), [`src/record/RecordFormat.js`](../src/record/RecordFormat.js), [`src/record/FieldDescription.js`](../src/record/FieldDescription.js)
