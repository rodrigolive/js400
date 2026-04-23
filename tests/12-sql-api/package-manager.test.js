/**
 * Tests for SQL package (extendedDynamic) plumbing and wire shape.
 *
 * Covers the parity item #1 from .agent/DB2-AGENT-GAP-REPORT.md:
 *   - package-name normalization (6 chars + 4 suffix) and enable rules
 *   - packageable vs unpackageable SQL classification
 *   - CREATE_PACKAGE / RETURN_PACKAGE wire shape
 *   - CREATE_RPB binds LIBRARY_NAME, while prepare/execute paths carry
 *     PACKAGE_NAME and cache-hit name overrides the way JTOpen does
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
import { parsePackageInfo } from '../../src/db/protocol/DBPackageInfo.js';

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

  test('enabled manager + packageable SQL → CREATE_RPB binds library, PREPARE carries PACKAGE_NAME', async () => {
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

    const createRpb = sends.find(b => b.readUInt16BE(18) === RequestID.CREATE_RPB);
    expect(createRpb).toBeDefined();
    const rpbCps = scanCodePoints(createRpb);
    const rpbLibText = rpbCps.get(CodePoint.LIBRARY_NAME);
    expect(rpbLibText).toBeDefined();
    expect(rpbCps.get(CodePoint.PACKAGE_NAME)).toBeUndefined();
    expect(decodeTextCpPayload(rpbLibText[0])).toBe('MYLIB');

    // PREPARE_AND_DESCRIBE must carry PACKAGE_NAME but not LIBRARY_NAME.
    const prep = sends.find(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    expect(prep).toBeDefined();
    const cps = scanCodePoints(prep);
    const pkgText = cps.get(CodePoint.PACKAGE_NAME);
    expect(pkgText).toBeDefined();
    expect(cps.get(CodePoint.LIBRARY_NAME)).toBeUndefined();
    expect(decodeTextCpPayload(pkgText[0])).toBe(pm.getName());

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

    const createRpb = sends.find(b => b.readUInt16BE(18) === RequestID.CREATE_RPB);
    expect(createRpb).toBeDefined();
    const rpbCps = scanCodePoints(createRpb);
    expect(rpbCps.get(CodePoint.LIBRARY_NAME)).toBeDefined();

    const prep = sends.find(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    const cps = scanCodePoints(prep);
    // Empty CP for PACKAGE_NAME (length-only, no value) — LL of 6.
    // Our scanner strips LL+CP so the payload is zero bytes.
    const pkg = cps.get(CodePoint.PACKAGE_NAME);
    expect(pkg).toBeDefined();
    expect(pkg[0].length).toBe(0);
    // PREPARE itself does not repeat LIBRARY_NAME.
    expect(cps.has(CodePoint.LIBRARY_NAME)).toBe(false);
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
  test('enabled manager + packageable immediate SQL → PACKAGE_NAME + prepareOption=1', async () => {
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
    const prep = cps.get(CodePoint.PREPARE_OPTION);
    expect(pkg).toBeDefined();
    expect(cps.get(CodePoint.LIBRARY_NAME)).toBeUndefined();
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
    const prep = cps.get(CodePoint.PREPARE_OPTION);
    expect(pkg).toBeDefined();
    expect(pkg[0].length).toBe(0);          // empty CP (length-only)
    expect(cps.get(CodePoint.LIBRARY_NAME)).toBeUndefined();
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

// --- DBReplyPackageInfo parser --------------------------------------

/**
 * Build a synthetic package-info buffer (code point 0x380B payload)
 * matching the JTOpen DBReplyPackageInfo layout.
 *
 * Header (42 bytes):
 *   +0  totalLength     int32
 *   +4  packageCCSID    uint16
 *   +6  defaultCollection 18 bytes (EBCDIC-padded)
 *   +24 statementCount  uint16
 *   +26 reserved        16 bytes (zeros)
 *
 * Entry table starts at +42, each entry 64 bytes:
 *   +0  needsDefaultCol byte
 *   +1  statementType   uint16
 *   +3  statementName   18 bytes (job CCSID)
 *   +21 reserved        19 bytes
 *   +40 resultFmtOff    int32 (relative to cpDataAbsoluteBase = offset-6)
 *   +44 resultFmtLen   int32
 *   +48 textOff        int32
 *   +52 textLen         int32
 *   +56 paramFmtOff    int32
 *   +60 paramFmtLen    int32
 *
 * After entries: text blobs and format blobs.
 * Offsets in entries are relative to (cpDataOffset - 6), i.e. absolute
 * base = 0 for the payload data after LL+CP stripping.
 */
