/**
 * Shipped PCML resource manifest.
 *
 * Upstream: src/main/resources/com/ibm/as400/access/*.pcml
 * @module pcml/resources
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * List of shipped PCML resource files.
 */
export const pcmlResources = Object.freeze([
  'qcdrcmdd.pcml',
  'qusljob.pcml',
  'qusrjobi.pcml',
  'qusrobjd.pcml',
  'quslobj.pcml',
  'quslmbr.pcml',
  'quscrtus.pcml',
  'qusdltus.pcml',
  'qusptrus.pcml',
  'qusrusat.pcml',
  'qgygtle.pcml',
  'qgyclst.pcml',
  'quslfld.pcml',
  'qsyrusri.pcml',
  'qszrtvpr.pcml',
  'quhrhlpt.pcml',
]);

/**
 * Load a shipped PCML resource by name.
 *
 * @param {string} name - File name (e.g. "qusljob.pcml")
 * @returns {Promise<string>} PCML XML content
 */
export async function loadPcmlResource(name) {
  const filePath = join(__dirname, name);
  return readFile(filePath, 'utf-8');
}

/**
 * Get the filesystem path to a shipped PCML resource.
 *
 * @param {string} name
 * @returns {string}
 */
export function getPcmlResourcePath(name) {
  return join(__dirname, name);
}
