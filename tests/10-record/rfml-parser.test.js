/**
 * Tests for RFML parsing and RecordFormatDocument.
 */

import { describe, it, expect } from 'bun:test';
import { RecordFormatDocument } from '../../src/record/rfml/RecordFormatDocument.js';
import { FIELD_TYPE } from '../../src/record/FieldDescription.js';

const CUSTOMER_RFML = `<?xml version="1.0" encoding="UTF-8"?>
<rfml>
  <recordformat name="CUSTREC">
    <data name="CUSTNO" type="int" length="4" keyfield="true"/>
    <data name="NAME" type="char" length="30" ccsid="37"/>
    <data name="BALANCE" type="packed" length="9" precision="2"/>
    <data name="SINCE" type="date" dateformat="*ISO"/>
  </recordformat>
</rfml>`;

const MULTI_FORMAT_RFML = `<?xml version="1.0" encoding="UTF-8"?>
<rfml>
  <recordformat name="HEADER">
    <data name="ORDERNO" type="int" length="4"/>
    <data name="CUSTNO" type="int" length="4"/>
    <data name="ORDDATE" type="date" dateformat="*ISO"/>
  </recordformat>
  <recordformat name="DETAIL">
    <data name="ORDERNO" type="int" length="4"/>
    <data name="LINENO" type="int" length="2"/>
    <data name="ITEM" type="char" length="15"/>
    <data name="QTY" type="packed" length="5" precision="0"/>
    <data name="PRICE" type="packed" length="9" precision="2"/>
  </recordformat>
</rfml>`;

const ALL_TYPES_RFML = `<?xml version="1.0" encoding="UTF-8"?>
<rfml>
  <recordformat name="ALLTYPES">
    <data name="F_CHAR" type="char" length="10" ccsid="37"/>
    <data name="F_INT2" type="int" length="2"/>
    <data name="F_INT4" type="int" length="4"/>
    <data name="F_INT8" type="int" length="8"/>
    <data name="F_PACKED" type="packed" length="7" precision="2"/>
    <data name="F_ZONED" type="zoned" length="5" precision="0"/>
    <data name="F_FLOAT4" type="float" length="4"/>
    <data name="F_FLOAT8" type="float" length="8"/>
    <data name="F_HEX" type="byte" length="16"/>
    <data name="F_DATE" type="date" dateformat="*ISO"/>
    <data name="F_TIME" type="time" timeformat="*HMS"/>
    <data name="F_TSTAMP" type="timestamp"/>
  </recordformat>
</rfml>`;

describe('RecordFormatDocument.fromSource', () => {
  it('parses a single-format RFML document', () => {
    const doc = RecordFormatDocument.fromSource(CUSTOMER_RFML);
    expect(doc.size).toBe(1);
    expect(doc.getRecordFormatNames()).toContain('CUSTREC');
  });

  it('returns the correct record format', () => {
    const doc = RecordFormatDocument.fromSource(CUSTOMER_RFML);
    const fmt = doc.getRecordFormat('CUSTREC');
    expect(fmt.name).toBe('CUSTREC');
    expect(fmt.numberOfFields).toBe(4);
  });

  it('parses field names', () => {
    const doc = RecordFormatDocument.fromSource(CUSTOMER_RFML);
    const fmt = doc.getRecordFormat('CUSTREC');
    expect(fmt.getFieldNames()).toEqual(['CUSTNO', 'NAME', 'BALANCE', 'SINCE']);
  });

  it('sets key fields from keyfield attribute', () => {
    const doc = RecordFormatDocument.fromSource(CUSTOMER_RFML);
    const fmt = doc.getRecordFormat('CUSTREC');
    expect(fmt.getKeyFieldNames()).toEqual(['CUSTNO']);
  });
});

describe('RecordFormatDocument with multiple formats', () => {
  it('parses two formats', () => {
    const doc = RecordFormatDocument.fromSource(MULTI_FORMAT_RFML);
    expect(doc.size).toBe(2);
    expect(doc.getRecordFormatNames()).toContain('HEADER');
    expect(doc.getRecordFormatNames()).toContain('DETAIL');
  });

  it('each format has correct field count', () => {
    const doc = RecordFormatDocument.fromSource(MULTI_FORMAT_RFML);
    expect(doc.getRecordFormat('HEADER').numberOfFields).toBe(3);
    expect(doc.getRecordFormat('DETAIL').numberOfFields).toBe(5);
  });
});

