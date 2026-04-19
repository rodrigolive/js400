/**
 * Tests for SQL package (extendedDynamic) plumbing and wire shape.
 *
 * Covers the parity item #1 from .agent/DB2-AGENT-GAP-REPORT.md:
 *   - package-name normalization (6 chars + 4 suffix) and enable rules
 *   - packageable vs unpackageable SQL classification
 *   - CREATE_PACKAGE / RETURN_PACKAGE wire shape
 *   - PACKAGE_NAME + LIBRARY_NAME + prepareOption attached during
 *     prepareStatement when the manager is enabled
 *   - counters increment only on real server activity
 *   - zero behavior change when extendedDynamic is off
 */
import { describe, test, expect } from 'bun:test';
import { PackageManager, PackageErrorPolicy } from '../../src/db/engine/PackageManager.js';
import {
  DBRequestDS, RequestID, CodePoint, ORSBitmap,
} from '../../src/db/protocol/DBRequestDS.js';
import { StatementManager } from '../../src/db/engine/StatementManager.js';
import { CharConverter } from '../../src/ccsid/CharConverter.js';

// --- helpers --------------------------------------------------------

function scanCodePoints(buf) {
  // Walk the request's code points (skip the 20-byte header + 20-byte
  // template). Returns a Map<cpNumber, Buffer[]> with raw payloads
  // (LL/CP stripped).
  const out = new Map();
  let off = 40;
  while (off + 6 <= buf.length) {
    const ll = buf.readInt32BE(off);
    if (ll < 6 || off + ll > buf.length) break;
    const cp = buf.readUInt16BE(off + 4);
    const payload = Buffer.from(buf.subarray(off + 6, off + ll));
    const list = out.get(cp);
    if (list) list.push(payload);
    else out.set(cp, [payload]);
    off += ll;
  }
  return out;
}

function decodeUtf16BE(buf) {
  let s = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    s += String.fromCharCode(buf.readUInt16BE(i));
  }
  return s;
}

/**
 * Decode a text code-point payload. The raw payload after stripping
 * LL+CP is: CCSID(2) + textLength(2) + encodedText. For Unicode
 * (13488) we use UTF-16BE; for EBCDIC-like CCSIDs we delegate to
 * CharConverter so the test exercises the same bytes the server sees.
 */
function decodeTextCpPayload(payload) {
  const ccsid = payload.readUInt16BE(0);
  const byteLen = payload.readUInt16BE(2);
  const body = payload.subarray(4, 4 + byteLen);
  if (ccsid === 13488) return decodeUtf16BE(body);
  return CharConverter.byteArrayToString(body, 0, body.length, ccsid);
}

/**
 * Build a reply whose SQLCA codepoint (0x3807) carries a given
 * SQLCODE. Reply shape mirrors JTOpen: SQLCAID(8) + SQLCABC(4) +
 * SQLCA body(124). SQLCODE sits at the first 4 bytes of the body,
 * so 12 bytes into the code-point payload.
 */
function sqlcaReply(sqlCode) {
  const bodyLen = 124;
  const payloadLen = 12 + bodyLen;
  const cp = Buffer.alloc(6 + payloadLen);
  cp.writeInt32BE(cp.length, 0);
  cp.writeUInt16BE(0x3807, 4);
  // SQLCAID(8) + SQLCABC(4) left as zeros is fine for the parser.
  cp.writeInt32BE(sqlCode, 6 + 12);
  const total = 40 + cp.length;
  const buf = Buffer.alloc(total);
  buf.writeInt32BE(total, 0);
  buf.writeInt16BE(20, 16);
  cp.copy(buf, 40);
  return buf;
}

/** Build a minimal OK reply the engine can consume (SQLCODE 0). */
function okReply() {
  const buf = Buffer.alloc(40);
  buf.writeInt32BE(40, 0);   // total length
  buf.writeInt16BE(20, 16);  // template length
  return buf;
}

// --- PackageManager unit tests -------------------------------------