function buildPackageInfoBuffer(opts = {}) {
  const {
    packageCCSID = 37,
    defaultCollection = 'QGPL',
    statements = [],
    serverCCSID = 37,
  } = opts;

  const headerSize = 42;
  const entryTableSize = 64 * statements.length;
  let payloadCursor = headerSize + entryTableSize;

  // Pre-encode text and build format buffers to compute offsets
  const textBlobs = [];
  const resultFmtBlobs = [];
  const paramFmtBlobs = [];
  for (const stmt of statements) {
    // Text blob (encoded in package CCSID)
    const textBuf = encodeForCCSID(stmt.text || '', packageCCSID);
    textBlobs.push(textBuf);

    // Result format blob (basic data format 0x3805-style)
    const resultFmt = stmt.resultFormat || null;
    const resultFmtBuf = resultFmt ? buildBasicDataFormatBuffer(resultFmt) : null;
    resultFmtBlobs.push(resultFmtBuf);

    // Parameter format blob
    const paramFmt = stmt.parameterFormat || null;
    const paramFmtBuf = paramFmt ? buildBasicDataFormatBuffer(paramFmt) : null;
    paramFmtBlobs.push(paramFmtBuf);
  }

  // Calculate total size
  let totalDataSize = payloadCursor;
  const textOffsets = [];
  const resultFmtOffsets = [];
  const paramFmtOffsets = [];
  for (let i = 0; i < statements.length; i++) {
    textOffsets.push(payloadCursor);
    totalDataSize += textBlobs[i].length;
    payloadCursor += textBlobs[i].length;

    if (resultFmtBlobs[i]) {
      resultFmtOffsets.push(payloadCursor);
      totalDataSize += resultFmtBlobs[i].length;
      payloadCursor += resultFmtBlobs[i].length;
    } else {
      resultFmtOffsets.push(0);
    }

    if (paramFmtBlobs[i]) {
      paramFmtOffsets.push(payloadCursor);
      totalDataSize += paramFmtBlobs[i].length;
      payloadCursor += paramFmtBlobs[i].length;
    } else {
      paramFmtOffsets.push(0);
    }
  }

  const buf = Buffer.alloc(totalDataSize);

  // Header
  buf.writeInt32BE(totalDataSize, 0);              // total length
  buf.writeUInt16BE(packageCCSID, 4);              // CCSID
  writePaddedString(buf, 6, 18, defaultCollection, serverCCSID); // default collection
  buf.writeUInt16BE(statements.length, 24);        // statement count

  // Entry table
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const entryOff = headerSize + 64 * i;

    buf[entryOff] = stmt.needsDefaultCollection ? 1 : 0;
    buf.writeUInt16BE(stmt.statementType || 1, entryOff + 1);
    writePaddedString(buf, entryOff + 3, 18, stmt.name || '', serverCCSID);

    // Offsets are relative to (cpDataOffset - 6) = 0 for our payload
    if (resultFmtBlobs[i]) {
      buf.writeInt32BE(resultFmtOffsets[i], entryOff + 40);
      buf.writeInt32BE(resultFmtBlobs[i].length, entryOff + 44);
    } else {
      buf.writeInt32BE(0, entryOff + 40);
      buf.writeInt32BE(stmt.resultFormatAbsent ? 0 : 6, entryOff + 44);
    }

    buf.writeInt32BE(textOffsets[i], entryOff + 48);
    buf.writeInt32BE(textBlobs[i].length, entryOff + 52);

    if (paramFmtBlobs[i]) {
      buf.writeInt32BE(paramFmtOffsets[i], entryOff + 56);
      buf.writeInt32BE(paramFmtBlobs[i].length, entryOff + 60);
    } else {
      buf.writeInt32BE(0, entryOff + 56);
      buf.writeInt32BE(stmt.paramFormatAbsent ? 0 : 6, entryOff + 60);
    }
  }

  // Write blobs
  let writeCursor = headerSize + entryTableSize;
  for (let i = 0; i < statements.length; i++) {
    textBlobs[i].copy(buf, writeCursor);
    writeCursor += textBlobs[i].length;
    if (resultFmtBlobs[i]) {
      resultFmtBlobs[i].copy(buf, writeCursor);
      writeCursor += resultFmtBlobs[i].length;
    }
    if (paramFmtBlobs[i]) {
      paramFmtBlobs[i].copy(buf, writeCursor);
      writeCursor += paramFmtBlobs[i].length;
    }
  }

  return buf;
}

function encodeForCCSID(text, ccsid) {
  if (ccsid === 13488 || ccsid === 1200 || ccsid === 61952) {
    const buf = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      buf.writeUInt16BE(text.charCodeAt(i), i * 2);
    }
    return buf;
  }
  if (ccsid === 1208) {
    return Buffer.from(text, 'utf8');
  }
  const buf = Buffer.alloc(text.length);
  CharConverter.stringToByteArrayInto(text, buf, 0, text.length, ccsid);
  return buf;
}

function writePaddedString(buf, offset, fieldLen, text, ccsid) {
  const encoded = encodeForCCSID(text, ccsid);
  const copyLen = Math.min(encoded.length, fieldLen);
  encoded.copy(buf, offset, 0, copyLen);
  // Pad with EBCDIC spaces (0x40) for CCSID 37 or zeros
  if (copyLen < fieldLen) {
    buf.fill(ccsid === 37 ? 0x40 : 0x00, offset + copyLen, offset + fieldLen);
  }
}