describe('RFML type mapping', () => {
  it('maps all supported types', () => {
    const doc = RecordFormatDocument.fromSource(ALL_TYPES_RFML);
    const fmt = doc.getRecordFormat('ALLTYPES');

    expect(fmt.getFieldDescription('F_CHAR').fieldType).toBe(FIELD_TYPE.CHARACTER);
    expect(fmt.getFieldDescription('F_INT2').fieldType).toBe(FIELD_TYPE.BINARY);
    expect(fmt.getFieldDescription('F_INT4').fieldType).toBe(FIELD_TYPE.BINARY);
    expect(fmt.getFieldDescription('F_INT8').fieldType).toBe(FIELD_TYPE.BINARY);
    expect(fmt.getFieldDescription('F_PACKED').fieldType).toBe(FIELD_TYPE.PACKED);
    expect(fmt.getFieldDescription('F_ZONED').fieldType).toBe(FIELD_TYPE.ZONED);
    expect(fmt.getFieldDescription('F_FLOAT4').fieldType).toBe(FIELD_TYPE.FLOAT);
    expect(fmt.getFieldDescription('F_FLOAT8').fieldType).toBe(FIELD_TYPE.FLOAT);
    expect(fmt.getFieldDescription('F_HEX').fieldType).toBe(FIELD_TYPE.HEX);
    expect(fmt.getFieldDescription('F_DATE').fieldType).toBe(FIELD_TYPE.DATE);
    expect(fmt.getFieldDescription('F_TIME').fieldType).toBe(FIELD_TYPE.TIME);
    expect(fmt.getFieldDescription('F_TSTAMP').fieldType).toBe(FIELD_TYPE.TIMESTAMP);
  });

  it('assigns correct byte lengths', () => {
    const doc = RecordFormatDocument.fromSource(ALL_TYPES_RFML);
    const fmt = doc.getRecordFormat('ALLTYPES');

    expect(fmt.getFieldDescription('F_CHAR').byteLength).toBe(10);
    expect(fmt.getFieldDescription('F_INT2').byteLength).toBe(2);
    expect(fmt.getFieldDescription('F_INT4').byteLength).toBe(4);
    expect(fmt.getFieldDescription('F_INT8').byteLength).toBe(8);
    expect(fmt.getFieldDescription('F_PACKED').byteLength).toBe(4);  // floor(7/2)+1
    expect(fmt.getFieldDescription('F_ZONED').byteLength).toBe(5);
    expect(fmt.getFieldDescription('F_FLOAT4').byteLength).toBe(4);
    expect(fmt.getFieldDescription('F_FLOAT8').byteLength).toBe(8);
    expect(fmt.getFieldDescription('F_HEX').byteLength).toBe(16);
    expect(fmt.getFieldDescription('F_DATE').byteLength).toBe(10);
    expect(fmt.getFieldDescription('F_TIME').byteLength).toBe(8);
    expect(fmt.getFieldDescription('F_TSTAMP').byteLength).toBe(26);
  });
});

describe('RecordFormatDocument error handling', () => {
  it('throws on missing rfml root', () => {
    expect(() => RecordFormatDocument.fromSource('<foo/>')).toThrow(/rfml/);
  });

  it('throws on getRecordFormat with unknown name', () => {
    const doc = RecordFormatDocument.fromSource(CUSTOMER_RFML);
    expect(() => doc.getRecordFormat('NOPE')).toThrow(/not found/);
  });
});

describe('RecordFormatDocument case insensitivity', () => {
  it('retrieves format by name case-insensitively', () => {
    const doc = RecordFormatDocument.fromSource(CUSTOMER_RFML);
    const fmt = doc.getRecordFormat('custrec');
    expect(fmt.name).toBe('CUSTREC');
  });
});

describe('RecordFormatDocument.getRecordFormats', () => {
  it('returns a copy of the internal map', () => {
    const doc = RecordFormatDocument.fromSource(CUSTOMER_RFML);
    const map = doc.getRecordFormats();
    expect(map.size).toBe(1);
    expect(map.has('CUSTREC')).toBe(true);
  });
});