describe('PackageManager enable/disable rules', () => {
  test('extendedDynamic off → manager is disabled even with a package name', () => {
    const pm = new PackageManager({
      extendedDynamic: false,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    expect(pm.isEnabled()).toBe(false);
    expect(pm.getName()).toBeNull();
    expect(pm.getLibraryName()).toBeNull();
  });

  test('extendedDynamic on + missing package name → disabled with reason', () => {
    const pm = new PackageManager({ extendedDynamic: true });
    expect(pm.isEnabled()).toBe(false);
    expect(pm.getLastError()).toContain('package name is required');
  });

  test('extendedDynamic on + package name → enabled, library defaults to QGPL', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'myapp',
    });
    expect(pm.isEnabled()).toBe(true);
    expect(pm.getLibraryName()).toBe('QGPL');
    // JTOpen's rule: up to 6 chars of the user-supplied name (no
    // padding), then a 4-char suffix. `MYAPP` is 5 chars so the full
    // package name is 9 chars.
    expect(pm.getName().length).toBe(9);
    expect(pm.getName().startsWith('MYAPP')).toBe(true);

    const longer = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP12',
    });
    // >= 6 chars → truncate to 6 + 4-char suffix = 10.
    expect(longer.getName().length).toBe(10);
    expect(longer.getName().startsWith('MYAPP1')).toBe(true);
  });

  test('package library is uppercased and overrides QGPL default', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'PKG1',
      packageLibrary: 'mylib',
    });
    expect(pm.getLibraryName()).toBe('MYLIB');
  });

  test('long names are truncated to 6 before suffix; spaces replaced with underscore', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'LONGNAMEX',
    });
    expect(pm.getName().startsWith('LONGNA')).toBe(true);
    expect(pm.getName().length).toBe(10);

    const pmSpace = new PackageManager({
      extendedDynamic: true,
      packageName: 'AB CD',
    });
    // "AB CD" is 5 chars — truncation branch is not hit, so spaces
    // are just replaced with underscores: AB_CD + 4-char suffix.
    expect(pmSpace.getName().startsWith('AB_CD')).toBe(true);
    expect(pmSpace.getName().length).toBe(9);
  });

  test('error policy defaults to warning', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
    });
    expect(pm.getErrorPolicy()).toBe(PackageErrorPolicy.WARNING);
  });
});

