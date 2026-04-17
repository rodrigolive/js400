/**
 * Tests for QSYSObjectPathName - QSYS IFS path parsing and building.
 */

import { describe, it, expect } from 'bun:test';
import { QSYSObjectPathName } from '../../src/ifs/QSYSObjectPathName.js';

describe('QSYSObjectPathName - construct from components', () => {

  it('builds path from library, object, type', () => {
    const p = new QSYSObjectPathName('QGPL', 'ACCOUNTS', 'FILE');
    expect(p.getPath()).toBe('/QSYS.LIB/QGPL.LIB/ACCOUNTS.FILE');
    expect(p.library).toBe('QGPL');
    expect(p.object).toBe('ACCOUNTS');
    expect(p.objectType).toBe('FILE');
    expect(p.member).toBe('');
  });

  it('builds member path from library, object, member, MBR', () => {
    const p = new QSYSObjectPathName('QGPL', 'ACCOUNTS', 'PAYABLE', 'MBR');
    expect(p.getPath()).toBe('/QSYS.LIB/QGPL.LIB/ACCOUNTS.FILE/PAYABLE.MBR');
    expect(p.library).toBe('QGPL');
    expect(p.object).toBe('ACCOUNTS');
    expect(p.member).toBe('PAYABLE');
    expect(p.objectType).toBe('MBR');
  });

  it('builds path with ASP prefix', () => {
    const p = new QSYSObjectPathName('IASP1', 'MYLIB', 'MYOBJ', 'MYMBR', 'MBR');
    expect(p.getPath()).toBe('/IASP1/QSYS.LIB/MYLIB.LIB/MYOBJ.FILE/MYMBR.MBR');
    expect(p.aspName).toBe('IASP1');
  });

  it('uppercases names', () => {
    const p = new QSYSObjectPathName('qgpl', 'accounts', 'file');
    expect(p.library).toBe('QGPL');
    expect(p.object).toBe('ACCOUNTS');
    expect(p.objectType).toBe('FILE');
  });

  it('throws for memberName with non-MBR type', () => {
    expect(() => new QSYSObjectPathName('QGPL', 'OBJ', 'MBR1', 'FILE'))
      .toThrow();
  });

  it('throws for empty names', () => {
    expect(() => new QSYSObjectPathName('', 'OBJ', 'FILE')).toThrow();
    expect(() => new QSYSObjectPathName('LIB', '', 'FILE')).toThrow();
  });

  it('throws for names exceeding max length', () => {
    expect(() => new QSYSObjectPathName('TOOLONGNAME1', 'OBJ', 'FILE')).toThrow();
    expect(() => new QSYSObjectPathName('LIB', 'TOOLONGNAME1', 'FILE')).toThrow();
  });
});

describe('QSYSObjectPathName - parse from path string', () => {

  it('parses library/object/type', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB/QGPL.LIB/CRTLIB.CMD');
    expect(p.library).toBe('QGPL');
    expect(p.object).toBe('CRTLIB');
    expect(p.objectType).toBe('CMD');
    expect(p.member).toBe('');
  });

  it('parses library/file/member', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB/QGPL.LIB/ACCOUNTS.FILE/PAYABLE.MBR');
    expect(p.library).toBe('QGPL');
    expect(p.object).toBe('ACCOUNTS');
    expect(p.member).toBe('PAYABLE');
    expect(p.objectType).toBe('MBR');
  });

  it('parses object in QSYS (no library qualifier)', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB/CRTLIB.CMD');
    expect(p.library).toBe('QSYS');
    expect(p.object).toBe('CRTLIB');
    expect(p.objectType).toBe('CMD');
  });

  it('parses bare /QSYS.LIB', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB');
    expect(p.library).toBe('QSYS');
    expect(p.objectType).toBe('LIB');
    expect(p.object).toBe('');
  });

  it('parses path with IASP prefix', () => {
    const p = new QSYSObjectPathName('/IASP1/QSYS.LIB/MYLIB.LIB/MYOBJ.PGM');
    expect(p.aspName).toBe('IASP1');
    expect(p.library).toBe('MYLIB');
    expect(p.object).toBe('MYOBJ');
    expect(p.objectType).toBe('PGM');
  });

  it('parses special library %LIBL% -> *LIBL', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB/%LIBL%.LIB/MYOBJ.PGM');
    expect(p.library).toBe('*LIBL');
  });

  it('parses special library %CURLIB% -> *CURLIB', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB/%CURLIB%.LIB/MYOBJ.PGM');
    expect(p.library).toBe('*CURLIB');
  });

  it('parses special member %FIRST% -> *FIRST', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB/QGPL.LIB/MYFILE.FILE/%FIRST%.MBR');
    expect(p.member).toBe('*FIRST');
  });

  it('parses special object %ALL% -> *ALL', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB/QGPL.LIB/%ALL%.PGM');
    expect(p.object).toBe('*ALL');
  });

  it('preserves case inside quotes', () => {
    const p = new QSYSObjectPathName('/QSYS.LIB/QGPL.LIB/"MixedCase".PGM');
    expect(p.object).toBe('MixedCase');
  });

  it('throws for missing /QSYS.LIB prefix', () => {
    expect(() => new QSYSObjectPathName('/home/user/file.txt')).toThrow();
  });

  it('throws for empty string', () => {
    expect(() => new QSYSObjectPathName('')).toThrow();
  });

  it('roundtrips parsed path', () => {
    const original = '/QSYS.LIB/QGPL.LIB/ACCOUNTS.FILE/PAYABLE.MBR';
    const p = new QSYSObjectPathName(original);
    expect(p.getPath()).toBe(original);
  });
});

describe('QSYSObjectPathName - static methods', () => {

  it('parse() returns components', () => {
    const result = QSYSObjectPathName.parse('/QSYS.LIB/QGPL.LIB/MYOBJ.PGM');
    expect(result.library).toBe('QGPL');
    expect(result.object).toBe('MYOBJ');
    expect(result.objectType).toBe('PGM');
    expect(result.member).toBe('');
    expect(result.aspName).toBe('');
  });

  it('toPath() builds path', () => {
    const path = QSYSObjectPathName.toPath('QGPL', 'MYOBJ', 'PGM');
    expect(path).toBe('/QSYS.LIB/QGPL.LIB/MYOBJ.PGM');
  });

  it('toMemberPath() builds member path', () => {
    const path = QSYSObjectPathName.toMemberPath('QGPL', 'MYFILE', 'MYMEMBER');
    expect(path).toBe('/QSYS.LIB/QGPL.LIB/MYFILE.FILE/MYMEMBER.MBR');
  });

  it('toString() returns path', () => {
    const p = new QSYSObjectPathName('QGPL', 'OBJ', 'PGM');
    expect(String(p)).toBe('/QSYS.LIB/QGPL.LIB/OBJ.PGM');
  });
});

describe('QSYSObjectPathName - default constructor', () => {

  it('creates empty instance', () => {
    const p = new QSYSObjectPathName();
    expect(p.getPath()).toBe('');
    expect(p.library).toBe('');
    expect(p.object).toBe('');
    expect(p.member).toBe('');
    expect(p.objectType).toBe('');
    expect(p.aspName).toBe('');
  });
});
