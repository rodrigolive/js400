/**
 * Tests for IFS module exports.
 */

import { describe, it, expect } from 'bun:test';

describe('IFS module exports', () => {

  it('exports all classes from ifs/index.js', async () => {
    const mod = await import('../../src/ifs/index.js');
    expect(mod.QSYSObjectPathName).toBeDefined();
    expect(mod.IFSFile).toBeDefined();
    expect(mod.IFSFileInputStream).toBeDefined();
    expect(mod.IFSFileOutputStream).toBeDefined();
    expect(mod.IFSTextFileInputStream).toBeDefined();
    expect(mod.IFSTextFileOutputStream).toBeDefined();
    expect(mod.IFSRandomAccessFile).toBeDefined();
  });

  it('exports IFS classes from main index.js', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.IFSFile).toBeDefined();
    expect(mod.IFSFileInputStream).toBeDefined();
    expect(mod.IFSFileOutputStream).toBeDefined();
    expect(mod.IFSTextFileInputStream).toBeDefined();
    expect(mod.IFSTextFileOutputStream).toBeDefined();
    expect(mod.IFSRandomAccessFile).toBeDefined();
    expect(mod.QSYSObjectPathName).toBeDefined();
  });

  it('exports protocol request constants from IFSReq', async () => {
    const mod = await import('../../src/ifs/protocol/IFSReq.js');
    expect(mod.REQ_OPEN).toBe(0x0002);
    expect(mod.REQ_CLOSE).toBe(0x0009);
    expect(mod.REQ_READ).toBe(0x0003);
    expect(mod.REQ_WRITE).toBe(0x0004);
    expect(mod.REQ_LIST_ATTRS).toBe(0x000A);
    expect(mod.REQ_DELETE_FILE).toBe(0x000C);
    expect(mod.REQ_CREATE_DIR).toBe(0x000D);
    expect(mod.ACCESS_READ).toBe(0x0001);
    expect(mod.ACCESS_WRITE).toBe(0x0002);
    expect(mod.CP_FILE_NAME).toBe(0x0002);
    expect(mod.CP_FILE_DATA).toBe(0x0020);
  });

  it('exports protocol reply constants from IFSRep', async () => {
    const mod = await import('../../src/ifs/protocol/IFSRep.js');
    expect(mod.REP_OPEN).toBe(0x8002);
    expect(mod.REP_READ).toBe(0x8003);
    expect(mod.RC_SUCCESS).toBe(0);
    expect(mod.RC_FILE_NOT_FOUND).toBe(2);
    expect(mod.RC_ACCESS_DENIED).toBe(5);
    expect(mod.RC_NO_MORE_FILES).toBe(18);
  });

  it('AS400 has ifs() method', async () => {
    const mod = await import('../../src/core/AS400.js');
    const sys = new mod.AS400('test', 'user', 'pass');
    expect(typeof sys.ifs).toBe('function');
    const fs = sys.ifs();
    expect(typeof fs.readFile).toBe('function');
    expect(typeof fs.writeFile).toBe('function');
    expect(typeof fs.stat).toBe('function');
    expect(typeof fs.readdir).toBe('function');
    expect(typeof fs.mkdir).toBe('function');
    expect(typeof fs.unlink).toBe('function');
    expect(typeof fs.rename).toBe('function');
    expect(typeof fs.copyFile).toBe('function');
    expect(typeof fs.readTextFile).toBe('function');
    expect(typeof fs.writeTextFile).toBe('function');
    expect(typeof fs.mkdirs).toBe('function');
    expect(typeof fs.readdirDetail).toBe('function');
  });
});