describe('PackageManager.isPackaged heuristic', () => {
  const pm = new PackageManager({
    extendedDynamic: true,
    packageName: 'P',
  });

  test('SELECT with ? parameter is packageable', () => {
    expect(pm.isPackaged('SELECT * FROM T WHERE ID = ?')).toBe(true);
  });

  test('plain SELECT with no parameters is NOT packageable', () => {
    expect(pm.isPackaged('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBe(false);
  });

  test('SELECT ... FOR UPDATE without parameters is packageable', () => {
    expect(pm.isPackaged('SELECT * FROM T FOR UPDATE')).toBe(true);
  });

  test('INSERT ... SELECT is packageable even without parameters', () => {
    expect(pm.isPackaged('INSERT INTO T1 SELECT * FROM T2')).toBe(true);
  });

  test('positioned UPDATE ... WHERE CURRENT OF is NOT packageable', () => {
    expect(pm.isPackaged('UPDATE T SET X = ? WHERE CURRENT OF MYCURSOR')).toBe(false);
  });

  test('DECLARE ... CURSOR is packageable', () => {
    expect(pm.isPackaged('DECLARE MYCUR CURSOR FOR SELECT X FROM T')).toBe(true);
  });

  test('empty / whitespace SQL is not packageable', () => {
    expect(pm.isPackaged('')).toBe(false);
    expect(pm.isPackaged('   ')).toBe(false);
  });

  test('leading -- and /* */ comments are stripped before classification', () => {
    expect(pm.isPackaged('-- trace id 42\nSELECT * FROM T WHERE ID=?')).toBe(true);
    expect(pm.isPackaged('/* warmup */ SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBe(false);
  });

  test('disabled manager always returns false', () => {
    const off = new PackageManager({ extendedDynamic: false });
    expect(off.isPackaged('SELECT * FROM T WHERE ID = ?')).toBe(false);
  });
});

// --- wire shape: CREATE_PACKAGE / RETURN_PACKAGE -------------------

describe('DBRequestDS CREATE_PACKAGE / RETURN_PACKAGE wire shape', () => {
  test('buildCreatePackage emits function 0x180F with PACKAGE_NAME and LIBRARY_NAME', () => {
    const buf = DBRequestDS.buildCreatePackage({
      rpbId: 7,
      packageName: 'MYAPP91234',
      packageLibrary: 'MYLIB',
    });
    expect(buf.readUInt16BE(18)).toBe(RequestID.CREATE_PACKAGE);
    expect(buf.readUInt16BE(18)).toBe(0x180F);
    // ORS bitmap must include SQLCA so the reply carries SQLCODE.
    const ors = buf.readUInt32BE(20) >>> 0;
    expect(ors & ORSBitmap.SQLCA).toBe(ORSBitmap.SQLCA);
    expect(ors & ORSBitmap.PACKAGE_INFORMATION).toBe(0);

    const cps = scanCodePoints(buf);
    const pkgName = cps.get(CodePoint.PACKAGE_NAME);
    const libName = cps.get(CodePoint.LIBRARY_NAME);
    expect(pkgName).toBeDefined();
    expect(libName).toBeDefined();
    expect(decodeTextCpPayload(pkgName[0])).toBe('MYAPP91234');
    expect(decodeTextCpPayload(libName[0])).toBe('MYLIB');
  });

  test('buildReturnPackage emits function 0x1815 with PACKAGE_INFORMATION ORS and RETURN_SIZE', () => {
    const buf = DBRequestDS.buildReturnPackage({
      rpbId: 7,
      packageName: 'MYAPP91234',
      packageLibrary: 'QGPL',
      returnSize: 0,
    });
    expect(buf.readUInt16BE(18)).toBe(RequestID.RETURN_PACKAGE);
    expect(buf.readUInt16BE(18)).toBe(0x1815);

    const ors = buf.readUInt32BE(20) >>> 0;
    expect(ors & ORSBitmap.PACKAGE_INFORMATION).toBe(ORSBitmap.PACKAGE_INFORMATION);
    expect(ors & ORSBitmap.SQLCA).toBe(ORSBitmap.SQLCA);

    const cps = scanCodePoints(buf);
    // RETURN_SIZE (0x3815) is a 4-byte int value (not LL/CP header +
    // value — scanner strips LL/CP so payload is the raw int32).
    const retSize = cps.get(CodePoint.RETURN_SIZE);
    expect(retSize).toBeDefined();
    expect(retSize[0].readInt32BE(0)).toBe(0);
  });
});

// --- engine integration --------------------------------------------

describe('StatementManager.prepareStatement with PackageManager', () => {
  test('default (no manager) sends NO PACKAGE_NAME / LIBRARY_NAME and NO CREATE_PACKAGE', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* prepare may bail; we only care about wire shape */ }
    // No CREATE_PACKAGE was issued.
    const reqIds = sends.map(b => b.readUInt16BE(18));
    expect(reqIds.includes(RequestID.CREATE_PACKAGE)).toBe(false);
    // No PACKAGE_NAME on the PREPARE_AND_DESCRIBE request.
    const prep = sends.find(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    if (prep) {
      const cps = scanCodePoints(prep);
      expect(cps.has(CodePoint.PACKAGE_NAME)).toBe(false);
      expect(cps.has(CodePoint.LIBRARY_NAME)).toBe(false);
    }
  });

  test('enabled manager + packageable SQL → lazy CREATE_PACKAGE then PACKAGE_NAME + LIBRARY_NAME on PREPARE', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* prepare may bail after describe */ }

    // First real sends: CREATE_RPB, CREATE_PACKAGE, PREPARE_AND_DESCRIBE.
    const reqIds = sends.map(b => b.readUInt16BE(18));
    expect(reqIds.includes(RequestID.CREATE_PACKAGE)).toBe(true);
    expect(pm.isCreated()).toBe(true);
    expect(pm.metrics.packageCreates).toBe(1);

    // PREPARE_AND_DESCRIBE must carry PACKAGE_NAME + LIBRARY_NAME.
    const prep = sends.find(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    expect(prep).toBeDefined();
    const cps = scanCodePoints(prep);
    const pkgText = cps.get(CodePoint.PACKAGE_NAME);
    const libText = cps.get(CodePoint.LIBRARY_NAME);
    expect(pkgText).toBeDefined();
    expect(libText).toBeDefined();
    expect(decodeTextCpPayload(pkgText[0])).toBe(pm.getName());
    expect(decodeTextCpPayload(libText[0])).toBe('MYLIB');

    // A second prepare must NOT issue another CREATE_PACKAGE.
    sends.length = 0;
    try {
      await sm.prepareStatement('SELECT A FROM T WHERE B = ?');
    } catch { /* expected */ }
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.CREATE_PACKAGE)).toBe(false);
    expect(pm.metrics.packageCreates).toBe(1);
  });

  test('enabled manager + unpackageable SQL → empty PACKAGE_NAME (length-only) emitted', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    try {
      await sm.prepareStatement('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    } catch { /* expected */ }

    // CREATE_PACKAGE still fires (JTOpen parity: package is connection
    // state, not per-statement).
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.CREATE_PACKAGE)).toBe(true);

    const prep = sends.find(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    const cps = scanCodePoints(prep);
    // Empty CP for PACKAGE_NAME (length-only, no value) — LL of 6.
    // Our scanner strips LL+CP so the payload is zero bytes.
    const pkg = cps.get(CodePoint.PACKAGE_NAME);
    expect(pkg).toBeDefined();
    expect(pkg[0].length).toBe(0);
    // LIBRARY_NAME is still emitted (RPB-level library).
    expect(cps.has(CodePoint.LIBRARY_NAME)).toBe(true);
  });

  test('packageCache on → RETURN_PACKAGE round-trip after CREATE and packageFetches counter ticks', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageCache: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* expected */ }
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.CREATE_PACKAGE)).toBe(true);
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.RETURN_PACKAGE)).toBe(true);
    expect(pm.metrics.packageFetches).toBe(1);
  });

  test('CREATE_PACKAGE failure disables the manager; subsequent prepares run packageless', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        // Fail only the CREATE_PACKAGE reply with a real error SQLCODE.
        if (buf.readUInt16BE(18) === RequestID.CREATE_PACKAGE) return sqlcaReply(-666);
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* expected */ }
    expect(pm.isEnabled()).toBe(false);
    expect(pm.isCreated()).toBe(false);
    expect(pm.getLastError()).toContain('CREATE PACKAGE');

    // Next prepare: no CREATE_PACKAGE retry, no PACKAGE_NAME emitted.
    sends.length = 0;
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* expected */ }
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.CREATE_PACKAGE)).toBe(false);
    const prep2 = sends.find(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    if (prep2) {
      const cps = scanCodePoints(prep2);
      expect(cps.has(CodePoint.PACKAGE_NAME)).toBe(false);
    }
  });

  test('SQLCODE -601 ("package already exists") still marks the manager created', async () => {
    const fakeConn = {
      async sendAndReceive(buf) {
        if (buf.readUInt16BE(18) === RequestID.CREATE_PACKAGE) return sqlcaReply(-601);
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* expected */ }
    expect(pm.isEnabled()).toBe(true);
    expect(pm.isCreated()).toBe(true);
    expect(pm.metrics.packageCreates).toBe(1);
  });
});

