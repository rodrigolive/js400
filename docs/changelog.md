# Changelog

All notable changes to js400 are documented here. This project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-15

Initial release. Pure JavaScript IBM i client library, wire-compatible with JTOpen.

### Core

- `AS400` session object with signon, service connections, and connection lifecycle
- Password authentication at all levels (0-4): DES, SHA-1, SHA-512
- TLS support for all connections
- Profile token generation and token-based authentication
- Password change flow
- Port mapper client for automatic port resolution
- Connection pool (`ConnectionPool`, `AS400ConnectionPool` compat wrapper)
- Category-based tracing with hex dumps and redaction (`Trace`)

### Transport

- TCP socket transport with `DataStream` framing
- `SeedExchange` and `ServerStart` for host server handshake
- SOCKS5 proxy support

### Commands

- `CommandCall` -- CL command execution
- `ProgramCall` -- program calls with typed parameters
- `ServiceProgramCall` -- service program procedure calls via QZRUCLSP
- `ProgramParameter` -- input/output/inout parameter descriptors

### PCML

- `ProgramCallDocument` -- parse and execute PCML-described programs
- Built-in PCML parser with XPCML support
- Bundled PCML resources for common IBM i APIs

### IFS

- `IFSFile` -- file metadata, directory listing, create/delete/rename/copy
- `IFSFileInputStream` / `IFSFileOutputStream` -- binary streaming
- `IFSTextFileInputStream` / `IFSTextFileOutputStream` -- CCSID-aware text I/O
- `IFSRandomAccessFile` -- random access read/write
- `QSYSObjectPathName` -- QSYS path parsing and construction

### Data types

- Full AS400 data type family: `AS400Text`, `AS400Bin2`, `AS400Bin4`, `AS400Bin8`, `AS400UnsignedBin1/2/4/8`, `AS400Float4`, `AS400Float8`, `AS400PackedDecimal`, `AS400ZonedDecimal`, `AS400DecFloat`, `AS400Varchar`, `AS400Boolean`, `AS400ByteArray`, `AS400Array`, `AS400Structure`
- Date/time types: `AS400Date`, `AS400Time`, `AS400Timestamp`
- CCSID registry and `CharConverter` for EBCDIC conversion

### SQL / Database

- `sql.connect()` with options objects and JDBC URL parsing
- `conn.query()` returning row arrays of plain objects
- `conn.execute()` for DML/DDL with affected row count
- `conn.prepare()` for prepared statements
- `stmt.stream()` for async iterable large result sets
- `stmt.executeBatch()` for batch execution
- Transaction control: `begin()`, `commit()`, `rollback()`
- Savepoints: `savepoint()`, `rollback(savepoint)`
- `conn.call()` for stored procedures
- `conn.metadata()` for database metadata
- Generated keys support
- LOB handling: BLOB as Buffer, CLOB as string, SQLXML
- Connection pool via `sql.createPool()`
- Connection property validation and normalization

### Objects

- `DataQueue` and `KeyedDataQueue` with read/write/peek/clear/create/delete
- `MessageQueue` for message queue operations
- `UserSpace` for create/read/write/delete
- `JPing` for IBM i host server connectivity checks
- `Job`, `JobList`, `JobLog` for job information
- `SystemValue`, `DataArea`, `SystemStatus` for system info

### Record-level access

- `SequentialFile` for sequential read/write
- `KeyedFile` for keyed read
- `RecordFormat`, `Record`, `FieldDescription`
- `RecordFormatDocument` (RFML) support
- `FileRecordDescription` for retrieving formats from files
- DDM protocol implementation

### Print

- `OutputQueue` for listing spooled files
- `SpooledFile` for reading spooled file content
- `SpooledFileOutputStream`, `Printer`, `PrinterFile`, `WriterJob`, `AFPResource`

### Upstream parity

- Last reviewed against JTOpen 20.0.x
- See [docs/unsupported.md](docs/unsupported.md) for intentionally omitted packages

### Runtime

- Tested on Node.js 20+ and Bun
- Zero production dependencies
