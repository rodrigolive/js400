/**
 * CCSID-to-converter lookup registry.
 *
 * Loads generated CCSID conversion tables and makes them
 * available for lookup by CCSID number.
 *
 * Upstream: NLS*.java, ConversionMaps.java
 * @module ccsid/registry
 */

import { generatedConvTables } from './generated/index.js';

export const ccsidRegistry = generatedConvTables;