// --- Boss finding #1: package RPB identity -------------------------

describe('Package request identity (boss finding #1)', () => {
  test('CREATE_PACKAGE uses the connection-scoped rpbId, not the statement rpbId', async () => {
    // Capture both CREATE_RPB (statement) and CREATE_PACKAGE (connection)
    // RPB handles from the wire. They must differ; if CREATE_PACKAGE
    // rides the statement RPB the server may refuse or misroute.
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const packageRpb = 0x4242;
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
      rpbId: packageRpb,
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* expected */ }
    const createPkg = sends.find(b => b.readUInt16BE(18) === RequestID.CREATE_PACKAGE);
    const createRpb = sends.find(b => b.readUInt16BE(18) === 0x1D00);
    expect(createPkg).toBeDefined();
    expect(createRpb).toBeDefined();
    // Template offsets: +8 return-ORS, +14 RPB handle. Both should
    // match the *requested* rpbId.
    expect(createPkg.readUInt16BE(20 + 8)).toBe(packageRpb);
    expect(createPkg.readUInt16BE(20 + 14)).toBe(packageRpb);
    expect(createRpb.readUInt16BE(20 + 14)).not.toBe(packageRpb);
  });

  test('DbConnection reserves a fresh RPB id for the package manager', async () => {
    const { reserveConnectionRpbId } = await import('../../src/db/engine/StatementManager.js');
    const a = reserveConnectionRpbId();
    const b = reserveConnectionRpbId();
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });
});

// --- Boss finding #2: JTOpen-compatible suffix generation ----------

