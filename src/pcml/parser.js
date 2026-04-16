/**
 * PCML XML parser.
 *
 * Parses PCML XML into the document model used by ProgramCallDocument.
 *
 * Upstream: PcmlDocument*.java, PcmlData.java, PcmlStruct.java
 * @module pcml/parser
 */

import { parseXml } from './xml.js';
import { PcmlError } from '../core/errors.js';
import {
  PcmlDocNode,
  PcmlProgramNode,
  PcmlStructNode,
  PcmlDataNode,
} from './model.js';

/**
 * Parse PCML source into a document model.
 *
 * @param {string|Buffer} source - PCML XML content
 * @returns {PcmlDocNode}
 */
export function parsePcml(source) {
  const xmlRoot = parseXml(source);

  if (xmlRoot.tag !== 'pcml') {
    throw new PcmlError(`Expected <pcml> root element, found <${xmlRoot.tag}>`);
  }

  const doc = new PcmlDocNode();
  doc.version = xmlRoot.attrs.version ?? '1.0';

  // First pass: collect top-level structs
  for (const child of xmlRoot.children) {
    if (child.tag === 'struct') {
      const structNode = parseStructElement(child);
      doc.structs.set(structNode.name, structNode);
      doc.addChild(structNode);
    }
  }

  // Second pass: programs (which may reference structs)
  for (const child of xmlRoot.children) {
    if (child.tag === 'program') {
      const pgmNode = parseProgramElement(child, doc);
      doc.addChild(pgmNode);
    }
  }

  return doc;
}

/**
 * Parse a <program> element.
 * @param {import('./xml.js').XmlElement} el
 * @param {PcmlDocNode} doc
 * @returns {PcmlProgramNode}
 */
function parseProgramElement(el, doc) {
  const pgm = new PcmlProgramNode(el.attrs.name, el.attrs);

  for (const child of el.children) {
    if (child.tag === 'data') {
      pgm.addChild(parseDataElement(child, doc));
    } else if (child.tag === 'struct') {
      const structNode = parseStructElement(child);
      pgm.addChild(structNode);
    }
  }

  return pgm;
}

/**
 * Parse a <struct> element.
 * @param {import('./xml.js').XmlElement} el
 * @returns {PcmlStructNode}
 */
function parseStructElement(el) {
  const structNode = new PcmlStructNode(el.attrs.name);

  for (const child of el.children) {
    if (child.tag === 'data') {
      structNode.addChild(parseDataElement(child, null));
    } else if (child.tag === 'struct') {
      structNode.addChild(parseStructElement(child));
    }
  }

  return structNode;
}

/**
 * Parse a <data> element.
 * @param {import('./xml.js').XmlElement} el
 * @param {PcmlDocNode|null} doc
 * @returns {PcmlDataNode}
 */
function parseDataElement(el, doc) {
  const dataNode = new PcmlDataNode(el.attrs.name, el.attrs);

  // If type="struct" with struct="X", the children come from the struct def
  // (they'll be resolved at materialization time)

  // Inline children
  for (const child of el.children) {
    if (child.tag === 'data') {
      dataNode.addChild(parseDataElement(child, doc));
    } else if (child.tag === 'struct') {
      dataNode.addChild(parseStructElement(child));
    }
  }

  return dataNode;
}
