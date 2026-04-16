/**
 * Server-side record format discovery.
 *
 * Retrieves file field descriptions from the server by calling
 * the QDBRTVFD (Retrieve File Description) API via program call,
 * or by using DSPFFD command output to build a RecordFormat.
 *
 * This is a convenience layer. Users can also build RecordFormat
 * manually or from RFML.
 *
 * Upstream: AS400FileRecordDescription.java, RecordFormat.java
 * @module record/description/FileRecordDescription
 */

import { RecordFormat } from '../RecordFormat.js';
import { FieldDescription } from '../FieldDescription.js';

export class FileRecordDescription {

  /**
   * Build a RecordFormat from field metadata returned by the server.
   *
   * This processes the raw QDBRTVFD output or equivalent metadata
   * into a usable RecordFormat with FieldDescriptions.
   *
   * @param {object[]} fields - Array of field metadata objects
   * @param {string} [formatName=''] - Record format name
   * @param {string[]} [keyFields=[]] - Key field names
   * @returns {RecordFormat}
   */
  static buildFromFieldMetadata(fields, formatName = '', keyFields = []) {
    const format = new RecordFormat(formatName);

    for (const f of fields) {
      const fd = FileRecordDescription.#createFieldDescription(f);
      if (fd) format.addFieldDescription(fd);
    }

    if (keyFields.length > 0) {
      format.setKeyFieldNames(keyFields);
    }

    return format;
  }

  /**
   * Retrieve the record format from the server.
   * Uses QDBRTVFD API via program call.
   *
   * @param {import('../../core/AS400.js').AS400} system
   * @param {string} library
   * @param {string} file
   * @returns {Promise<RecordFormat>}
   */
  static async retrieveRecordFormat(system, library, file) {
    throw new Error(
      `Server-side format retrieval not yet implemented. ` +
      `Use RecordFormatDocument.fromSource() with RFML XML, ` +
      `or build a RecordFormat manually with FieldDescription factories.`
    );
  }

  /**
   * Build a RecordFormat from DDS-style field specifications.
   * Convenience method for programmatic format building.
   *
   * @param {string} formatName
   * @param {Array<{
   *   name: string,
   *   type: string,
   *   length: number,
   *   decimals?: number,
   *   ccsid?: number,
   *   allowNull?: boolean,
   *   text?: string,
   * }>} fieldSpecs
   * @param {string[]} [keyFields=[]]
   * @returns {RecordFormat}
   */
  static buildFromDDS(formatName, fieldSpecs, keyFields = []) {
    const format = new RecordFormat(formatName);

    for (const spec of fieldSpecs) {
      const fd = FileRecordDescription.#createFieldFromDDSType(spec);
      format.addFieldDescription(fd);
    }

    if (keyFields.length > 0) {
      format.setKeyFieldNames(keyFields);
    }

    return format;
  }

  // ---- Internal ----

  static #createFieldDescription(meta) {
    const name = meta.name || meta.fieldName || '';
    const type = (meta.type || meta.dataType || 'A').toUpperCase();
    const length = meta.length || meta.fieldLength || 0;
    const decimals = meta.decimals ?? meta.decimalPositions ?? 0;
    const ccsid = meta.ccsid || 37;
    const allowNull = meta.allowNull ?? false;
    const text = meta.text || '';

    return FileRecordDescription.#createFieldFromDDSType({
      name, type, length, decimals, ccsid, allowNull, text,
    });
  }

  static #createFieldFromDDSType(spec) {
    const { name, type, length, decimals = 0, ccsid = 37, allowNull = false, text = '' } = spec;
    const opts = { allowNull, text };

    switch (type.toUpperCase()) {
      case 'A':
        return FieldDescription.character(name, length, ccsid, opts);
      case 'P':
        return FieldDescription.packedDecimal(name, length, decimals, opts);
      case 'S':
        return FieldDescription.zonedDecimal(name, length, decimals, opts);
      case 'B':
        return FieldDescription.binary(name, length <= 4 ? (length <= 2 ? 2 : 4) : 8, opts);
      case 'F':
        return FieldDescription.float(name, length <= 4 ? 4 : 8, opts);
      case 'H':
        return FieldDescription.hex(name, length, opts);
      case 'L':
        return FieldDescription.date(name, '*ISO', opts);
      case 'T':
        return FieldDescription.time(name, '*ISO', opts);
      case 'Z':
        return FieldDescription.timestamp(name, opts);
      case 'J':
        return FieldDescription.dbcsOnly(name, length, ccsid, opts);
      case 'E':
        return FieldDescription.dbcsEither(name, length, ccsid, opts);
      case 'O':
        return FieldDescription.dbcsOpen(name, length, ccsid, opts);
      case 'G':
        return FieldDescription.dbcsGraphic(name, length, ccsid, opts);
      default:
        return FieldDescription.character(name, length, ccsid, opts);
    }
  }
}