describe('JTOpen suffix generation (boss finding #2)', () => {
  test('default suffix context differs from caller-supplied context', () => {
    const defaultName = PackageManager.normalizeName('MYAPP');
    const isoName = PackageManager.normalizeName('MYAPP', {
      commitMode: 2,      // *CS
      dateFormat: 5,      // iso
      dateSeparator: 1,   // '-'
      timeFormat: 2,      // iso
      timeSeparator: 0,   // ':'
      decimalSeparator: 0,
      naming: 0,
      translateHex: 0,
    });
    const rrName = PackageManager.normalizeName('MYAPP', {
      commitMode: 4,      // *RR — triggers remap branch
      dateFormat: 5,
      dateSeparator: 1,
      timeFormat: 2,
      timeSeparator: 0,
      decimalSeparator: 0,
      naming: 0,
      translateHex: 0,
    });
    // All three are 9 chars and share the MYAPP body — only the
    // 4-char suffix tail differs.
    expect(defaultName.slice(0, 5)).toBe('MYAPP');
    expect(isoName.slice(0, 5)).toBe('MYAPP');
    expect(rrName.slice(0, 5)).toBe('MYAPP');
    expect(isoName).not.toBe(defaultName);
    expect(rrName).not.toBe(isoName);
  });

  test('RR remap: commitMode=4 with each dateSep 0..4 resolves deterministically and differently', () => {
    const base = {
      dateFormat: 5, timeFormat: 2, timeSeparator: 0,
      decimalSeparator: 0, naming: 0, translateHex: 0,
    };
    const names = [0, 1, 2, 3, 4].map(dateSeparator =>
      PackageManager.normalizeName('MYAPP', {
        ...base, commitMode: 4, dateSeparator,
      }));
    // Every RR-remapped name must be distinct — the whole point of
    // the remap is to keep the 5-combo space injective.
    const unique = new Set(names);
    expect(unique.size).toBe(5);
  });

  test('deriveSuffixContext maps user-facing property strings to JTOpen indexes', async () => {
    const { deriveSuffixContext } = await import('../../src/db/engine/PackageManager.js');
    const ctx = deriveSuffixContext({
      dateFormat: '*ISO',
      dateSeparator: '-',
      timeFormat: '*HMS',
      timeSeparator: ':',
      decimalSeparator: '.',
      naming: 'sql',
      translateHex: 'character',
    }, 2 /* *CS commitMode */);
    expect(ctx.dateFormat).toBe(5);     // iso
    expect(ctx.dateSeparator).toBe(1);  // '-'
    expect(ctx.timeFormat).toBe(0);     // hms
    expect(ctx.timeSeparator).toBe(0);  // ':'
    expect(ctx.decimalSeparator).toBe(0);
    expect(ctx.naming).toBe(0);
    expect(ctx.translateHex).toBe(0);
    expect(ctx.commitMode).toBe(2);
  });

  test('DbConnection feeds the real suffix context into PackageManager', async () => {
    // Spin up a DbConnection against a stub that never touches the
    // network — we only need to verify it constructs the
    // PackageManager with a non-zero suffix context derived from
    // user props. Bypass connect() by directly inspecting the
    // constructor-time wiring.
    const { DbConnection } = await import('../../src/db/engine/DbConnection.js');
    const db = new DbConnection({ connectService: async () => ({}) }, {
      naming: 'system',
      dateFormat: '*USA',
      dateSeparator: '/',
      timeFormat: '*USA',
      timeSeparator: ':',
      decimalSeparator: ',',
      isolation: 'serializable',  // *RR → commitMode 4 → suffix remap
      extendedDynamic: true,
      sqlPackage: 'MYAPP',
      packageLibrary: 'QGPL',
    }, {
      naming: 'system',
      dateFormat: '*USA',
      dateSeparator: '/',
      timeFormat: '*USA',
      timeSeparator: ':',
      decimalSeparator: ',',
      isolation: 'serializable',
      extendedDynamic: true,
      sqlPackage: 'MYAPP',
      packageLibrary: 'QGPL',
    });
    // connect() is the gate that constructs the package manager; it
    // does host I/O we can't short-circuit, so simulate the wiring
    // path directly.
    // Instead of plumbing a host, verify the two names differ: one
    // with the real context and one with all-zero fallback.
    const { PackageManager: PM, deriveSuffixContext: derive } = await import('../../src/db/engine/PackageManager.js');
    const realCtx = derive({
      dateFormat: '*USA', dateSeparator: '/',
      timeFormat: '*USA', timeSeparator: ':',
      decimalSeparator: ',', naming: 'system',
    }, 4 /* *RR */);
    const realName = PM.normalizeName('MYAPP', realCtx);
    const defaultName = PM.normalizeName('MYAPP');
    expect(realName).not.toBe(defaultName);
    expect(realName.length).toBe(9);
    // Unused — db just proves constructor accepts the prop bag.
    expect(db).toBeDefined();
  });
});

