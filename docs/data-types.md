# Data Types

js400 includes a complete set of AS400 data type converters for marshalling values between JavaScript and IBM i binary formats. These are used internally by program calls, record-level access, and PCML, and are also available for direct use.

## Import

```js
import {
  AS400Text, AS400Bin2, AS400Bin4, AS400Bin8,
  AS400UnsignedBin1, AS400UnsignedBin2, AS400UnsignedBin4, AS400UnsignedBin8,
  AS400Float4, AS400Float8,
  AS400PackedDecimal, AS400ZonedDecimal, AS400DecFloat,
  AS400Varchar, AS400Boolean, AS400ByteArray,
  AS400Array, AS400Structure,
  AS400Date, AS400Time, AS400Timestamp,
  BinaryConverter,
} from 'js400/datatypes';
```

## Character types

### AS400Text

Converts between JS strings and EBCDIC byte arrays.

```js
const text = new AS400Text(10, 37); // 10 bytes, CCSID 37

const buf = text.toBuffer('HELLO');     // JS string -> EBCDIC Buffer
const str = text.fromBuffer(buf, 0);    // EBCDIC Buffer -> JS string
console.log(text.byteLength());         // 10
```

### AS400Varchar

Variable-length character with a 2-byte length prefix.

```js
const varchar = new AS400Varchar(100, 37);
const buf = varchar.toBuffer('Variable text');
const str = varchar.fromBuffer(buf, 0);
```

## Integer types

| Class | Size | JS type | Range |
| --- | --- | --- | --- |
| `AS400Bin2` | 2 bytes | `number` | -32768 to 32767 |
| `AS400Bin4` | 4 bytes | `number` | -2^31 to 2^31-1 |
| `AS400Bin8` | 8 bytes | `bigint` | -2^63 to 2^63-1 |
| `AS400UnsignedBin1` | 1 byte | `number` | 0 to 255 |
| `AS400UnsignedBin2` | 2 bytes | `number` | 0 to 65535 |
| `AS400UnsignedBin4` | 4 bytes | `number` | 0 to 2^32-1 |
| `AS400UnsignedBin8` | 8 bytes | `bigint` | 0 to 2^64-1 |

```js
const bin4 = new AS400Bin4();
const buf = bin4.toBuffer(42);
const val = bin4.fromBuffer(buf, 0); // 42
console.log(bin4.byteLength());       // 4
```

## Floating point types

| Class | Size | JS type |
| --- | --- | --- |
| `AS400Float4` | 4 bytes | `number` |
| `AS400Float8` | 8 bytes | `number` |

```js
const float8 = new AS400Float8();
const buf = float8.toBuffer(3.14159);
const val = float8.fromBuffer(buf, 0);
```

## Decimal types

### AS400PackedDecimal

```js
const packed = new AS400PackedDecimal(7, 2); // 7 digits, 2 decimal
const buf = packed.toBuffer(12345.67);
const val = packed.fromBuffer(buf, 0); // 12345.67
console.log(packed.byteLength());       // 4 bytes
```

### AS400ZonedDecimal

```js
const zoned = new AS400ZonedDecimal(7, 2);
const buf = zoned.toBuffer(12345.67);
const val = zoned.fromBuffer(buf, 0);
console.log(zoned.byteLength());        // 7 bytes
```

### AS400DecFloat

IEEE 754 decimal floating point (16 or 34 digits).

```js
const decfloat = new AS400DecFloat(34);
const buf = decfloat.toBuffer(1234567890.123456789);
const val = decfloat.fromBuffer(buf, 0);
```

## Date and time types

### AS400Date

```js
const date = new AS400Date('*ISO');
const buf = date.toBuffer(new Date('2026-04-15'));
const val = date.fromBuffer(buf, 0); // Date object
```

### AS400Time

```js
const time = new AS400Time('*ISO');
const buf = time.toBuffer('14:30:00');
const val = time.fromBuffer(buf, 0);
```

### AS400Timestamp

```js
const ts = new AS400Timestamp();
const buf = ts.toBuffer(new Date());
const val = ts.fromBuffer(buf, 0);
```

## Composite types

### AS400Array

Array of a single element type:

```js
const arr = new AS400Array(new AS400Bin4(), 5); // array of 5 int32s
const buf = arr.toBuffer([10, 20, 30, 40, 50]);
const vals = arr.fromBuffer(buf, 0); // [10, 20, 30, 40, 50]
```

### AS400Structure

Composite of heterogeneous fields:

```js
const struct = new AS400Structure([
  new AS400Text(10),
  new AS400Bin4(),
  new AS400PackedDecimal(7, 2),
]);

const buf = struct.toBuffer(['HELLO', 42, 123.45]);
const vals = struct.fromBuffer(buf, 0); // ['HELLO     ', 42, 123.45]
console.log(struct.byteLength()); // 10 + 4 + 4 = 18
```

## Other types

### AS400Boolean

```js
const bool = new AS400Boolean();
const buf = bool.toBuffer(true);
const val = bool.fromBuffer(buf, 0); // true
```

### AS400ByteArray

Raw bytes with no conversion:

```js
const bytes = new AS400ByteArray(16);
const buf = bytes.toBuffer(Buffer.alloc(16, 0xFF));
const val = bytes.fromBuffer(buf, 0); // Buffer
```

## Common interface

Every data type implements:

| Method | Returns | Description |
| --- | --- | --- |
| `toBuffer(value)` | `Buffer` | Convert JS value to binary |
| `fromBuffer(buffer, offset)` | `any` | Convert binary to JS value |
| `byteLength()` | `number` | Fixed byte length of this type |

## CCSID conversion

For direct CCSID conversion without a data type wrapper:

```js
import { CharConverter } from 'js400';

const conv = new CharConverter(37); // CCSID 37
const ebcdic = conv.stringToByteArray('Hello');
const str = conv.byteArrayToString(ebcdic, 0, ebcdic.length);
```

Source: [`src/datatypes/`](../src/datatypes/), [`src/ccsid/CharConverter.js`](../src/ccsid/CharConverter.js)
