/**
 * Tests for PCML XML parsing and document model.
 */

import { describe, it, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXml } from '../../src/pcml/xml.js';
import { parsePcml } from '../../src/pcml/parser.js';
import { resolvePcmlType } from '../../src/pcml/types.js';
import { createPcmlCacheEntry } from '../../src/pcml/cache.js';
import {
  PcmlDocNode,
  PcmlProgramNode,
  PcmlStructNode,
  PcmlDataNode,
} from '../../src/pcml/model.js';
import { pcmlResources, loadPcmlResource } from '../../src/pcml/resources/index.js';

// ── XML tokenizer tests ──────────────────────────────────────────

describe('parseXml', () => {

  it('parses a simple element', () => {
    const root = parseXml('<root attr="val"/>');
    expect(root.tag).toBe('root');
    expect(root.attrs.attr).toBe('val');
    expect(root.children).toHaveLength(0);
  });

  it('parses nested elements', () => {
    const root = parseXml('<parent><child name="a"/><child name="b"/></parent>');
    expect(root.tag).toBe('parent');
    expect(root.children).toHaveLength(2);
    expect(root.children[0].attrs.name).toBe('a');
    expect(root.children[1].attrs.name).toBe('b');
  });

  it('handles comments', () => {
    const root = parseXml('<!-- comment --><root><!-- inner --><child/></root>');
    expect(root.tag).toBe('root');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].tag).toBe('child');
  });

  it('handles XML declaration', () => {
    const root = parseXml('<?xml version="1.0"?><root/>');
    expect(root.tag).toBe('root');
  });

  it('decodes entities', () => {
    const root = parseXml('<root val="a&amp;b&lt;c"/>');
    expect(root.attrs.val).toBe('a&b<c');
  });

  it('handles text content', () => {
    const root = parseXml('<root>hello world</root>');
    expect(root.text).toBe('hello world');
  });

  it('handles single-quoted attributes', () => {
    const root = parseXml("<root attr='value'/>");
    expect(root.attrs.attr).toBe('value');
  });
});

// ── PCML parser tests ────────────────────────────────────────────

describe('parsePcml', () => {

  it('parses minimal PCML', () => {
    const doc = parsePcml(`
      <pcml version="1.0">
        <program name="test" path="/qsys.lib/test.pgm">
          <data name="parm1" type="char" length="10" usage="input"/>
        </program>
      </pcml>
    `);

    expect(doc).toBeInstanceOf(PcmlDocNode);
    expect(doc.version).toBe('1.0');

    const programs = doc.children.filter(c => c instanceof PcmlProgramNode);
    expect(programs).toHaveLength(1);
    expect(programs[0].name).toBe('test');
    expect(programs[0].path).toBe('/qsys.lib/test.pgm');

    const data = programs[0].children.filter(c => c instanceof PcmlDataNode);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('parm1');
    expect(data[0].type).toBe('char');
    expect(data[0].usage).toBe('input');
  });

  it('parses PCML with structs', () => {
    const doc = parsePcml(`
      <pcml version="1.0">
        <struct name="myStruct">
          <data name="field1" type="int" length="4"/>
          <data name="field2" type="char" length="20"/>
        </struct>
        <program name="test" path="/qsys.lib/test.pgm">
          <data name="receiver" type="struct" struct="myStruct" usage="output"/>
        </program>
      </pcml>
    `);

    expect(doc.structs.size).toBe(1);
    expect(doc.structs.has('myStruct')).toBe(true);

    const structDef = doc.structs.get('myStruct');
    expect(structDef.children).toHaveLength(2);

    const pgm = doc.children.find(c => c instanceof PcmlProgramNode);
    const data = pgm.children[0];
    expect(data.type).toBe('struct');
    expect(data.struct).toBe('myStruct');
  });

  it('parses multiple programs', () => {
    const doc = parsePcml(`
      <pcml version="1.0">
        <program name="pgm1" path="/qsys.lib/pgm1.pgm">
          <data name="p" type="char" length="10" usage="input"/>
        </program>
        <program name="pgm2" path="/qsys.lib/pgm2.pgm">
          <data name="q" type="int" length="4" usage="output"/>
        </program>
      </pcml>
    `);

    const programs = doc.children.filter(c => c instanceof PcmlProgramNode);
    expect(programs).toHaveLength(2);
  });

  it('parses data attributes: init, count, outputsize', () => {
    const doc = parsePcml(`
      <pcml version="1.0">
        <program name="test" path="/qsys.lib/test.pgm">
          <data name="format" type="char" length="8" usage="input" init="JOBI0100"/>
          <data name="bufSize" type="int" length="4" usage="input" init="4096"/>
          <data name="arr" type="char" length="10" count="5" usage="output" outputsize="bufSize"/>
        </program>
      </pcml>
    `);

    const pgm = doc.children.find(c => c instanceof PcmlProgramNode);
    const format = pgm.children[0];
    expect(format.init).toBe('JOBI0100');

    const bufSize = pgm.children[1];
    expect(bufSize.init).toBe('4096');

    const arr = pgm.children[2];
    expect(arr.count).toBe('5');
    expect(arr.outputsize).toBe('bufSize');
  });

  it('rejects non-pcml root element', () => {
    expect(() => parsePcml('<html><body/></html>')).toThrow();
  });
});

// ── PCML model tests ─────────────────────────────────────────────