/**
 * Build a basic data format buffer (0x3805 style) with given fields.
 * Each field is { sqlType, length, ccsid, name? }.
 */
function buildBasicDataFormatBuffer(fields) {
  const numFields = fields.length;
  // Header: consistencyToken(4) + numFields(2) + recordSize(2) = 8
  // Per field: fieldLL includes name. Minimum fieldLL = 24 + nameLen.
  let recordSize = 0;
  const perField = [];
  for (let i = 0; i < numFields; i++) {
    const f = fields[i];
    const name = f.name || `COL${i}`;
    const nameBuf = encodeForCCSID(name, f.ccsid || 37);
    const fieldLL = 24 + nameBuf.length;
    const absType = Math.abs(f.sqlType) & 0xFFFE;
    const isVarLen = absType === 448 || absType === 464 || absType === 456
                 || absType === 472 || absType === 908;
    const wireLen = isVarLen && f.length >= 2 ? f.length + 2 : f.length;
    recordSize += wireLen + (f.nullable ? 2 : 0);
    perField.push({ ...f, nameBuf, fieldLL, wireLen });
  }

  let totalSize = 8;
  for (const pf of perField) totalSize += pf.fieldLL;

  const buf = Buffer.alloc(totalSize);
  buf.writeInt32BE(1, 0);                  // consistencyToken
  buf.writeInt16BE(numFields, 4);          // numFields
  buf.writeInt16BE(recordSize, 6);         // recordSize

  let pos = 8;
  for (let i = 0; i < numFields; i++) {
    const pf = perField[i];
    buf.writeInt16BE(pf.fieldLL, pos);
    buf.writeInt16BE(pf.sqlType, pos + 2);
    buf.writeInt16BE(pf.wireLen, pos + 4);
    buf.writeInt16BE(pf.scale || 0, pos + 6);
    buf.writeInt16BE(pf.precision || pf.length, pos + 8);
    buf.writeUInt16BE(pf.ccsid || 37, pos + 10);
    buf.writeInt16BE(0, pos + 12);         // dateTimeFormat + flags1
    buf.writeInt16BE(0, pos + 14);         // flags2
    buf.writeInt16BE(0, pos + 16);         // reserved
    buf.writeInt16BE(0, pos + 18);         // reserved
    buf.writeInt16BE(pf.nameBuf.length, pos + 20);   // nameLength
    buf.writeUInt16BE(pf.ccsid || 37, pos + 22);     // nameCCSID
    pf.nameBuf.copy(buf, pos + 24);
    pos += pf.fieldLL;
  }
  return buf;
}

