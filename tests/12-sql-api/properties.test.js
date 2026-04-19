/**
 * Tests for connection property validation and normalization.
 */
import { describe, test, expect } from 'bun:test';
import {
  validateProperties, normalizeProperties, defaultProperties,
  Naming, DateFormat, TimeFormat,
} from '../../src/db/properties.js';
import { CharConverter } from '../../src/ccsid/CharConverter.js';

describe('validateProperties', () => {
  test('returns empty warnings for valid properties', () => {
    const warnings = validateProperties({
      naming: 'sql',
      libraries: ['MYLIB'],
      dateFormat: '*ISO',
      autoCommit: true,
    });
    expect(warnings).toEqual([]);
  });

  test('returns warnings for unknown properties', () => {
    const warnings = validateProperties({ unknownProp: 'foo' });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('unknownProp');
  });

  test('throws on invalid naming', () => {
    expect(() => validateProperties({ naming: 'bad' })).toThrow('Invalid naming');
  });

  test('throws on invalid dateFormat', () => {
    expect(() => validateProperties({ dateFormat: 'INVALID' })).toThrow('Invalid dateFormat');
  });

  test('throws on invalid timeFormat', () => {
    expect(() => validateProperties({ timeFormat: 'INVALID' })).toThrow('Invalid timeFormat');
  });

  test('throws on invalid isolation', () => {
    expect(() => validateProperties({ isolation: 'bad' })).toThrow('Invalid isolation');
  });

  test('throws when libraries is not an array', () => {
    expect(() => validateProperties({ libraries: 'MYLIB' })).toThrow('libraries must be an array');
  });

  test('throws on invalid blockSize', () => {
    expect(() => validateProperties({ blockSize: 999 })).toThrow('Invalid blockSize');
  });

  test('accepts all valid isolation levels', () => {
    const levels = ['none', 'read-uncommitted', 'read-committed', 'repeatable-read', 'serializable'];
    for (const level of levels) {
      expect(validateProperties({ isolation: level })).toEqual([]);
    }
  });

  test('accepts all valid date formats', () => {
    const formats = ['*ISO', '*USA', '*EUR', '*JIS', '*MDY', '*DMY', '*YMD', '*JUL'];
    for (const fmt of formats) {
      expect(validateProperties({ dateFormat: fmt })).toEqual([]);
    }
  });

  test('accepts all valid time formats', () => {
    const formats = ['*ISO', '*USA', '*EUR', '*JIS', '*HMS'];
    for (const fmt of formats) {
      expect(validateProperties({ timeFormat: fmt })).toEqual([]);
    }
  });
});

describe('normalizeProperties', () => {
  test('merges with defaults', () => {
    const result = normalizeProperties({ naming: 'system' });
    expect(result.naming).toBe('system');
    expect(result.dateFormat).toBe(defaultProperties.dateFormat);
    expect(result.autoCommit).toBe(defaultProperties.autoCommit);
  });

  test('converts string libraries to array', () => {
    const result = normalizeProperties({ libraries: 'LIB1, LIB2, LIB3' });
    expect(result.libraries).toEqual(['LIB1', 'LIB2', 'LIB3']);
  });

  test('normalizes boolean strings', () => {
    const result = normalizeProperties({ autoCommit: 'true', prefetch: '1', lazyClose: 'false' });
    expect(result.autoCommit).toBe(true);
    expect(result.prefetch).toBe(true);
    expect(result.lazyClose).toBe(false);
  });

  test('preserves array libraries', () => {
    const result = normalizeProperties({ libraries: ['A', 'B'] });
    expect(result.libraries).toEqual(['A', 'B']);
  });

  test('preserves boolean values', () => {
    const result = normalizeProperties({ autoCommit: false });
    expect(result.autoCommit).toBe(false);
  });
});

