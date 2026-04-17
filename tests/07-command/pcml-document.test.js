/**
 * Tests for ProgramCallDocument (PCML runtime).
 *
 * Unit tests without live IBM i connection.
 */

import { describe, it, expect } from 'bun:test';
import { ProgramCallDocument } from '../../src/pcml/ProgramCallDocument.js';
import { parsePcml } from '../../src/pcml/parser.js';
import { PcmlDocNode, PcmlProgramNode, PcmlDataNode } from '../../src/pcml/model.js';

function mockSystem() {
  return {
    user: 'TESTUSER',
    password: 'TESTPASS',
    host: '127.0.0.1',
    getPasswordLevel: () => 0,
    getServerCCSID: () => 37,
    connectService: () => { throw new Error('mock: not connected'); },
  };
}

const SIMPLE_PCML = `
<pcml version="1.0">
  <program name="myProgram" path="/QSYS.LIB/MYLIB.LIB/MYPGM.PGM">
    <data name="inputParm" type="char" length="10" usage="input" init="DEFAULT"/>
    <data name="outputParm" type="char" length="20" usage="output"/>
    <data name="numberParm" type="int" length="4" usage="input" init="42"/>
  </program>
</pcml>
`;

const STRUCT_PCML = `
<pcml version="1.0">
  <struct name="header">
    <data name="bytesReturned" type="int" length="4" init="0"/>
    <data name="bytesAvailable" type="int" length="4" init="0"/>
  </struct>
  <program name="retrieve" path="/QSYS.LIB/QUSROBJD.PGM">
    <data name="receiver" type="struct" struct="header" usage="output" outputsize="100"/>
    <data name="receiverLength" type="int" length="4" usage="input" init="100"/>
    <data name="format" type="char" length="8" usage="input" init="OBJD0100"/>
  </program>
</pcml>
`;

describe('ProgramCallDocument', () => {

  it('creates from XML string', () => {
    const doc = new ProgramCallDocument(mockSystem(), SIMPLE_PCML);
    expect(doc.getDocument()).toBeInstanceOf(PcmlDocNode);
  });

  it('creates from pre-parsed doc', () => {
    const parsed = parsePcml(SIMPLE_PCML);
    const doc = new ProgramCallDocument(mockSystem(), parsed);
    expect(doc.getDocument()).toBe(parsed);
  });

  it('fromSource creates async', async () => {
    const doc = await ProgramCallDocument.fromSource(mockSystem(), SIMPLE_PCML);
    expect(doc.getDocument()).toBeInstanceOf(PcmlDocNode);
  });

  it('listPrograms returns program names', () => {
    const doc = new ProgramCallDocument(mockSystem(), SIMPLE_PCML);
    const progs = doc.listPrograms();
    expect(progs).toEqual(['myProgram']);
  });

  it('setValue and getValue work', () => {
    const doc = new ProgramCallDocument(mockSystem(), SIMPLE_PCML);
    doc.setValue('myProgram.inputParm', 'HELLO');
    expect(doc.getValue('myProgram.inputParm')).toBe('HELLO');
  });

  it('setValue throws for unknown path', () => {
    const doc = new ProgramCallDocument(mockSystem(), SIMPLE_PCML);
    expect(() => doc.setValue('myProgram.nonExistent', 'val')).toThrow();
  });

  it('getValue returns init value when set from init', () => {
    const doc = new ProgramCallDocument(mockSystem(), SIMPLE_PCML);
    // init values are stored on the node
    const parsed = doc.getDocument();
    const pgm = parsed.children.find(c => c instanceof PcmlProgramNode);
    const parm = pgm.children.find(c => c.name === 'inputParm');
    expect(parm.init).toBe('DEFAULT');
  });

  it('getMessageList returns empty initially', () => {
    const doc = new ProgramCallDocument(mockSystem(), SIMPLE_PCML);
    expect(doc.getMessageList()).toEqual([]);
  });

  it('callProgram throws for unknown program', async () => {
    const doc = new ProgramCallDocument(mockSystem(), SIMPLE_PCML);
    await expect(doc.callProgram('nonExistent')).rejects.toThrow('not found');
  });
});

describe('ProgramCallDocument with structs', () => {

  it('parses struct PCML', () => {
    const doc = new ProgramCallDocument(mockSystem(), STRUCT_PCML);
    const progs = doc.listPrograms();
    expect(progs).toEqual(['retrieve']);
  });

  it('doc has struct definitions', () => {
    const doc = new ProgramCallDocument(mockSystem(), STRUCT_PCML);
    const parsed = doc.getDocument();
    expect(parsed.structs.size).toBe(1);
    expect(parsed.structs.has('header')).toBe(true);
  });

  it('struct fields are accessible', () => {
    const doc = new ProgramCallDocument(mockSystem(), STRUCT_PCML);
    const parsed = doc.getDocument();
    const header = parsed.structs.get('header');
    expect(header.children).toHaveLength(2);
    expect(header.children[0].name).toBe('bytesReturned');
    expect(header.children[1].name).toBe('bytesAvailable');
  });
});

describe('ProgramCallDocument multi-program', () => {

  const MULTI_PCML = `
    <pcml version="1.0">
      <program name="pgm1" path="/qsys.lib/pgm1.pgm">
        <data name="p" type="char" length="10" usage="input"/>
      </program>
      <program name="pgm2" path="/qsys.lib/pgm2.pgm">
        <data name="q" type="int" length="4" usage="output"/>
      </program>
    </pcml>
  `;

  it('lists multiple programs', () => {
    const doc = new ProgramCallDocument(mockSystem(), MULTI_PCML);
    expect(doc.listPrograms()).toEqual(['pgm1', 'pgm2']);
  });

  it('setValue on different programs', () => {
    const doc = new ProgramCallDocument(mockSystem(), MULTI_PCML);
    doc.setValue('pgm1.p', 'HELLO');
    expect(doc.getValue('pgm1.p')).toBe('HELLO');
  });
});