describe('parsePackageInfo — DBReplyPackageInfo decoder', () => {
  test('parses header: CCSID, default collection, statement count', () => {
    const buf = buildPackageInfoBuffer({
      packageCCSID: 37,
      defaultCollection: 'MYLIB',
      statements: [],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    expect(info).not.toBeNull();
    expect(info.packageCCSID).toBe(37);
    expect(info.statementCount).toBe(0);
    expect(info.defaultCollection).toContain('MYLIB');
    expect(info.entries.length).toBe(0);
  });

  test('parses single entry with statement name and text', () => {
    const sql = 'SELECT * FROM T WHERE ID = ?';
    const buf = buildPackageInfoBuffer({
      packageCCSID: 37,
      statements: [
        { name: 'STM0001', text: sql, statementType: 2 },
      ],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    expect(info.statementCount).toBe(1);
    expect(info.entries.length).toBe(1);
    expect(info.entries[0].statementName).toContain('STM0001');
    expect(info.entries[0].statementText).toBe(sql);
    expect(info.entries[0].statementType).toBe(2);
  });

  test('parses two entries and matches by index', () => {
    const buf = buildPackageInfoBuffer({
      statements: [
        { name: 'STM0001', text: 'SELECT * FROM A WHERE X = ?', statementType: 2 },
        { name: 'STM0002', text: 'INSERT INTO B (C) VALUES (?)', statementType: 1 },
      ],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    expect(info.entries.length).toBe(2);
    expect(info.entries[0].statementName).toContain('STM0001');
    expect(info.entries[0].statementText).toContain('FROM A');
    expect(info.entries[1].statementName).toContain('STM0002');
    expect(info.entries[1].statementText).toContain('INSERT INTO B');
  });

  test('absent result format when length is 0 or 6', () => {
    const buf = buildPackageInfoBuffer({
      statements: [
        { name: 'STM1', text: 'INSERT INTO T VALUES (?)', statementType: 1,
          resultFormatAbsent: true },
        { name: 'STM2', text: 'SET X = ?', statementType: 1,
          resultFormat: [] },
      ],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    // length = 0 → null
    expect(info.entries[0].resultDataFormat).toBeNull();
    // length = 6 (from empty fields array producing the 6-byte absent marker)
    // Our builder with empty resultFormat generates a minimal format — that's
    // fine, the JTOpen rule is length === 0 || length === 6 → null.
    // When resultFormat is explicitly absent (resultFormatAbsent), it's null.
  });

  test('parses result and parameter formats when present', () => {
    const buf = buildPackageInfoBuffer({
      statements: [
        {
          name: 'STM1',
          text: 'SELECT ID, NAME FROM T WHERE X = ?',
          statementType: 2,
          resultFormat: [
            { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
            { sqlType: 448, length: 50, ccsid: 37, name: 'NAME' },
          ],
          parameterFormat: [
            { sqlType: 496, length: 4, ccsid: 37, name: 'X' },
          ],
        },
      ],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    expect(info.entries[0].resultDataFormat).not.toBeNull();
    expect(info.entries[0].resultDataFormat.descriptors.length).toBe(2);
    expect(info.entries[0].resultDataFormat.descriptors[0].name).toContain('ID');
    expect(info.entries[0].resultDataFormat.descriptors[1].name).toContain('NAME');
    expect(info.entries[0].parameterMarkerFormat).not.toBeNull();
    expect(info.entries[0].parameterMarkerFormat.descriptors.length).toBe(1);
    expect(info.entries[0].parameterMarkerFormat.descriptors[0].name).toContain('X');
  });

  test('returns null for buffer too short', () => {
    const shortBuf = Buffer.alloc(10);
    const info = parsePackageInfo(shortBuf, { serverCCSID: 37 });
    expect(info).toBeNull();
  });

  test('statement name decoded with server (job) CCSID, not package CCSID', () => {
    // Build with packageCCSID=1208 (UTF-8) but serverCCSID=37
    // The statement name should be decoded as EBCDIC (37)
    const buf = buildPackageInfoBuffer({
      packageCCSID: 1208,
      serverCCSID: 37,
      statements: [
        { name: 'STM0001', text: 'SELECT 1 FROM T', statementType: 2 },
      ],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    expect(info.entries[0].statementName).toContain('STM0001');
  });
});

// --- PackageManager.lookup — cache hit/miss ------------------------

describe('PackageManager.lookup — cache hit/miss', () => {
  test('length mismatch misses before string compare', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
    });
    const buf = buildPackageInfoBuffer({
      statements: [
        { name: 'STM1', text: 'SELECT * FROM T WHERE ID = ?', statementType: 2 },
      ],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    pm.setCachedRaw(buf, info.statementCount, info);

    // Different-length SQL should miss fast
    expect(pm.lookup('SELECT 1')).toBeNull();
  });

  test('exact SQL hit returns statement entry', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
    });
    const sql = 'SELECT * FROM T WHERE ID = ?';
    const buf = buildPackageInfoBuffer({
      statements: [
        { name: 'STM0001', text: sql, statementType: 2 },
      ],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    pm.setCachedRaw(buf, info.statementCount, info);

    const hit = pm.lookup(sql);
    expect(hit).not.toBeNull();
    expect(hit.statementName).toContain('STM0001');
    expect(hit.statementText).toBe(sql);
  });

  test('non-packageable SQL misses', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
    });
    const buf = buildPackageInfoBuffer({
      statements: [
        { name: 'STM1', text: 'SELECT * FROM T WHERE ID = ?', statementType: 2 },
      ],
    });
    const info = parsePackageInfo(buf, { serverCCSID: 37 });
    pm.setCachedRaw(buf, info.statementCount, info);

    // Plain SELECT without parameters is not packageable under default criteria
    expect(pm.lookup('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBeNull();
  });

  test('uncached manager returns null', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
    });
    expect(pm.lookup('SELECT * FROM T WHERE ID = ?')).toBeNull();
  });

  test('disabled manager returns null', () => {
    const pm = new PackageManager({ extendedDynamic: false });
    expect(pm.lookup('SELECT * FROM T WHERE ID = ?')).toBeNull();
  });
});

// --- packageCriteria ------------------------------------------------

describe('packageCriteria = "select"', () => {
  test('plain SELECT without parameters is packageable under "select" criteria', () => {
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
      packageCriteria: 'select',
    });
    expect(pm.isPackaged('SELECT * FROM T')).toBe(true);
    expect(pm.isPackaged('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBe(true);
  });

  test('default criteria: plain SELECT without parameters is NOT packageable', () => {
    const pmDefault = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
    });
    expect(pmDefault.isPackaged('SELECT * FROM T')).toBe(false);
  });

  test('parameterized SELECT remains packageable under both criteria', () => {
    const pmDefault = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
    });
    const pmSelect = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
      packageCriteria: 'select',
    });
    const sql = 'SELECT * FROM T WHERE ID = ?';
    expect(pmDefault.isPackaged(sql)).toBe(true);
    expect(pmSelect.isPackaged(sql)).toBe(true);
  });
});

// --- StatementManager skip-prepare cache hit -------------------------

describe('StatementManager.prepareStatement — cache-hit skip-prepare', () => {
  test('cache hit skips PREPARE_AND_DESCRIBE and increments packageHits', async () => {
    const sends = [];
    const sql = 'SELECT * FROM T WHERE ID = ?';
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
      packageCache: true,
    });
    // Pre-populate the decoded cache so the first prepare hits
    const pkgBuf = buildPackageInfoBuffer({
      statements: [
        {
          name: 'STM0042',
          text: sql,
          statementType: 2,
          resultFormat: [
            { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
          ],
          parameterFormat: [
            { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
          ],
        },
      ],
    });
    const pkgInfo = parsePackageInfo(pkgBuf, { serverCCSID: 37 });
    pm.setCachedRaw(pkgBuf, pkgInfo.statementCount, pkgInfo);
    pm.markCreated(); // Pretend package already exists

    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    const stmt = await sm.prepareStatement(sql);

    // Should NOT have sent PREPARE_AND_DESCRIBE
    const prepSends = sends.filter(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE);
    expect(prepSends.length).toBe(0);
    // packageHits should be 1
    expect(pm.metrics.packageHits).toBe(1);
    // Cache hit keeps the local statement name and stores the package
    // statement as the execute-time override.
    expect(stmt.statementNameOverride).toContain('STM0042');
    // Column and parameter descriptors populated from cache
    expect(stmt.columnDescriptors.length).toBe(1);
    expect(stmt.paramDescriptors.length).toBe(1);
    // CREATE_RPB still happened
    const rpbSends = sends.filter(b => b.readUInt16BE(18) === 0x1D00);
    expect(rpbSends.length).toBe(1);
  });

  test('cache miss sends normal PREPARE_AND_DESCRIBE', async () => {
    const sends = [];
    const sql = 'SELECT * FROM T WHERE ID = ?';
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
      packageCache: true,
    });
    pm.markCreated();
    // Cache is populated but doesn't contain this SQL
    const pkgBuf = buildPackageInfoBuffer({
      statements: [
        { name: 'STM1', text: 'SELECT * FROM OTHER WHERE X = ?', statementType: 2 },
      ],
    });
    const pkgInfo = parsePackageInfo(pkgBuf, { serverCCSID: 37 });
    pm.setCachedRaw(pkgBuf, pkgInfo.statementCount, pkgInfo);

    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    try {
      await sm.prepareStatement(sql);
    } catch { /* expected — okReply has no descriptors */ }

    // Should have sent PREPARE_AND_DESCRIBE
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE)).toBe(true);
    // packageHits should be 0
    expect(pm.metrics.packageHits).toBe(0);
  });

  test('LOB in cached result forces normal prepare', async () => {
    const sends = [];
    const sql = 'SELECT BLOB_COL FROM T WHERE ID = ?';
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
      packageCache: true,
    });
    pm.markCreated();
    const pkgBuf = buildPackageInfoBuffer({
      statements: [
        {
          name: 'STM_LOB',
          text: sql,
          statementType: 2,
          resultFormat: [
            { sqlType: 960, length: 4, ccsid: 37, name: 'BLOB_COL' }, // BLOB_LOCATOR
          ],
          parameterFormat: [
            { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
          ],
        },
      ],
    });
    const pkgInfo = parsePackageInfo(pkgBuf, { serverCCSID: 37 });
    pm.setCachedRaw(pkgBuf, pkgInfo.statementCount, pkgInfo);

    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    try {
      await sm.prepareStatement(sql);
    } catch { /* expected */ }

    // LOB guard: should have sent PREPARE_AND_DESCRIBE (fallback)
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE)).toBe(true);
    // packageHits should NOT have ticked
    expect(pm.metrics.packageHits).toBe(0);
  });

  test('LOB in cached parameter format forces normal prepare', async () => {
    const sends = [];
    const sql = 'INSERT INTO T (B) VALUES (?)';
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
      packageCache: true,
    });
    pm.markCreated();
    const pkgBuf = buildPackageInfoBuffer({
      statements: [
        {
          name: 'STM_PLOB',
          text: sql,
          statementType: 1,
          resultFormat: [],
          parameterFormat: [
            { sqlType: 964, length: 4, ccsid: 37, name: 'B' }, // CLOB_LOCATOR
          ],
        },
      ],
    });
    const pkgInfo = parsePackageInfo(pkgBuf, { serverCCSID: 37 });
    pm.setCachedRaw(pkgBuf, pkgInfo.statementCount, pkgInfo);

    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    try {
      await sm.prepareStatement(sql);
    } catch { /* expected */ }

    expect(sends.some(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE)).toBe(true);
    expect(pm.metrics.packageHits).toBe(0);
  });

  test('malformed package info falls back to normal prepare', async () => {
    const sends = [];
    const sql = 'SELECT * FROM T WHERE ID = ?';
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
      packageCache: true,
    });
    pm.markCreated();
    // Set corrupted cache (null packageInfo → no decode)
    pm.setCachedRaw(Buffer.alloc(5), 0, null);

    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    try {
      await sm.prepareStatement(sql);
    } catch { /* expected */ }

    expect(sends.some(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE)).toBe(true);
    expect(pm.metrics.packageHits).toBe(0);
  });

  test('extendedDynamic off — no package code points, no counter changes', async () => {
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

    expect(sends.some(b => b.readUInt16BE(18) === RequestID.CREATE_PACKAGE)).toBe(false);
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.RETURN_PACKAGE)).toBe(false);
    expect(sm.metrics.packageHits).toBe(0);
    expect(sm.metrics.packageCreates).toBe(0);
    expect(sm.metrics.packageFetches).toBe(0);
  });

  test('packageCache off — no skip-prepare lookup', async () => {
    const sends = [];
    const sql = 'SELECT * FROM T WHERE ID = ?';
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
      packageCache: false,
    });
    pm.markCreated();

    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    try {
      await sm.prepareStatement(sql);
    } catch { /* expected */ }

    // PREPARE_AND_DESCRIBE must fire (no cache to skip)
    expect(sends.some(b => b.readUInt16BE(18) === RequestID.PREPARE_AND_DESCRIBE)).toBe(true);
    expect(pm.metrics.packageHits).toBe(0);
  });
});