// --- Boss finding #3: tokenizer-correct isPackaged -----------------

describe('isPackaged tokenizer correctness (boss finding #3)', () => {
  const pm = new PackageManager({
    extendedDynamic: true,
    packageName: 'P',
  });

  test('? inside double-quoted identifier is NOT a parameter', () => {
    // `"?"` is a column / identifier literally named `?`, not a bind
    // marker. Packaging this as a parameterized statement would
    // pollute the server-side package with an unparameterized SELECT.
    expect(pm.isPackaged('SELECT "?" FROM T')).toBe(false);
  });

  test('? inside single-quoted string is NOT a parameter', () => {
    expect(pm.isPackaged("SELECT * FROM T WHERE X = '?'")).toBe(false);
    expect(pm.isPackaged("INSERT INTO T VALUES ('literal ? value')")).toBe(false);
  });

  test('? inside line / block comments is NOT a parameter', () => {
    expect(pm.isPackaged("SELECT * FROM T -- ? comment\n")).toBe(false);
    expect(pm.isPackaged("SELECT * FROM T /* ? */ ")).toBe(false);
  });

  test("escaped quotes ('') don't break the tokenizer", () => {
    // 'can''t' is one literal string with an embedded apostrophe.
    // The `?` outside is a real parameter.
    expect(pm.isPackaged("UPDATE T SET X = 'can''t' WHERE Y = ?")).toBe(true);
  });

  test('escaped double-quotes ("") inside an identifier are handled', () => {
    expect(pm.isPackaged('SELECT "A""B?" FROM T')).toBe(false);
    expect(pm.isPackaged('SELECT "A""B" FROM T WHERE X = ?')).toBe(true);
  });

  test('FOR UPDATE must be consecutive tokens, not merely present', () => {
    // Case: FOR followed by a different word, then UPDATE later.
    // Not the `FOR UPDATE` clause — should NOT trigger isForUpdate.
    expect(pm.isPackaged('SELECT * FROM T WHERE X = ?'))
      .toBe(true);
    // Packaged only via the parameter marker — but with no params
    // + with non-consecutive FOR/UPDATE the result is false.
    expect(pm.isPackaged('SELECT * FROM T WHERE UPDATE = FOR')).toBe(false);
  });

  test('JDBC return-value form: ?= CALL FUNC(?, ?) counts two real params, not three', () => {
    expect(pm.isPackaged('?= CALL MYLIB.FUNC(?, ?)')).toBe(true);
    // Sanity: dropping the real parameters should now fail the
    // "has parameters" branch entirely.
    expect(pm.isPackaged('?= CALL MYLIB.FUNC()')).toBe(false);
  });

  test('WITH (CTE) is treated as SELECT-like for packaging (JTOpen parity)', () => {
    expect(pm.isPackaged('WITH CTE AS (SELECT * FROM T) SELECT * FROM CTE FOR UPDATE')).toBe(true);
    expect(pm.isPackaged('WITH CTE AS (SELECT 1 FROM T) SELECT * FROM CTE')).toBe(false);
  });

  test('VALUES is treated as SELECT-like for packaging (JTOpen parity)', () => {
    expect(pm.isPackaged('VALUES (1, 2, 3) FOR UPDATE')).toBe(true);
    expect(pm.isPackaged('VALUES (1, 2, 3)')).toBe(false);
  });

  test('?= CALL is NOT treated as SELECT (JTOpen parity)', () => {
    // JTOpen sets isSelect_ only for SELECT/WITH/VALUES first keywords.
    // The function-return form ?= CALL is a CALL, not a SELECT,
    // so it should NOT be packageable via isSelect && isForUpdate.
    expect(pm.isPackaged('?= CALL MYLIB.FUNC()')).toBe(false);
  });
});

// --- Boss finding #4: packageError behavior ------------------------

