/**
 * Optional PCML JSON cache generator.
 *
 * Generates a JSON representation of a parsed PCML document
 * that can be loaded faster than re-parsing XML at runtime.
 *
 * Upstream: replaces .pcml.ser
 * @module pcml/cache
 */

import { parsePcml } from './parser.js';
import {
  PcmlProgramNode,
  PcmlStructNode,
  PcmlDataNode,
} from './model.js';

/**
 * Generate a JSON cache entry from PCML source.
 *
 * @param {string|Buffer} source - PCML XML content
 * @returns {object} JSON-serializable representation
 */
export function createPcmlCacheEntry(source) {
  if (!source) return null;
  const doc = parsePcml(source);
  return serializeDoc(doc);
}

/**
 * Serialize a document model to JSON.
 * @param {import('./model.js').PcmlDocNode} doc
 * @returns {object}
 */
function serializeDoc(doc) {
  return {
    version: doc.version,
    structs: Object.fromEntries(
      [...doc.structs.entries()].map(([k, v]) => [k, serializeNode(v)])
    ),
    programs: doc.children
      .filter(c => c instanceof PcmlProgramNode)
      .map(c => serializeNode(c)),
  };
}

/**
 * Serialize a node.
 * @param {import('./model.js').PcmlNode} node
 * @returns {object}
 */
function serializeNode(node) {
  const obj = { name: node.name };

  if (node instanceof PcmlProgramNode) {
    obj.type = 'program';
    obj.path = node.path;
    if (node.entrypoint) obj.entrypoint = node.entrypoint;
    if (node.epccsid) obj.epccsid = node.epccsid;
    if (node.threadsafe) obj.threadsafe = true;
  } else if (node instanceof PcmlStructNode) {
    obj.type = 'struct';
  } else if (node instanceof PcmlDataNode) {
    obj.type = 'data';
    obj.dataType = node.type;
    obj.length = node.length;
    if (node.usage !== 'inherit') obj.usage = node.usage;
    if (node.init != null) obj.init = node.init;
    if (node.count != null) obj.count = node.count;
    if (node.offset != null) obj.offset = node.offset;
    if (node.offsetfrom != null) obj.offsetfrom = node.offsetfrom;
    if (node.outputsize != null) obj.outputsize = node.outputsize;
    if (node.precision) obj.precision = node.precision;
    if (node.ccsid) obj.ccsid = node.ccsid;
    if (node.trim) obj.trim = true;
    if (node.struct) obj.struct = node.struct;
  }

  if (node.children.length > 0) {
    obj.children = node.children.map(c => serializeNode(c));
  }

  return obj;
}