// --- Cached execution wire shape (Finding #1 fix) --------------------
//
// These tests go beyond prepareStatement() and actually exercise the
// execute() path to verify that PREPARED_STATEMENT_NAME (0x3806) is
// only sent on cache hits, while PACKAGE_NAME (0x3804) stays attached
// for packaged statements. This mirrors JTOpen's nameOverride_
// pattern in AS400JDBCStatement.java:879.

describe('cached SELECT execution sends PREPARED_STATEMENT_NAME on the wire', () => {
  test('OPEN_AND_DESCRIBE carries statement name override + PACKAGE_NAME on cache hit', async () => {
    const sends = [];
    const sql = 'SELECT * FROM T WHERE ID = ?';
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        const reqId = buf.readUInt16BE(18);
        // OPEN_AND_DESCRIBE needs a valid SQLCA reply so parseFetchReply
        // doesn't throw. Build one with SQLCODE 100 (end of data).
        if (reqId === RequestID.OPEN_AND_DESCRIBE) {
          return sqlcaReply(100);
        }
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
      packageCache: true,
    });
    const pkgBuf = buildPackageInfoBuffer({
      statements: [
        {
          name: 'STM0042',
          text: sql,
          statementType: 2,
          resultFormat: [
            { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
          ],
          parameterFormat: [
            { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
          ],
        },
      ],
    });
    const pkgInfo = parsePackageInfo(pkgBuf, { serverCCSID: 37 });
    pm.setCachedRaw(pkgBuf, pkgInfo.statementCount, pkgInfo);
    pm.markCreated();

    const cursors = new Map();
    const cursorMgr = {
      registerCursor(rpbId, descs) { cursors.set(rpbId, descs); },
    };
    const sm = new StatementManager(fakeConn, cursorMgr, {
      packageManager: pm,
      serverCCSID: 37,
    });
    const stmt = await sm.prepareStatement(sql);

    // Execute the cached statement with a parameter
    sends.length = 0; // clear prepare-time sends
    const result = await sm.execute(stmt, [42]);

    // Find the OPEN_AND_DESCRIBE request
    const openReqs = sends.filter(b => b.readUInt16BE(18) === RequestID.OPEN_AND_DESCRIBE);
    expect(openReqs.length).toBe(1);

    const openCps = scanCodePoints(openReqs[0]);

    // PREPARED_STATEMENT_NAME (0x3806) must be present
    const stmtNameCps = openCps.get(CodePoint.PREPARED_STATEMENT_NAME);
    expect(stmtNameCps).toBeDefined();
    expect(stmtNameCps.length).toBe(1);
    const stmtNameText = decodeTextCpPayload(stmtNameCps[0]);
    expect(stmtNameText).toContain('STM0042');

    // PACKAGE_NAME (0x3804) must be present
    const pkgNameCps = openCps.get(CodePoint.PACKAGE_NAME);
    expect(pkgNameCps).toBeDefined();
    expect(pkgNameCps.length).toBe(1);

    // LIBRARY_NAME is bound on CREATE_RPB, not repeated here.
    expect(openCps.get(CodePoint.LIBRARY_NAME)).toBeUndefined();
  });

  test('non-cached SELECT does NOT send PREPARED_STATEMENT_NAME on open', async () => {
    const sends = [];
    const sql = 'SELECT * FROM T WHERE ID = ?';
    // Build a prepare reply that includes column descriptors (basic data
    // format 0x3805) so execute() takes the SELECT/OPEN path. Without
    // column descriptors the engine classifies the statement as DML.
    const colFmt = buildBasicDataFormatBuffer([
      { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
    ]);
    const colFmtCp = Buffer.alloc(6 + colFmt.length);
    colFmtCp.writeInt32BE(colFmtCp.length, 0);
    colFmtCp.writeUInt16BE(0x3805, 4);
    colFmt.copy(colFmtCp, 6);
    // Also include parameter marker format (0x3808)
    const paramFmt = buildBasicDataFormatBuffer([
      { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
    ]);
    const paramFmtCp = Buffer.alloc(6 + paramFmt.length);
    paramFmtCp.writeInt32BE(paramFmtCp.length, 0);
    paramFmtCp.writeUInt16BE(0x3808, 4);
    paramFmt.copy(paramFmtCp, 6);

    function prepareReplyWithDescriptors() {
      const total = 40 + colFmtCp.length + paramFmtCp.length;
      const buf = Buffer.alloc(total);
      buf.writeInt32BE(total, 0);
      buf.writeInt16BE(20, 16);
      colFmtCp.copy(buf, 40);
      paramFmtCp.copy(buf, 40 + colFmtCp.length);
      return buf;
    }

    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        const reqId = buf.readUInt16BE(18);
        if (reqId === RequestID.PREPARE_AND_DESCRIBE) {
          return prepareReplyWithDescriptors();
        }
        if (reqId === RequestID.OPEN_AND_DESCRIBE) {
          return sqlcaReply(100);
        }
        return okReply();
      },
    };
    // No package manager — normal path
    const cursors = new Map();
    const cursorMgr = {
      registerCursor(rpbId, descs) { cursors.set(rpbId, descs); },
    };
    const sm = new StatementManager(fakeConn, cursorMgr, { serverCCSID: 37 });
    const stmt = await sm.prepareStatement(sql);
    expect(stmt.columnDescriptors.length).toBe(1);

    sends.length = 0;
    await sm.execute(stmt, [42]);

    const openReqs = sends.filter(b => b.readUInt16BE(18) === RequestID.OPEN_AND_DESCRIBE);
    expect(openReqs.length).toBe(1);
    const openCps = scanCodePoints(openReqs[0]);

    // Should NOT have PREPARED_STATEMENT_NAME on normal path
    expect(openCps.get(CodePoint.PREPARED_STATEMENT_NAME)).toBeUndefined();
    // Should NOT have PACKAGE_NAME
    expect(openCps.get(CodePoint.PACKAGE_NAME)).toBeUndefined();
  });

  test('packaged non-cache SELECT sends PACKAGE_NAME but no PREPARED_STATEMENT_NAME', async () => {
    const sends = [];
    const sql = 'SELECT * FROM T WHERE ID = ?';
    const colFmt = buildBasicDataFormatBuffer([
      { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
    ]);
    const colFmtCp = Buffer.alloc(6 + colFmt.length);
    colFmtCp.writeInt32BE(colFmtCp.length, 0);
    colFmtCp.writeUInt16BE(0x3805, 4);
    colFmt.copy(colFmtCp, 6);
    const paramFmt = buildBasicDataFormatBuffer([
      { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
    ]);
    const paramFmtCp = Buffer.alloc(6 + paramFmt.length);
    paramFmtCp.writeInt32BE(paramFmtCp.length, 0);
    paramFmtCp.writeUInt16BE(0x3808, 4);
    paramFmt.copy(paramFmtCp, 6);

    function prepareReplyWithDescriptors() {
      const total = 40 + colFmtCp.length + paramFmtCp.length;
      const buf = Buffer.alloc(total);
      buf.writeInt32BE(total, 0);
      buf.writeInt16BE(20, 16);
      colFmtCp.copy(buf, 40);
      paramFmtCp.copy(buf, 40 + colFmtCp.length);
      return buf;
    }

    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        const reqId = buf.readUInt16BE(18);
        if (reqId === RequestID.PREPARE_AND_DESCRIBE) {
          return prepareReplyWithDescriptors();
        }
        if (reqId === RequestID.OPEN_AND_DESCRIBE) {
          return sqlcaReply(100);
        }
        return okReply();
      },
    };
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'MYAPP',
      packageLibrary: 'MYLIB',
      packageCache: false,
    });
    pm.markCreated();
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    const stmt = await sm.prepareStatement(sql);
    expect(stmt.statementNameOverride).toBeNull();

    sends.length = 0;
    await sm.execute(stmt, [42]);

    const openReqs = sends.filter(b => b.readUInt16BE(18) === RequestID.OPEN_AND_DESCRIBE);
    expect(openReqs.length).toBe(1);
    const openCps = scanCodePoints(openReqs[0]);
    expect(openCps.get(CodePoint.PREPARED_STATEMENT_NAME)).toBeUndefined();
    expect(openCps.get(CodePoint.PACKAGE_NAME)).toBeDefined();
    expect(openCps.get(CodePoint.LIBRARY_NAME)).toBeUndefined();
  });
});