describe('PcmlDataNode', () => {

  it('resolves usage inheritance', () => {
    const doc = parsePcml(`
      <pcml version="1.0">
        <program name="test" path="/qsys.lib/test.pgm">
          <data name="outer" type="char" length="10" usage="output">
          </data>
          <data name="inner" type="char" length="5"/>
        </program>
      </pcml>
    `);

    const pgm = doc.children.find(c => c instanceof PcmlProgramNode);
    const inner = pgm.children[1];
    // 'inherit' resolves up to program which gives 'inputOutput'
    expect(inner.resolveUsage()).toBe('inputOutput');
  });

  it('resolveLength returns numeric value', () => {
    const node = new PcmlDataNode('test', { length: '20' });
    expect(node.resolveLength(null, null)).toBe(20);
  });

  it('resolveCount defaults to 1', () => {
    const node = new PcmlDataNode('test', {});
    expect(node.resolveCount(null)).toBe(1);
  });

  it('resolveCount with numeric string', () => {
    const node = new PcmlDataNode('test', { count: '5' });
    expect(node.resolveCount(null)).toBe(5);
  });
});

// ── Type resolver tests ──────────────────────────────────────────

describe('resolvePcmlType', () => {

  it('resolves char type', () => {
    const dt = resolvePcmlType({ type: 'char', length: 10, ccsid: 37 });
    expect(dt.byteLength()).toBe(10);
  });

  it('resolves int length=4', () => {
    const dt = resolvePcmlType({ type: 'int', length: 4 });
    expect(dt.byteLength()).toBe(4);
    const buf = dt.toBuffer(42);
    expect(dt.fromBuffer(buf)).toBe(42);
  });

  it('resolves int length=2', () => {
    const dt = resolvePcmlType({ type: 'int', length: 2 });
    expect(dt.byteLength()).toBe(2);
  });

  it('resolves packed decimal', () => {
    const dt = resolvePcmlType({ type: 'packed', length: 7, precision: 2 });
    expect(dt.byteLength()).toBeGreaterThan(0);
  });

  it('resolves float', () => {
    const dt4 = resolvePcmlType({ type: 'float', length: 4 });
    expect(dt4.byteLength()).toBe(4);

    const dt8 = resolvePcmlType({ type: 'float', length: 8 });
    expect(dt8.byteLength()).toBe(8);
  });

  it('resolves byte type', () => {
    const dt = resolvePcmlType({ type: 'byte', length: 16 });
    expect(dt.byteLength()).toBe(16);
  });
});

// ── Resource loading tests ───────────────────────────────────────

describe('PCML resources', () => {

  it('has shipped PCML files listed', () => {
    expect(pcmlResources.length).toBeGreaterThan(0);
    expect(pcmlResources).toContain('qcdrcmdd.pcml');
    expect(pcmlResources).toContain('quslfld.pcml');
  });

  it('loads qcdrcmdd.pcml', async () => {
    const xml = await loadPcmlResource('qcdrcmdd.pcml');
    expect(xml).toContain('<pcml');
    expect(xml).toContain('qcdrcmdd');
  });

  it('parses shipped qcdrcmdd.pcml', async () => {
    const xml = await loadPcmlResource('qcdrcmdd.pcml');
    const doc = parsePcml(xml);
    expect(doc).toBeInstanceOf(PcmlDocNode);

    const programs = doc.children.filter(c => c instanceof PcmlProgramNode);
    expect(programs.length).toBeGreaterThan(0);
    expect(programs[0].name).toBe('qcdrcmdd');
    expect(programs[0].path).toBe('/QSYS.LIB/QCDRCMDD.PGM');
  });

  it('parses shipped quslfld.pcml', async () => {
    const xml = await loadPcmlResource('quslfld.pcml');
    const doc = parsePcml(xml);
    const pgm = doc.children.find(c => c instanceof PcmlProgramNode);
    expect(pgm.name).toBe('quslfld');
    expect(pgm.children.length).toBeGreaterThan(0);
  });
});

// ── PCML cache tests ─────────────────────────────────────────────

describe('createPcmlCacheEntry', () => {

  it('returns null for empty input', () => {
    expect(createPcmlCacheEntry(null)).toBeNull();
  });

  it('generates cache from PCML source', () => {
    const cache = createPcmlCacheEntry(`
      <pcml version="1.0">
        <program name="test" path="/qsys.lib/test.pgm">
          <data name="p" type="char" length="10" usage="input" init="HELLO"/>
        </program>
      </pcml>
    `);

    expect(cache).toBeTruthy();
    expect(cache.version).toBe('1.0');
    expect(cache.programs).toHaveLength(1);
    expect(cache.programs[0].name).toBe('test');
    expect(cache.programs[0].path).toBe('/qsys.lib/test.pgm');
    expect(cache.programs[0].children).toHaveLength(1);
    expect(cache.programs[0].children[0].dataType).toBe('char');
    expect(cache.programs[0].children[0].init).toBe('HELLO');
  });

  it('cache parity: parse from source and cache produce same structure', async () => {
    const xml = await loadPcmlResource('qcdrcmdd.pcml');
    const cache = createPcmlCacheEntry(xml);
    const doc = parsePcml(xml);

    const pgm = doc.children.find(c => c instanceof PcmlProgramNode);
    expect(cache.programs[0].name).toBe(pgm.name);
    expect(cache.programs[0].path).toBe(pgm.path);
    expect(cache.programs[0].children.length).toBe(
      pgm.children.filter(c => c instanceof PcmlDataNode).length
    );
  });
});
