# Test Setup: IBM i Object Provisioning

This document describes how to create test objects on IBM i for running js400 integration tests.

## Prerequisites

- An IBM i system with TCP/IP host servers running
- A user profile with `*ALLOBJ` and `*SECADM` authority (or at minimum, authority to create libraries, data areas, data queues, user spaces, physical files, logical files, and output queues)
- SSH or 5250 access to run CL commands

## Environment Variables

Set these before running integration tests:

```sh
export JS400_TEST_HOST=your-ibmi-hostname
export JS400_TEST_USER=TESTUSER
export JS400_TEST_PASSWORD=testpassword
# Optional overrides:
export JS400_TEST_SIGNON_PORT=8476
export JS400_TEST_COMMAND_PORT=8475
export JS400_TEST_DATABASE_PORT=8471
export JS400_TEST_USE_TLS=false
export JS400_TEST_LIBRARY=JS400TEST
```

## Create Test Library

```cl
CRTLIB LIB(JS400TEST) TEXT('js400 integration test objects')
```

## Create Test Data Queue

```cl
CRTDTAQ DTAQ(JS400TEST/TESTDQ) MAXLEN(256) TEXT('Test data queue')
```

## Create Keyed Test Data Queue

```cl
CRTDTAQ DTAQ(JS400TEST/TESTKEYDQ) MAXLEN(256) KEYLEN(10) TEXT('Test keyed data queue')
```

## Create Test User Space

```cl
CALL PGM(QUSCRTUS) PARM('TESTUS    JS400TEST ' 'TEST' X'00001000' X'00' '*ALL' 'Test user space')
```

## Create Test Data Area

```cl
CRTDTAARA DTAARA(JS400TEST/TESTDA) TYPE(*CHAR) LEN(128) VALUE('Hello from js400') TEXT('Test data area')
```

## Create Test Physical File (Database Table)

```cl
RUNSQL SQL('CREATE TABLE JS400TEST.TESTTBL (
  ID INTEGER NOT NULL WITH DEFAULT,
  NAME VARCHAR(50) NOT NULL WITH DEFAULT,
  AMOUNT DECIMAL(9,2) NOT NULL WITH DEFAULT,
  CREATED TIMESTAMP NOT NULL WITH DEFAULT
)') COMMIT(*NONE)
```

Insert sample data:

```cl
RUNSQL SQL('INSERT INTO JS400TEST.TESTTBL VALUES
  (1, ''Alice'', 100.50, CURRENT_TIMESTAMP),
  (2, ''Bob'', 200.75, CURRENT_TIMESTAMP),
  (3, ''Charlie'', 300.00, CURRENT_TIMESTAMP)
') COMMIT(*NONE)
```

## Create Physical File for Record-Level Access

```cl
RUNSQL SQL('CREATE TABLE JS400TEST.RLATBL (
  CUSTID CHAR(6) NOT NULL WITH DEFAULT,
  CUSTNAME CHAR(30) NOT NULL WITH DEFAULT,
  BALANCE DECIMAL(11,2) NOT NULL WITH DEFAULT
)') COMMIT(*NONE)

RUNSQL SQL('INSERT INTO JS400TEST.RLATBL VALUES
  (''C00001'', ''Widget Corp'', 15000.00),
  (''C00002'', ''Gadget Inc'', 25000.50),
  (''C00003'', ''Sprocket Ltd'', 8500.25)
') COMMIT(*NONE)
```

## Create Logical File (Keyed Access Path)

```cl
RUNSQL SQL('CREATE INDEX JS400TEST.RLAIDX ON JS400TEST.RLATBL (CUSTID)') COMMIT(*NONE)
```

## Create Test Output Queue

```cl
CRTOUTQ OUTQ(JS400TEST/TESTOUTQ) TEXT('Test output queue')
```

## Create Test Stream File (IFS)

```sh
# Via QSH or SSH:
mkdir -p /tmp/js400test
echo "Hello from js400 IFS test" > /tmp/js400test/hello.txt
```

Or via CL:

```cl
QSH CMD('mkdir -p /tmp/js400test && echo "Hello from js400 IFS test" > /tmp/js400test/hello.txt')
```

## Create Test Program

Create a simple RPG program that echoes its input parameter:

```cl
RUNSQL SQL('CREATE OR REPLACE PROCEDURE JS400TEST.TESTPROC (
  IN INVAL CHAR(10),
  OUT OUTVAL CHAR(10)
)
LANGUAGE SQL
BEGIN
  SET OUTVAL = INVAL;
END') COMMIT(*NONE)
```

## Create Spooled File for Print Tests

```cl
OVRPRTF FILE(QSYSPRT) OUTQ(JS400TEST/TESTOUTQ) HOLD(*YES)
DSPLIB LIB(JS400TEST) OUTPUT(*PRINT)
DLTOVR FILE(QSYSPRT)
```

## Verify Host Servers Are Running

```cl
STRHOSTSVR SERVER(*ALL)
WRKTCPSTS OPTION(*CNN)
```

Verify these ports are listening:

| Service      | Port  |
| ------------ | ----- |
| Sign-on      | 8476  |
| Command      | 8475  |
| Database     | 8471  |
| Data Queue   | 8472  |
| File (IFS)   | 8473  |
| Print        | 8474  |
| Port Mapper  | 449   |

## Cleanup

To remove all test objects after testing:

```cl
DLTLIB LIB(JS400TEST)
QSH CMD('rm -rf /tmp/js400test')
```

## Running Integration Tests

```sh
# With environment variables set:
bun test tests/integration/

# Or with node:
node --import ./tests/bun-test-shim.js --test tests/integration/
```

Integration tests will skip automatically when `JS400_TEST_HOST` is not set.