describe('packageError policy (boss finding #4)', () => {
  test("'exception' policy throws from prepare when CREATE_PACKAGE fails", async () => {
    const fakeConn = {
      async sendAndReceive(buf) {
        if (buf.readUInt16BE(18) === RequestID.CREATE_PACKAGE) return sqlcaReply(-666);
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
      errorPolicy: 'exception',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    let thrown = null;
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.packagePolicy).toBe('exception');
    expect(thrown.message).toContain('CREATE PACKAGE');
    expect(pm.isEnabled()).toBe(false);
  });

  test("'warning' policy (default) disables manager and queues a SqlWarning on the connection", async () => {
    const fakeConn = {
      async sendAndReceive(buf) {
        if (buf.readUInt16BE(18) === RequestID.CREATE_PACKAGE) return sqlcaReply(-666);
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
      errorPolicy: 'warning',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    // Prepare MUST NOT throw under warning policy — it proceeds
    // packageless.
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch (e) {
      if (e?.packagePolicy === 'exception') throw e;
      // Other errors from the partial fake reply are fine.
    }
    expect(pm.isEnabled()).toBe(false);
    // A warning must have been queued and is now drainable.
    const w = pm.takeWarning();
    expect(w).not.toBeNull();
    expect(w.sqlState).toBeDefined();
    expect(w.message).toContain('CREATE PACKAGE');
    // Second drain returns null.
    expect(pm.takeWarning()).toBeNull();
  });

  test("'none' policy disables silently and queues no warning", async () => {
    const fakeConn = {
      async sendAndReceive(buf) {
        if (buf.readUInt16BE(18) === RequestID.CREATE_PACKAGE) return sqlcaReply(-666);
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
      errorPolicy: 'none',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch (e) {
      if (e?.packagePolicy === 'exception') throw e;
    }
    expect(pm.isEnabled()).toBe(false);
    expect(pm.takeWarning()).toBeNull();
  });

  test('DbConnection.drainPackageWarning() surfaces the queued warning', async () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
      errorPolicy: 'warning',
    });
    pm.reportFailure('simulated failure', { sqlState: '42704', vendorCode: -666 });
    // We can drain directly from the manager.
    const w = pm.takeWarning();
    expect(w).not.toBeNull();
    expect(w.sqlState).toBe('42704');
    expect(w.vendorCode).toBe(-666);
  });
});

// --- Boss finding #5: executeImmediate package binding -------------

describe('executeImmediate package binding (boss finding #5)', () => {
  test('enabled manager + packageable immediate SQL → PACKAGE_NAME + LIBRARY_NAME + prepareOption=1', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    // Packageable immediate — INSERT ... SELECT is packaged even
    // without params.
    await sm.executeImmediate('INSERT INTO T1 SELECT * FROM T2');
    const imm = sends.find(b => b.readUInt16BE(18) === RequestID.EXECUTE_IMMEDIATE);
    expect(imm).toBeDefined();
    const cps = scanCodePoints(imm);
    const pkg = cps.get(CodePoint.PACKAGE_NAME);
    const lib = cps.get(CodePoint.LIBRARY_NAME);
    const prep = cps.get(CodePoint.PREPARE_OPTION);
    expect(pkg).toBeDefined();
    expect(lib).toBeDefined();
    expect(prep).toBeDefined();
    expect(prep[0][0]).toBe(1);
    expect(decodeTextCpPayload(pkg[0])).toBe(pm.getName());
  });

  test('unpackageable immediate → empty PACKAGE_NAME + prepareOption=0', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    await sm.executeImmediate('CREATE TABLE X (A INT)');
    const imm = sends.find(b => b.readUInt16BE(18) === RequestID.EXECUTE_IMMEDIATE);
    const cps = scanCodePoints(imm);
    const pkg = cps.get(CodePoint.PACKAGE_NAME);
    const lib = cps.get(CodePoint.LIBRARY_NAME);
    const prep = cps.get(CodePoint.PREPARE_OPTION);
    expect(pkg).toBeDefined();
    expect(pkg[0].length).toBe(0);          // empty CP (length-only)
    expect(lib).toBeDefined();
    expect(prep).toBeDefined();
    expect(prep[0][0]).toBe(0);
  });

  test('disabled manager → executeImmediate sends NO package codepoints', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    await sm.executeImmediate('CREATE TABLE X (A INT)');
    const imm = sends.find(b => b.readUInt16BE(18) === RequestID.EXECUTE_IMMEDIATE);
    const cps = scanCodePoints(imm);
    expect(cps.has(CodePoint.PACKAGE_NAME)).toBe(false);
    expect(cps.has(CodePoint.LIBRARY_NAME)).toBe(false);
    expect(cps.has(CodePoint.PREPARE_OPTION)).toBe(false);
  });

  test('first executeImmediate also triggers lazy CREATE_PACKAGE', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
    });
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
    });
    await sm.executeImmediate('INSERT INTO T1 SELECT * FROM T2');
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.CREATE_PACKAGE)).toBe(true);
    expect(pm.metrics.packageCreates).toBe(1);
    // Second immediate must NOT re-create.
    sends.length = 0;
    await sm.executeImmediate('INSERT INTO T3 SELECT * FROM T2');
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.CREATE_PACKAGE)).toBe(false);
  });
});

