# Program Call

js400 provides three ways to call IBM i programs:

1. **`system.callProgram()`** -- high-level convenience with typed parameters
2. **`ProgramCall`** -- low-level class with explicit `ProgramParameter` objects
3. **`ServiceProgramCall`** -- for calling exported procedures in service programs

## High-level: system.callProgram()

The simplest way to call a program. Parameters are described with plain objects and automatically converted to/from EBCDIC buffers.

```js
import { AS400 } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const result = await system.callProgram({
  program: '/QSYS.LIB/MYLIB.LIB/MYPGM.PGM',
  parameters: [
    { type: 'char', length: 10, value: 'HELLO', usage: 'input' },
    { type: 'char', length: 50, usage: 'output', trim: true },
    { type: 'packed', length: 7, precision: 2, value: 123.45, usage: 'inputOutput' },
  ],
});

console.log('Success:', result.success);
console.log('Output:', result.parameters[1].value);
console.log('Updated decimal:', result.parameters[2].value);

for (const msg of result.messages) {
  console.log(`${msg.id}: ${msg.text}`);
}

await system.close();
```

### Parameter descriptor fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `string` | `'char'` | Data type: `char`, `bin2`, `bin4`, `bin8`, `float4`, `float8`, `packed`, `zoned`, `byte` |
| `length` | `number` | `10` | Field length in bytes (or total digits for packed/zoned) |
| `precision` | `number` | `0` | Decimal places for packed/zoned |
| `ccsid` | `number` | `37` | CCSID for character data |
| `value` | `any` | `null` | Input value (required for input/inputOutput) |
| `usage` | `string` | `'input'` | `'input'`, `'output'`, or `'inputOutput'` |
| `trim` | `boolean` | `false` | Trim trailing spaces from output strings |

## Low-level: ProgramCall

For full control over parameter construction:

```js
import { AS400, ProgramCall, ProgramParameter } from 'js400';
import { AS400Text, AS400Bin4 } from 'js400/datatypes';

const system = new AS400({ host, user, password });
await system.signon();

const text10 = new AS400Text(10);
const bin4 = new AS400Bin4();

const pc = new ProgramCall(system);
pc.setProgram('/QSYS.LIB/MYLIB.LIB/MYPGM.PGM', [
  new ProgramParameter(text10.toBuffer('HELLO')),       // input
  new ProgramParameter(50),                              // output, 50 bytes
  new ProgramParameter(bin4.toBuffer(42), 4),            // input+output
]);

const success = await pc.run();
console.log('Success:', success);

const messages = pc.getMessageList();
for (const msg of messages) {
  console.log(`${msg.id}: ${msg.text}`);
}

// Read output parameter
const outBuf = pc.getParameterList()[1].getOutputData();
const outValue = new AS400Text(50).fromBuffer(outBuf, 0);
console.log('Output:', outValue.trim());

await system.close();
```

### ProgramParameter constructors

```js
new ProgramParameter()                          // empty
new ProgramParameter(50)                         // output-only, 50 bytes
new ProgramParameter(inputBuffer)                // input-only
new ProgramParameter(inputBuffer, 50)            // input+output
new ProgramParameter({
  inputData: buffer,
  outputLength: 50,
  usage: ProgramParameter.INOUT,
  passBy: ProgramParameter.PASS_BY_REFERENCE,
})
```

### Usage constants

| Constant | Value | Description |
| --- | --- | --- |
| `ProgramParameter.INPUT` | `1` | Input only |
| `ProgramParameter.OUTPUT` | `2` | Output only |
| `ProgramParameter.INOUT` | `3` | Input and output |

## ServiceProgramCall

Calls an exported procedure in a service program using the QZRUCLSP API:

```js
import { AS400, ServiceProgramCall, ProgramParameter } from 'js400';
import { AS400Bin4 } from 'js400/datatypes';

const system = new AS400({ host, user, password });
await system.signon();

const spc = new ServiceProgramCall(system);
spc.setProgram('/QSYS.LIB/MYLIB.LIB/MYSRVPGM.SRVPGM');
spc.setProcedureName('myProcedure');
spc.setReturnValueFormat(ServiceProgramCall.RETURN_INTEGER);

const bin4 = new AS400Bin4();
spc.setParameterList([
  new ProgramParameter(bin4.toBuffer(100)),    // input
  new ProgramParameter(4),                      // output, 4 bytes
]);

const success = await spc.run();
console.log('Return value:', spc.getIntegerReturnValue());
console.log('Errno:', spc.getErrno());

await system.close();
```

### Return value formats

| Constant | Description |
| --- | --- |
| `ServiceProgramCall.NO_RETURN_VALUE` | Procedure returns void |
| `ServiceProgramCall.RETURN_INTEGER` | Procedure returns an integer |

## Error handling

Programs that fail return `false` from `run()`. Check the message list for details:

```js
const success = await pc.run();
if (!success) {
  for (const msg of pc.getMessageList()) {
    console.error(`${msg.id} (${msg.severity}): ${msg.text}`);
  }
}
```

Source: [`src/command/ProgramCall.js`](../src/command/ProgramCall.js), [`src/command/ServiceProgramCall.js`](../src/command/ServiceProgramCall.js), [`src/command/ProgramParameter.js`](../src/command/ProgramParameter.js)
