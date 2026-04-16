/**
 * PCML-to-AS400DataType resolver.
 *
 * Maps PCML type/length/precision attributes to concrete AS400DataType instances.
 *
 * Upstream: PcmlData.java type attributes
 * @module pcml/types
 */

import { AS400Text } from '../datatypes/AS400Text.js';
import { AS400Bin2 } from '../datatypes/AS400Bin2.js';
import { AS400Bin4 } from '../datatypes/AS400Bin4.js';
import { AS400Bin8 } from '../datatypes/AS400Bin8.js';
import { AS400UnsignedBin2 } from '../datatypes/AS400UnsignedBin2.js';
import { AS400UnsignedBin4 } from '../datatypes/AS400UnsignedBin4.js';
import { AS400Float4 } from '../datatypes/AS400Float4.js';
import { AS400Float8 } from '../datatypes/AS400Float8.js';
import { AS400PackedDecimal } from '../datatypes/AS400PackedDecimal.js';
import { AS400ZonedDecimal } from '../datatypes/AS400ZonedDecimal.js';
import { AS400ByteArray } from '../datatypes/AS400ByteArray.js';

/**
 * Resolve a PCML data node's type/length/precision into an AS400DataType.
 *
 * @param {object} opts
 * @param {string} opts.type - PCML type: char, int, packed, zoned, float, byte
 * @param {number} opts.length - Byte length
 * @param {number} [opts.precision=0] - Decimal precision
 * @param {number} [opts.ccsid=37] - CCSID for char type
 * @returns {import('../datatypes/AS400DataType.js').AS400DataType}
 */
export function resolvePcmlType(opts) {
  const { type, length, precision = 0, ccsid = 37 } = opts;

  switch (type) {
    case 'char':
      return new AS400Text(length, ccsid || 37);

    case 'int':
      if (length === 2) {
        return precision > 0 ? new AS400UnsignedBin2() : new AS400Bin2();
      }
      if (length === 4) {
        return precision > 0 ? new AS400UnsignedBin4() : new AS400Bin4();
      }
      if (length === 8) {
        return new AS400Bin8();
      }
      return new AS400Bin4();

    case 'packed':
      return new AS400PackedDecimal(length, precision);

    case 'zoned':
      return new AS400ZonedDecimal(length, precision);

    case 'float':
      if (length === 8) return new AS400Float8();
      return new AS400Float4();

    case 'byte':
      return new AS400ByteArray(length);

    default:
      return new AS400ByteArray(length || 4);
  }
}