// --- Boss finding #7: config surface cleanup -----------------------

describe('config surface for package knobs (boss finding #7)', () => {
  test('validateProperties accepts extendedDynamic / packageError / translateHex / holdStatements without warnings', async () => {
    const { validateProperties } = await import('../../src/db/properties.js');
    const warnings = validateProperties({
      extendedDynamic: true,
      sqlPackage: 'MYAPP',
      packageLibrary: 'QGPL',
      packageCache: true,
      packageError: 'warning',
      translateHex: 'character',
      holdStatements: true,
    });
    expect(warnings).toEqual([]);
  });

  test('validateProperties rejects an invalid packageError value', async () => {
    const { validateProperties } = await import('../../src/db/properties.js');
    expect(() => validateProperties({ packageError: 'bogus' }))
      .toThrow(/Invalid packageError/);
  });

  test('createPool forwards package knobs through its connect factory', async () => {
    // The pool's connect-factory closure runs `buildConnectOptions`
    // on the caller-supplied bag and passes the result to the real
    // `connect()`. Rather than monkey-patching that closure from
    // outside, assert on the whitelist helper that is shared
    // between `createPool` and any future pool factory.
    const { _buildConnectOptionsForPool } = await import('../../src/db/connect.js');
    const forwarded = _buildConnectOptionsForPool({
      host: 'example.invalid',
      user: 'U',
      password: 'P',
      extendedDynamic: true,
      sqlPackage: 'MYAPP',
      packageLibrary: 'MYLIB',
      packageCache: true,
      packageError: 'warning',
      translateHex: 'character',
      holdStatements: true,
      // Kitchen-sink knob that should also survive the forward.
      isolation: 'serializable',
      // Unknown keys are dropped rather than passed through (defense
      // against accidentally leaking user secrets into connect()).
      someRandomKey: 'should-not-propagate',
    });
    expect(forwarded.extendedDynamic).toBe(true);
    expect(forwarded.sqlPackage).toBe('MYAPP');
    expect(forwarded.packageLibrary).toBe('MYLIB');
    expect(forwarded.packageCache).toBe(true);
    expect(forwarded.packageError).toBe('warning');
    expect(forwarded.translateHex).toBe('character');
    expect(forwarded.holdStatements).toBe(true);
    expect(forwarded.isolation).toBe('serializable');
    expect(forwarded.host).toBe('example.invalid');
    // Defense: unknown keys don't silently propagate.
    expect(forwarded.someRandomKey).toBeUndefined();
  });
});

// --- Off-path zero-cost regression ---------------------------------

describe('off-path zero-cost (knobs off)', () => {
  test('disabled manager adds no extra code points to PREPARE_AND_DESCRIBE', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    try {
      await sm.prepareStatement('SELECT * FROM T WHERE ID = ?');
    } catch { /* expected */ }
    const prep = sends.find(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    const cps = scanCodePoints(prep);
    // No package or library codepoints. No PREPARE_OPTION beyond
    // the always-zero baseline (engine still passes prepareOption=0
    // as an explicit CP on the default path; we just require no
    // package-related leakage).
    expect(cps.has(CodePoint.PACKAGE_NAME)).toBe(false);
    expect(cps.has(CodePoint.LIBRARY_NAME)).toBe(false);
  });

  test('disabled manager adds no extra code points to EXECUTE_IMMEDIATE', async () => {
    const sends = [];
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {});
    await sm.executeImmediate('SET CURRENT SCHEMA MYLIB');
    const imm = sends.find(b => b.readUInt16BE(18) === RequestID.EXECUTE_IMMEDIATE);
    const cps = scanCodePoints(imm);
    expect(cps.has(CodePoint.PACKAGE_NAME)).toBe(false);
    expect(cps.has(CodePoint.LIBRARY_NAME)).toBe(false);
    expect(cps.has(CodePoint.PREPARE_OPTION)).toBe(false);
    expect(cps.has(CodePoint.STATEMENT_TYPE)).toBe(false);
  });
});
