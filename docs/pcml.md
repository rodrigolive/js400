# PCML (Program Call Markup Language)

PCML describes IBM i program interfaces in XML. js400 includes a built-in PCML parser and runtime that reads PCML documents and calls the described programs with automatic parameter marshalling.

## Quick example

Given a PCML file:

```xml
<pcml version="6.0">
  <program name="myProgram" path="/QSYS.LIB/MYLIB.LIB/MYPGM.PGM">
    <data name="inputName" type="char" length="10" usage="input"/>
    <data name="outputResult" type="char" length="50" usage="output"/>
    <data name="balance" type="packed" length="7" precision="2" usage="inputOutput"/>
  </program>
</pcml>
```

Call it from JavaScript:

```js
import { AS400 } from 'js400';
import { ProgramCallDocument } from 'js400/pcml';

const system = new AS400({ host, user, password });
await system.signon();

const doc = new ProgramCallDocument(system, '/path/to/myProgram.pcml');
await doc.load();

doc.setValue('myProgram.inputName', 'HELLO');
doc.setValue('myProgram.balance', 123.45);

const success = await doc.callProgram('myProgram');

console.log('Output:', doc.getValue('myProgram.outputResult'));
console.log('Balance:', doc.getValue('myProgram.balance'));
console.log('Messages:', doc.getMessageList('myProgram'));

await system.close();
```

## ProgramCallDocument

### Constructor

```js
new ProgramCallDocument(system, pcmlSource)
```

- `system` -- an `AS400` instance
- `pcmlSource` -- path to a `.pcml` file, or an XML string, or a pre-parsed PCML object

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `load()` | `Promise<void>` | Parse and load the PCML document |
| `callProgram(programName)` | `Promise<boolean>` | Call the named program |
| `setValue(qualifiedName, value)` | `void` | Set an input parameter value |
| `getValue(qualifiedName)` | `any` | Get an output parameter value |
| `getMessageList(programName)` | `AS400Message[]` | Get messages from the last call |
| `getProgramNames()` | `string[]` | List all program names in the document |

### Qualified names

Parameter names are qualified with the program name: `programName.dataName`. For nested structures: `programName.structName.dataName`.

## PCML data types

| PCML `type` | JS type | Description |
| --- | --- | --- |
| `char` | `string` | EBCDIC character data |
| `int` | `number` | Signed integer (2 or 4 bytes) |
| `packed` | `number` | Packed decimal |
| `zoned` | `number` | Zoned decimal |
| `float` | `number` | Floating point (4 or 8 bytes) |
| `byte` | `Buffer` | Raw byte array |
| `struct` | `object` | Nested structure |

## PCML usage values

| Usage | Direction |
| --- | --- |
| `input` | Sent to the program |
| `output` | Received from the program |
| `inputOutput` | Sent and received |

## Migrating from Java PCML

If you have existing PCML files from a JTOpen project, they work directly with js400. The XML format is the same. The differences:

1. **No classpath resources** -- pass a file path or XML string instead.
2. **No XPCML serialization** -- use `setValue`/`getValue` instead of Java beans.
3. **Async** -- `callProgram()` returns a Promise, not a boolean.

## Parsing PCML directly

```js
import { parsePcml } from 'js400/pcml';

const pcmlTree = parsePcml(xmlString);
// Returns a PcmlDocNode with program and data children
```

## Built-in PCML resources

js400 includes PCML definitions for common IBM i APIs. Access them via:

```js
import { pcmlResources, loadPcmlResource } from 'js400/pcml';

console.log(pcmlResources); // list of available resource names
const pcml = await loadPcmlResource('qsyrusri'); // load a specific resource
```

Source: [`src/pcml/ProgramCallDocument.js`](../src/pcml/ProgramCallDocument.js), [`src/pcml/parser.js`](../src/pcml/parser.js), [`src/pcml/model.js`](../src/pcml/model.js)
