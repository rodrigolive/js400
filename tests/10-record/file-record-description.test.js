/**
 * Tests for FileRecordDescription: DDS-based format building and metadata.
 */

import { describe, it, expect } from 'bun:test';
import { FileRecordDescription } from '../../src/record/description/FileRecordDescription.js';
import { FIELD_TYPE } from '../../src/record/FieldDescription.js';

describe('FileRecordDescription.buildFromDDS', () => {
  it('builds a format from DDS field specs', () => {
    const fmt = FileRecordDescription.buildFromDDS('CUSTREC', [
      { name: 'CUSTNO', type: 'B', length: 4 },
      { name: 'NAME', type: 'A', length: 30 },
      { name: 'BALANCE', type: 'P', length: 9, decimals: 2 },
      { name: 'REGION', type: 'S', length: 3, decimals: 0 },
    ]);
    expect(fmt.name).toBe('CUSTREC');
    expect(fmt.numberOfFields).toBe(4);
    expect(fmt.getFieldDescription('NAME').fieldType).toBe(FIELD_TYPE.CHARACTER);
    expect(fmt.getFieldDescription('BALANCE').fieldType).toBe(FIELD_TYPE.PACKED);
    expect(fmt.getFieldDescription('REGION').fieldType).toBe(FIELD_TYPE.ZONED);
  });

  it('handles key fields', () => {
    const fmt = FileRecordDescription.buildFromDDS('KEYED', [
      { name: 'ID', type: 'B', length: 4 },
      { name: 'VAL', type: 'A', length: 10 },
    ], ['ID']);
    expect(fmt.getKeyFieldNames()).toEqual(['ID']);
  });

  it('handles all DDS type codes', () => {
    const fmt = FileRecordDescription.buildFromDDS('ALLTYPE', [
      { name: 'F1', type: 'A', length: 5 },
      { name: 'F2', type: 'P', length: 7, decimals: 2 },
      { name: 'F3', type: 'S', length: 5, decimals: 0 },
      { name: 'F4', type: 'B', length: 4 },
      { name: 'F5', type: 'F', length: 8 },
      { name: 'F6', type: 'H', length: 10 },
      { name: 'F7', type: 'L', length: 10 },
      { name: 'F8', type: 'T', length: 8 },
      { name: 'F9', type: 'Z', length: 26 },
    ]);
    expect(fmt.numberOfFields).toBe(9);
    expect(fmt.getFieldDescription('F1').fieldType).toBe(FIELD_TYPE.CHARACTER);
    expect(fmt.getFieldDescription('F2').fieldType).toBe(FIELD_TYPE.PACKED);
    expect(fmt.getFieldDescription('F3').fieldType).toBe(FIELD_TYPE.ZONED);
    expect(fmt.getFieldDescription('F4').fieldType).toBe(FIELD_TYPE.BINARY);
    expect(fmt.getFieldDescription('F5').fieldType).toBe(FIELD_TYPE.FLOAT);
    expect(fmt.getFieldDescription('F6').fieldType).toBe(FIELD_TYPE.HEX);
    expect(fmt.getFieldDescription('F7').fieldType).toBe(FIELD_TYPE.DATE);
    expect(fmt.getFieldDescription('F8').fieldType).toBe(FIELD_TYPE.TIME);
    expect(fmt.getFieldDescription('F9').fieldType).toBe(FIELD_TYPE.TIMESTAMP);
  });

  it('handles DBCS types', () => {
    const fmt = FileRecordDescription.buildFromDDS('DBCS', [
      { name: 'D1', type: 'J', length: 10 },
      { name: 'D2', type: 'E', length: 10 },
      { name: 'D3', type: 'O', length: 10 },
      { name: 'D4', type: 'G', length: 10 },
    ]);
    expect(fmt.getFieldDescription('D1').fieldType).toBe(FIELD_TYPE.DBCS_ONLY);
    expect(fmt.getFieldDescription('D2').fieldType).toBe(FIELD_TYPE.DBCS_EITHER);
    expect(fmt.getFieldDescription('D3').fieldType).toBe(FIELD_TYPE.DBCS_OPEN);
    expect(fmt.getFieldDescription('D4').fieldType).toBe(FIELD_TYPE.DBCS_GRAPHIC);
  });

  it('defaults unknown type to character', () => {
    const fmt = FileRecordDescription.buildFromDDS('UNK', [
      { name: 'X', type: 'Q', length: 5 },
    ]);
    expect(fmt.getFieldDescription('X').fieldType).toBe(FIELD_TYPE.CHARACTER);
  });

  it('respects allowNull option', () => {
    const fmt = FileRecordDescription.buildFromDDS('NULLTEST', [
      { name: 'OPT', type: 'A', length: 10, allowNull: true },
    ]);
    expect(fmt.getFieldDescription('OPT').allowNull).toBe(true);
  });
});

describe('FileRecordDescription.buildFromFieldMetadata', () => {
  it('builds a format from metadata objects', () => {
    const fmt = FileRecordDescription.buildFromFieldMetadata([
      { name: 'ID', type: 'B', length: 4 },
      { name: 'DESC', type: 'A', length: 20 },
    ], 'TESTREC', ['ID']);
    expect(fmt.name).toBe('TESTREC');
    expect(fmt.numberOfFields).toBe(2);
    expect(fmt.getKeyFieldNames()).toEqual(['ID']);
  });

  it('accepts alternative property names', () => {
    const fmt = FileRecordDescription.buildFromFieldMetadata([
      { fieldName: 'ID', dataType: 'B', fieldLength: 4 },
    ], 'ALT');
    expect(fmt.getFieldDescription('ID').fieldType).toBe(FIELD_TYPE.BINARY);
  });
});

describe('FileRecordDescription.retrieveRecordFormat', () => {
  it('throws not implemented error', async () => {
    try {
      await FileRecordDescription.retrieveRecordFormat({}, 'LIB', 'FILE');
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e.message).toContain('not yet implemented');
    }
  });
});
