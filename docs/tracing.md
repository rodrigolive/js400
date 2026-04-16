# Tracing

js400 includes a category-based tracing system with hex dump support and automatic redaction of sensitive values.

## Enable tracing

### Via AS400 constructor

```js
import { AS400 } from 'js400';

const system = new AS400({
  host, user, password,
  trace: true, // enables all trace categories
});
```

### Via Trace API

```js
import { Trace } from 'js400';

Trace.setTraceOn(true);
Trace.setTraceAllOn(true); // enable all categories
```

### Enable specific categories

```js
Trace.setTraceOn(true);
Trace.setTraceDatastreamOn(true);
Trace.setTraceDiagnosticOn(true);
Trace.setTraceErrorOn(true);
```

## Trace categories

| Category | Constant | Description |
| --- | --- | --- |
| DATASTREAM | `Trace.DATASTREAM` | Wire-level datastream bytes |
| DIAGNOSTIC | `Trace.DIAGNOSTIC` | Connection lifecycle and flow |
| ERROR | `Trace.ERROR` | Error conditions |
| INFORMATION | `Trace.INFORMATION` | General information |
| WARNING | `Trace.WARNING` | Warning conditions |
| CONVERSION | `Trace.CONVERSION` | CCSID and data type conversions |
| PROXY | `Trace.PROXY` | Proxy-related (reserved) |
| PCML | `Trace.PCML` | PCML parsing and execution |
| JDBC | `Trace.JDBC` | SQL/database operations |

## Log to a file

```js
Trace.setFileName('/tmp/js400-trace.log');
```

Pass `null` to revert to console output:

```js
Trace.setFileName(null);
```

## Custom sink

Route trace output to a custom function:

```js
Trace.setCallbackSink((line) => {
  myLogger.debug(line);
});
```

## Correlation IDs

Tag trace output with a correlation ID for request tracking:

```js
Trace.setCorrelationId('req-12345');
// Trace output now includes [corr=req-12345]
```

## Manual logging

```js
Trace.log(Trace.DIAGNOSTIC, 'Connected to host server');
Trace.log(Trace.ERROR, 'Connection failed', new Error('timeout'));
```

## Hex dumps

```js
Trace.logHex(Trace.DATASTREAM, 'Request buffer', buffer);
Trace.logHex(Trace.DATASTREAM, 'Partial', buffer, 0, 64);
```

Output format:

```
[2026-04-15T10:30:00.000Z] DATASTREAM: Request buffer (32 bytes)
  000000  00 20 00 00 E0 08 00 00  00 00 00 00 00 14 11 00 |. ..............|
  000010  00 01 00 08 00 00 00 0E  00 04 C8 C5 D3 D3 D6 40 |..........HELLO@|
```

## Hex utilities

```js
const hex = Trace.toHexString(0xC1);  // 'C1'
const dump = Trace.toHexDump(buffer); // formatted hex dump string
```

## Redaction

Trace automatically redacts values in messages that match sensitive patterns:

- `password`
- `profileToken`
- `encryptedPassword`
- `authentication.*token`

Any `=value` in matching messages is replaced with `=***REDACTED***`.

## Check trace state

```js
if (Trace.isTraceOn()) { /* ... */ }
if (Trace.isTraceDiagnosticOn()) { /* ... */ }
if (Trace.isTraceDatastreamOn()) { /* ... */ }
```

## Reset

```js
Trace.reset(); // turn off all tracing, close files, clear state
```

Source: [`src/core/Trace.js`](../src/core/Trace.js)
