# Command Call

Run CL commands on IBM i and retrieve the resulting messages.

## Quick usage via AS400

```js
import { AS400 } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const messages = await system.runCommand('CRTLIB LIB(TESTLIB)');
for (const msg of messages) {
  console.log(`${msg.id}: ${msg.text}`);
}

await system.close();
```

## CommandCall class

For more control, use the `CommandCall` class directly:

```js
import { AS400, CommandCall } from 'js400';

const system = new AS400({ host, user, password });
await system.signon();

const cmd = new CommandCall(system);
const success = await cmd.run('DSPLIB LIB(QGPL)');

console.log('Success:', success);
for (const msg of cmd.getMessageList()) {
  console.log(`${msg.id} (sev ${msg.severity}): ${msg.text}`);
}

await system.close();
```

## Constructor

```js
new CommandCall(system)
new CommandCall(system, 'DSPLIB LIB(QGPL)')  // with initial command
```

## Methods

| Method | Returns | Description |
| --- | --- | --- |
| `run(command?)` | `Promise<boolean>` | Run the command. Returns `true` on success. |
| `setCommand(cmd)` | `void` | Set the command string |
| `getCommand()` | `string` | Get the command string |
| `getMessageList()` | `AS400Message[]` | Messages from the last call |
| `setThreadsafe(bool)` | `void` | Mark the command as threadsafe |
| `isThreadsafe()` | `boolean` | Check threadsafe flag |
| `setMessageOption(opt)` | `void` | Set message retrieval option |

## Message object

Each message returned from `getMessageList()` has:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Message ID (e.g. `CPF2110`) |
| `text` | `string` | Message text |
| `severity` | `number` | Severity level |
| `type` | `number` | Message type |

## Examples

### Create a library

```js
const ok = await cmd.run('CRTLIB LIB(MYLIB) TEXT(\'My library\')');
```

### Delete a file

```js
const ok = await cmd.run('DLTF FILE(MYLIB/MYFILE)');
if (!ok) {
  const msgs = cmd.getMessageList();
  if (msgs.some(m => m.id === 'CPF2105')) {
    console.log('File not found, ignoring');
  }
}
```

### Run multiple commands

```js
for (const cl of ['CRTLIB LIB(TEMPLIB)', 'CRTPF FILE(TEMPLIB/TESTPF) RCDLEN(100)']) {
  const ok = await cmd.run(cl);
  if (!ok) {
    console.error('Failed:', cl, cmd.getMessageList());
    break;
  }
}
```

Source: [`src/command/CommandCall.js`](../src/command/CommandCall.js)
