/**
 * Tests for IFS file and stream classes (offline / constructor tests).
 */

import { describe, it, expect } from 'bun:test';
import { IFSFile } from '../../src/ifs/IFSFile.js';
import { IFSFileInputStream } from '../../src/ifs/IFSFileInputStream.js';
import { IFSFileOutputStream } from '../../src/ifs/IFSFileOutputStream.js';
import { IFSTextFileInputStream } from '../../src/ifs/IFSTextFileInputStream.js';
import { IFSTextFileOutputStream } from '../../src/ifs/IFSTextFileOutputStream.js';
import { IFSRandomAccessFile } from '../../src/ifs/IFSRandomAccessFile.js';

// We use a fake system object for constructor tests (no real connection needed)
const fakeSystem = {
  host: 'test.example.com',
  user: 'TESTUSER',
  password: 'TESTPASS',
};

describe('IFSFile - path helpers', () => {

  it('getName returns the last component', () => {
    const f = new IFSFile(fakeSystem, '/home/myuser/test.txt');
    expect(f.getName()).toBe('test.txt');
  });

  it('getName returns empty for root', () => {
    const f = new IFSFile(fakeSystem, '/');
    expect(f.getName()).toBe('');
  });

  it('getParent returns parent directory', () => {
    const f = new IFSFile(fakeSystem, '/home/myuser/test.txt');
    expect(f.getParent()).toBe('/home/myuser');
  });

  it('getParent returns "/" for top-level', () => {
    const f = new IFSFile(fakeSystem, '/test.txt');
    expect(f.getParent()).toBe('/');
  });

  it('getPath returns the full path', () => {
    const f = new IFSFile(fakeSystem, '/home/myuser/test.txt');
    expect(f.getPath()).toBe('/home/myuser/test.txt');
  });

  it('system getter returns the system', () => {
    const f = new IFSFile(fakeSystem, '/test');
    expect(f.system).toBe(fakeSystem);
  });
});

describe('IFSFileInputStream - constructor', () => {

  it('creates an instance with path', () => {
    const s = new IFSFileInputStream(fakeSystem, '/tmp/test.bin');
    expect(s.path).toBe('/tmp/test.bin');
    expect(s.position).toBe(0);
  });
});

describe('IFSFileOutputStream - constructor', () => {

  it('creates an instance with path', () => {
    const s = new IFSFileOutputStream(fakeSystem, '/tmp/out.bin');
    expect(s.path).toBe('/tmp/out.bin');
    expect(s.position).toBe(0);
  });
});

describe('IFSTextFileInputStream - constructor', () => {

  it('creates an instance with ccsid', () => {
    const s = new IFSTextFileInputStream(fakeSystem, '/tmp/test.txt', { ccsid: 37 });
    expect(s.path).toBe('/tmp/test.txt');
    expect(s.ccsid).toBe(37);
  });

  it('defaults to CCSID 37', () => {
    const s = new IFSTextFileInputStream(fakeSystem, '/tmp/test.txt');
    expect(s.ccsid).toBe(37);
  });
});

describe('IFSTextFileOutputStream - constructor', () => {

  it('creates an instance with ccsid', () => {
    const s = new IFSTextFileOutputStream(fakeSystem, '/tmp/out.txt', { ccsid: 819 });
    expect(s.path).toBe('/tmp/out.txt');
    expect(s.ccsid).toBe(819);
  });

  it('defaults to CCSID 37', () => {
    const s = new IFSTextFileOutputStream(fakeSystem, '/tmp/out.txt');
    expect(s.ccsid).toBe(37);
  });
});

describe('IFSRandomAccessFile - constructor', () => {

  it('creates an instance with default rw mode', () => {
    const f = new IFSRandomAccessFile(fakeSystem, '/tmp/rand.bin');
    expect(f.path).toBe('/tmp/rand.bin');
    expect(f.position).toBe(0);
    expect(f.fileSize).toBe(0);
  });

  it('seek updates position', () => {
    const f = new IFSRandomAccessFile(fakeSystem, '/tmp/rand.bin');
    f.seek(1024);
    expect(f.position).toBe(1024);
    expect(f.getFilePointer()).toBe(1024);
  });
});

describe('IFSFileInputStream - skip and seek', () => {

  it('skip advances position', () => {
    const s = new IFSFileInputStream(fakeSystem, '/tmp/test.bin');
    s.skip(100);
    expect(s.position).toBe(100);
    s.skip(50);
    expect(s.position).toBe(150);
  });

  it('seek sets absolute position', () => {
    const s = new IFSFileInputStream(fakeSystem, '/tmp/test.bin');
    s.seek(500);
    expect(s.position).toBe(500);
  });
});