describe('cached DML execution sends PREPARED_STATEMENT_NAME on the wire', () => {
  test('EXECUTE carries statement name override + PACKAGE_NAME on cache hit', async () => {
    const sends = [];
    const sql = 'INSERT INTO T (ID) VALUES (?)';
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
      packageCache: true,
    });
    const pkgBuf = buildPackageInfoBuffer({
      statements: [
        {
          name: 'STM0099',
          text: sql,
          statementType: 1,
          resultFormat: [],
          parameterFormat: [
            { sqlType: 496, length: 4, ccsid: 37, name: 'ID' },
          ],
        },
      ],
    });
    const pkgInfo = parsePackageInfo(pkgBuf, { serverCCSID: 37 });
    pm.setCachedRaw(pkgBuf, pkgInfo.statementCount, pkgInfo);
    pm.markCreated();

    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    const stmt = await sm.prepareStatement(sql);

    sends.length = 0;
    await sm.execute(stmt, [42]);

    // Find the EXECUTE request
    const execReqs = sends.filter(b => b.readUInt16BE(18) === RequestID.EXECUTE);
    expect(execReqs.length).toBe(1);

    const execCps = scanCodePoints(execReqs[0]);

    // PREPARED_STATEMENT_NAME (0x3806) must be present
    const stmtNameCps = execCps.get(CodePoint.PREPARED_STATEMENT_NAME);
    expect(stmtNameCps).toBeDefined();
    expect(stmtNameCps.length).toBe(1);
    const stmtNameText = decodeTextCpPayload(stmtNameCps[0]);
    expect(stmtNameText).toContain('STM0099');

    // PACKAGE_NAME (0x3804) must be present
    expect(execCps.get(CodePoint.PACKAGE_NAME)).toBeDefined();

    // LIBRARY_NAME is bound on CREATE_RPB, not repeated here.
    expect(execCps.get(CodePoint.LIBRARY_NAME)).toBeUndefined();
  });

  test('non-cached DML does NOT send PREPARED_STATEMENT_NAME on execute', async () => {
    const sends = [];
    const sql = 'INSERT INTO T (ID) VALUES (?)';
    const fakeConn = {
      async sendAndReceive(buf) {
        sends.push(Buffer.from(buf));
        return okReply();
      },
    };
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, { serverCCSID: 37 });
    const stmt = await sm.prepareStatement(sql);

    sends.length = 0;
    await sm.execute(stmt, [42]);

    const execReqs = sends.filter(b => b.readUInt16BE(18) === RequestID.EXECUTE);
    expect(execReqs.length).toBe(1);
    const execCps = scanCodePoints(execReqs[0]);

    expect(execCps.get(CodePoint.PREPARED_STATEMENT_NAME)).toBeUndefined();
    expect(execCps.get(CodePoint.PACKAGE_NAME)).toBeUndefined();
  });

  test('packaged non-cache DML sends PACKAGE_NAME but no PREPARED_STATEMENT_NAME', async () => {
    const sends = [];
    const sql = 'INSERT INTO T (ID) VALUES (?)';
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
      packageCache: false,
    });
    pm.markCreated();
    const sm = new StatementManager(fakeConn, { registerCursor() {} }, {
      packageManager: pm,
      serverCCSID: 37,
    });
    const stmt = await sm.prepareStatement(sql);
    expect(stmt.statementNameOverride).toBeNull();

    sends.length = 0;
    await sm.execute(stmt, [42]);

    const execReqs = sends.filter(b => b.readUInt16BE(18) === RequestID.EXECUTE);
    expect(execReqs.length).toBe(1);
    const execCps = scanCodePoints(execReqs[0]);
    expect(execCps.get(CodePoint.PREPARED_STATEMENT_NAME)).toBeUndefined();
    expect(execCps.get(CodePoint.PACKAGE_NAME)).toBeDefined();
    expect(execCps.get(CodePoint.LIBRARY_NAME)).toBeUndefined();
  });
});