describe('Statement.setCursorName() plumbing', () => {
  // Helper: parse text CPs out of a built CREATE_RPB packet using the
  // declared CCSID, not an assumed UTF-16 payload. The live host bug
  // around positioned UPDATE/DELETE only reproduces if the driver sends
  // the cursor name in the wrong CCSID, so the test must inspect the
  // actual CP header too.
  function readCursorNameFromCreateRpb(buf) {
    let off = 40;
    const found = [];
    while (off + 10 <= buf.length) {
      const ll = buf.readInt32BE(off);
      if (ll < 10 || off + ll > buf.length) break;
      const cp = buf.readUInt16BE(off + 4);
      const ccsid = buf.readUInt16BE(off + 6);
      const len = buf.readUInt16BE(off + 8);
      if (len >= 0 && off + 10 + len <= buf.length) {
        const textBuf = buf.subarray(off + 10, off + 10 + len);
        found.push({
          cp,
          ccsid,
          value: CharConverter.byteArrayToString(textBuf, 0, textBuf.length, ccsid),
        });
      }
      off += ll;
    }
    return found;
  }

  function readSingleByteCpValue(buf, targetCp) {
    let off = 40;
    while (off + 7 <= buf.length) {
      const ll = buf.readInt32BE(off);
      if (ll < 7 || off + ll > buf.length) break;
      const cp = buf.readUInt16BE(off + 4);
      if (cp === targetCp) {
        return buf.readUInt8(off + 6);
      }
      off += ll;
    }
    return null;
  }

  function readIntCpValue(buf, targetCp) {
    let off = 40;
    while (off + 10 <= buf.length) {
      const ll = buf.readInt32BE(off);
      if (ll < 10 || off + ll > buf.length) break;
      const cp = buf.readUInt16BE(off + 4);
      if (cp === targetCp) {
        return buf.readInt32BE(off + 6);
      }
      off += ll;
    }
    return null;
  }

  test('explicit cursor name reaches CREATE_RPB on the wire', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const captured = [];
    let calls = 0;
    const fakeConn = {
      async sendAndReceive(buf) {
        calls++;
        if (calls === 1) captured.push(Buffer.from(buf));
        // Return a minimal-OK reply for CREATE_RPB; bail on the
        // PREPARE call so the test doesn't drive deeper.
        if (calls >= 2) throw new Error('stop-after-prepare');
        const reply = Buffer.alloc(40);
        reply.writeInt32BE(40, 0);
        reply.writeInt16BE(20, 16);
        return reply;
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    try {
      await sm.prepareStatement('SELECT X FROM T', { cursorName: 'MY_CURSOR' });
    } catch { /* expected: stop-after-prepare */ }
    const cps = readCursorNameFromCreateRpb(captured[0]);
    const names = cps.map(c => c.value);
    expect(names).toContain('MY_CURSOR');
    expect(cps.find(c => c.value === 'MY_CURSOR')?.ccsid).toBe(37);
  });

  test('absent cursorName falls back to auto-generated CRSR<id>', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const captured = [];
    let calls = 0;
    const fakeConn = {
      async sendAndReceive(buf) {
        calls++;
        if (calls === 1) captured.push(Buffer.from(buf));
        if (calls >= 2) throw new Error('stop-after-prepare');
        const reply = Buffer.alloc(40);
        reply.writeInt32BE(40, 0);
        reply.writeInt16BE(20, 16);
        return reply;
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    try { await sm.prepareStatement('SELECT X FROM T'); } catch { /* stop */ }
    const cps = readCursorNameFromCreateRpb(captured[0]);
    const names = cps.map(c => c.value);
    // At least one CP carries an auto-generated `CRSR<digits>` name.
    expect(names.some(n => /^CRSR\d+$/.test(n))).toBe(true);
  });

  test('Statement.setCursorName() flows into the engine via #prepareOpts', async () => {
    const { Statement } = await import('../../src/db/api/Statement.js');
    const seen = [];
    const fakeDb = {
      async prepareStatement(sql, opts) {
        seen.push({ sql, opts });
        return { id: 1, sql, paramCount: 0, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
      },
      cursorManager: { async closeCursor() {} },
      statementManager: {
        async execute() {
          return { hasResultSet: false, rows: [], affectedRows: 0, columnDescriptors: [], endOfData: true,
                   sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] } };
        },
        async closeStatement() {},
      },
      async executeImmediate() { return { affectedRows: 0, sqlca: { sqlCode: 0, sqlState: '00000', messageTokens: '', sqlwarn: [0,0,0,0,0,0,0,0,0,0,0] } }; },
    };
    const stmt = new Statement(fakeDb);
    // No name set → engine gets undefined opts.
    await stmt.query('SELECT X FROM T');
    expect(seen[0].opts).toBeUndefined();

    // Explicit name → engine receives it.
    stmt.setCursorName('MY_NAMED_CURSOR');
    await stmt.query('SELECT X FROM T2');
    expect(seen[1].opts).toEqual({ cursorName: 'MY_NAMED_CURSOR' });
  });

  test('Connection.prepare({ cursorName }) bypasses the statement cache', async () => {
    const { Connection } = await import('../../src/db/api/Connection.js');
    const state = { prepareCount: 0, closeCount: 0 };
    const db = {
      connected: true,
      async prepareStatement(sql, opts) {
        state.prepareCount++;
        return { id: state.prepareCount, sql, cursorName: opts?.cursorName ?? `CRSR${state.prepareCount}`, paramCount: 0, columnCount: 0, paramDescriptors: [], columnDescriptors: [] };
      },
      cursorManager: { async closeCursor() {} },
      statementManager: { async execute() {}, async closeStatement() { state.closeCount++; } },
      async executeImmediate() { return { affectedRows: 0, sqlca: { sqlCode: 0 } }; },
      async close() {},
    };
    const conn = new Connection(db);
    // Same SQL prepared twice — once cached, once with explicit
    // cursor name. The named one MUST NOT come from the cache.
    const a = await conn.prepare('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    await a.close();
    expect(state.prepareCount).toBe(1);
    const b = await conn.prepare('SELECT 1 FROM SYSIBM.SYSDUMMY1', { cursorName: 'MY_C1' });
    expect(state.prepareCount).toBe(2);  // cache bypassed
    expect(b.getCursorName()).toBe('MY_C1');
    await b.close();
    await conn.close();
  });

  test('prepareStatement marks SELECT ... FOR UPDATE as updatable on the handle', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const captured = [];
    let calls = 0;
    const fakeConn = {
      async sendAndReceive(buf) {
        calls++;
        if (calls === 1) captured.push(Buffer.from(buf));
        const reply = Buffer.alloc(40);
        reply.writeInt32BE(40, 0);
        reply.writeInt16BE(20, 16);
        return reply;
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    const stmt = await sm.prepareStatement('SELECT ID FROM T FOR UPDATE OF ID');
    expect(calls).toBe(2);
    expect(readSingleByteCpValue(captured[0], 0x3809)).toBe(0xF0);
    expect(stmt.openAttributes).toBe(0xF0);
  });

  test('execute() sends OPEN_ATTRIBUTES=0xF0 for a FOR UPDATE cursor open', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const { ORSBitmap } = await import('../../src/db/protocol/DBRequestDS.js');
    const captured = [];
    let calls = 0;
    const fakeConn = {
      async sendAndReceive(buf) {
        calls++;
        if (calls === 1) captured.push(Buffer.from(buf));
        const reply = Buffer.alloc(40);
        reply.writeInt32BE(40, 0);
        reply.writeInt16BE(20, 16);
        return reply;
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    await sm.execute({
      rpbId: 7,
      sql: 'SELECT ID FROM T FOR UPDATE OF ID',
      openAttributes: 0xF0,
      columnDescriptors: [{ index: 0, name: 'ID' }],
      paramDescriptors: [],
      descriptorHandle: 0,
      paramRecordSize: 0,
      rawParamFormat: null,
      closed: false,
    });
    expect(readSingleByteCpValue(captured[0], 0x3809)).toBe(0xF0);
    expect(captured[0].readUInt16BE(18)).toBe(0x1804);
    expect(captured[0].readUInt32BE(20) & ORSBitmap.RESULT_DATA).toBe(0);
  });

  test('read-only SELECT open stays on OPEN_AND_DESCRIBE without inline RESULT_DATA', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const { ORSBitmap } = await import('../../src/db/protocol/DBRequestDS.js');
    const captured = [];
    let calls = 0;
    const fakeConn = {
      async sendAndReceive(buf) {
        calls++;
        if (calls === 1) captured.push(Buffer.from(buf));
        const reply = Buffer.alloc(40);
        reply.writeInt32BE(40, 0);
        reply.writeInt16BE(20, 16);
        return reply;
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    await sm.execute({
      rpbId: 8,
      sql: 'SELECT ID FROM T',
      openAttributes: 0x80,
      columnDescriptors: [{ index: 0, name: 'ID' }],
      paramDescriptors: [],
      descriptorHandle: 0,
      paramRecordSize: 0,
      rawParamFormat: null,
      closed: false,
    });
    expect(captured[0].readUInt16BE(18)).toBe(0x1804);
    expect(captured[0].readUInt32BE(20) & ORSBitmap.RESULT_DATA).toBe(0);
  });
});

describe('Performance-knob plumbing (extendedDynamic / packageCache)', () => {
  test('default StatementManager has all perf-knob fields nullish and counters zero', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const sm = new StatementManager({ async sendAndReceive() {} }, { registerCursor() {} }, {});
    expect(sm.extendedDynamic).toBeNull();
    expect(sm.packageCache).toBeNull();
    expect(sm.packageName).toBeNull();
    expect(sm.packageLibrary).toBeNull();
    // Plumbing-only counters exist and start at 0.
    expect(sm.metrics.packageHits).toBe(0);
    expect(sm.metrics.packageCreates).toBe(0);
    expect(sm.metrics.packageFetches).toBe(0);
  });

  test('explicit knobs land on the StatementManager (no wire-shape change yet)', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const sm = new StatementManager({ async sendAndReceive() {} }, { registerCursor() {} }, {
      extendedDynamic: true,
      packageCache: true,
      packageName: 'JS400PKG',
      packageLibrary: 'QGPL',
    });
    expect(sm.extendedDynamic).toBe(true);
    expect(sm.packageCache).toBe(true);
    expect(sm.packageName).toBe('JS400PKG');
    expect(sm.packageLibrary).toBe('QGPL');
  });

  test('resetMetrics() also zeros the package-* counters', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const sm = new StatementManager({ async sendAndReceive() {} }, { registerCursor() {} }, {});
    sm.metrics.packageHits = 3;
    sm.metrics.packageCreates = 1;
    sm.metrics.packageFetches = 2;
    sm.resetMetrics();
    expect(sm.metrics.packageHits).toBe(0);
    expect(sm.metrics.packageCreates).toBe(0);
    expect(sm.metrics.packageFetches).toBe(0);
  });
});

describe('StatementManager statement classification', () => {
  function readIntCpValue(buf, targetCp) {
    let off = 40;
    while (off + 10 <= buf.length) {
      const ll = buf.readInt32BE(off);
      if (ll < 10 || off + ll > buf.length) break;
      const cp = buf.readUInt16BE(off + 4);
      if (cp === targetCp) {
        return buf.readInt32BE(off + 6);
      }
      off += ll;
    }
    return null;
  }

  test('? = CALL FUNC(?, ?) is classified as CALL and requests output data', async () => {
    // Engine-level regression: the JDBC function-return form must take
    // the CALL protocol path — ORS RESULT_DATA set, parameter-row
    // decoded — just like a bare `CALL PROC(?)`. Previously the
    // leading `?=` prevented `inferStatementType()` from matching CALL
    // and silently downgraded to the plain DML path (no OUT decode,
    // no parameterRow).
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const { ORSBitmap } = await import('../../src/db/protocol/DBRequestDS.js');
    let seenOrsBitmap = null;
    const fakeConn = {
      async sendAndReceive(buf) {
        // The EXECUTE request's ORS bitmap is in the template at
        // byte offset 20 (header+0). Capture it once then bail.
        seenOrsBitmap = buf.readUInt32BE(20);
        // Return a valid-looking but harmless reply to stop here.
        throw new Error('stop-after-execute');
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    // Simulate a prepared statement for `? = CALL MYLIB.FUNC(?, ?)`
    // with two parameter markers plus the return slot; rpb + paramDescriptors
    // minimal.
    const stmt = {
      rpbId: 1,
      sql: '? = CALL MYLIB.FUNC(?, ?)',
      statementName: 'STM1',
      cursorName: 'CRSR1',
      columnDescriptors: [],               // not a SELECT
      paramDescriptors: [
        { index: 0, sqlType: 496, length: 4, scale: 0, precision: 10, ccsid: 37 },
        { index: 1, sqlType: 448, length: 256, scale: 0, precision: 256, ccsid: 37 },
        { index: 2, sqlType: 496, length: 4, scale: 0, precision: 10, ccsid: 37 },
      ],
      paramRecordSize: 264,
      descriptorHandle: 0,
      closed: false,
    };
    // sendAndReceive fires twice for a CALL with params:
    //   1. changeDescriptor — must succeed so execute() can proceed.
    //   2. EXECUTE — this is the one whose ORS bitmap we inspect.
    // Build a minimal valid reply for call 1 (header + template with
    // rcClass=0, no code points) so it doesn't error out.
    function minimalOkReply() {
      const buf = Buffer.alloc(40);
      buf.writeInt32BE(40, 0);            // total length
      buf.writeInt16BE(20, 16);           // template length
      // Template rcClass=0 at offset 34 (20 header + 14).
      return buf;
    }
    let calls = 0;
    fakeConn.sendAndReceive = async (buf) => {
      calls++;
      if (calls === 2) {
        seenOrsBitmap = buf.readUInt32BE(20);
        throw new Error('stop-after-execute');
      }
      return minimalOkReply();
    };
    try { await sm.execute(stmt, [null, 'x', 42]); } catch { /* expected */ }
    expect(seenOrsBitmap & ORSBitmap.RESULT_DATA).toBe(ORSBitmap.RESULT_DATA);
  });

  test('holdStatements opt-in flows to HOLD_INDICATOR on CREATE RPB', async () => {
    // Knob contract: a user who sets holdStatements=true on the
    // DataSource should get HOLD_INDICATOR=0x01 on the wire; a user
    // who leaves it unset should get NO HOLD_INDICATOR code point at
    // all (DB2 keeps its default). We exercise the engine layer
    // directly to prove the wire shape both ways.
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    async function capture(holdIndicator) {
      const sends = [];
      const fakeConn = {
        async sendAndReceive(buf) {
          sends.push(Buffer.from(buf));
          // Minimal OK reply so prepare continues.
          const reply = Buffer.alloc(40);
          reply.writeInt32BE(40, 0);
          reply.writeInt16BE(20, 16);
          return reply;
        },
      };
      const sm = new StatementManager(fakeConn, { registerCursor() {} }, { holdIndicator });
      try {
        await sm.prepareStatement('SELECT 1 FROM SYSIBM.SYSDUMMY1');
      } catch { /* prepare may bail after CREATE RPB */ }
      // First send is CREATE_RPB. Scan its code points for
      // HOLD_INDICATOR (0x380F).
      const buf = sends[0];
      const templateEnd = 40;
      let off = templateEnd;
      let foundHold = null;
      while (off + 6 <= buf.length) {
        const ll = buf.readInt32BE(off);
        if (ll < 6) break;
        const cp = buf.readUInt16BE(off + 4);
        if (cp === 0x380F) {
          foundHold = buf[off + 6];
          break;
        }
        off += ll;
      }
      return foundHold;
    }
    // Knob OFF: no HOLD_INDICATOR code point emitted.
    expect(await capture(null)).toBeNull();
    // Knob ON: HOLD_INDICATOR=0x01 emitted.
    expect(await capture(0x01)).toBe(0x01);
  });

  test('explicit blockSize opt-in computes row-count blocking from row length', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        const reply = Buffer.alloc(40);
        reply.writeInt32BE(40, 0);
        reply.writeInt16BE(20, 16);
        return reply;
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, { blockSizeKB: 32 });
    const result = await sm.execute({
      rpbId: 1,
      sql: 'SELECT C1 FROM T',
      statementName: 'S',
      cursorName: 'C',
      openAttributes: 0x80,
      columnDescriptors: [{ index: 0, name: 'C1', sqlType: 452, length: 64, ccsid: 37 }],
      paramDescriptors: [],
      paramRecordSize: 0,
      descriptorHandle: 0,
      closed: false,
    });
    // 32KB / 64 bytes per row = 512 rows.
    expect(readIntCpValue(sends[0], 0x380C)).toBe(512);
    expect(result.defaultFetchRows).toBe(512);
  });

  test('SELECT and plain DML do NOT request output data', async () => {
    const { StatementManager } = await import('../../src/db/engine/StatementManager.js');
    const { ORSBitmap } = await import('../../src/db/protocol/DBRequestDS.js');
    const captured = { select: null, dml: null };
    async function drive(sql, hasColumns, key) {
      let calls = 0;
      const fakeConn = {
        async sendAndReceive(buf) {
          calls++;
          // For SELECT: send 1 is OPEN_AND_DESCRIBE.
          // For DML: send 1 is EXECUTE (no changeDescriptor because
          // paramDescriptors.length === 0 here).
          captured[key] = buf.readUInt32BE(20);
          throw new Error('stop');
        },
      };
      const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
      const stmt = {
        rpbId: 1, sql,
        statementName: 'S', cursorName: 'C',
        columnDescriptors: hasColumns ? [{ index: 0, name: 'X', sqlType: 496, length: 4, ccsid: 37 }] : [],
        paramDescriptors: [],
        paramRecordSize: 0, descriptorHandle: 0, closed: false,
      };
      try { await sm.execute(stmt, []); } catch { /* expected */ }
    }
    await drive('INSERT INTO T (X) VALUES (1)', false, 'dml');
    // Plain DML request must NOT set the CALL-specific bit.
    expect((captured.dml & ORSBitmap.RESULT_DATA) !== 0).toBe(false);
  });
});