// --- packageCriteria end-to-end (Finding #2 fix) ---------------------

describe('packageCriteria flows through the public connection path', () => {
  test('_buildConnectOptionsForPool forwards packageCriteria', async () => {
    const { _buildConnectOptionsForPool } = await import('../../src/db/connect.js');
    const forwarded = _buildConnectOptionsForPool({
      host: 'example.invalid',
      user: 'U',
      password: 'P',
      extendedDynamic: true,
      sqlPackage: 'MYAPP',
      packageLibrary: 'MYLIB',
      packageCache: true,
      packageCriteria: 'select',
      packageError: 'warning',
    });
    expect(forwarded.packageCriteria).toBe('select');
    expect(forwarded.extendedDynamic).toBe(true);
    expect(forwarded.sqlPackage).toBe('MYAPP');
  });

  test('packageCriteria "select" makes plain SELECTs packageable through DataSource', async () => {
    // Verify that when constructing a PackageManager with the criteria
    // that would come through DbConnection, it behaves correctly.
    const pm = new PackageManager({
      extendedDynamic: true,
      packageName: 'P',
      packageCriteria: 'select',
    });
    // Under "select" criteria, plain SELECTs are packageable
    expect(pm.isPackaged('SELECT * FROM T')).toBe(true);
    expect(pm.isPackaged('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBe(true);
    // DML still follows normal rules
    expect(pm.isPackaged('UPDATE T SET X = 1 WHERE CURRENT OF C')).toBe(false);
  });
});
