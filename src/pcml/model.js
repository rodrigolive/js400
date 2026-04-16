/**
 * PCML DOM node models.
 *
 * Represents the parsed PCML document structure.
 *
 * Upstream: PcmlNode.java, PcmlDocNode.java, PcmlData.java, PcmlStruct.java
 * @module pcml/model
 */

/**
 * Base node in a PCML document tree.
 */
export class PcmlNode {
  /** @type {string} */
  name;
  /** @type {PcmlNode|null} */
  parent = null;
  /** @type {PcmlNode[]} */
  children = [];

  constructor(name) {
    this.name = name;
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  findChild(name) {
    return this.children.find(c => c.name === name) ?? null;
  }

  findChildDeep(qualifiedName) {
    const parts = qualifiedName.split('.');
    let node = this;
    for (const part of parts) {
      const child = node.children.find(c => c.name === part);
      if (!child) return null;
      node = child;
    }
    return node;
  }
}

/**
 * Root document node.
 */
export class PcmlDocNode extends PcmlNode {
  /** @type {string} */
  version = '1.0';
  /** @type {Map<string, PcmlStructNode>} */
  structs = new Map();

  constructor() {
    super('#document');
  }
}

/**
 * Program node: <program name="..." path="...">
 */
export class PcmlProgramNode extends PcmlNode {
  /** @type {string} */
  path = '';
  /** @type {string} */
  entrypoint = '';
  /** @type {number} */
  epccsid = 0;
  /** @type {boolean} */
  threadsafe = false;
  /** @type {string} */
  parseOrder = '';

  constructor(name, attrs = {}) {
    super(name);
    this.path = attrs.path ?? '';
    this.entrypoint = attrs.entrypoint ?? '';
    this.epccsid = parseInt(attrs.epccsid, 10) || 0;
    this.threadsafe = attrs.threadsafe === 'true';
    this.parseOrder = attrs.parseOrder ?? '';
  }
}

/**
 * Struct node: <struct name="...">
 */
export class PcmlStructNode extends PcmlNode {
  constructor(name) {
    super(name);
  }
}

/**
 * Data node: <data name="..." type="..." length="..." usage="..." ...>
 */
export class PcmlDataNode extends PcmlNode {
  /** @type {string} data type: char, int, packed, zoned, float, byte, struct */
  type = 'char';
  /** @type {string|number} byte length or reference */
  length = 0;
  /** @type {string} usage: input, output, inputOutput, inherit */
  usage = 'inherit';
  /** @type {string|null} initial/default value */
  init = null;
  /** @type {string|null} count expression (number or reference) */
  count = null;
  /** @type {string|null} offset expression */
  offset = null;
  /** @type {string|null} offsetfrom expression */
  offsetfrom = null;
  /** @type {string|null} outputsize expression */
  outputsize = null;
  /** @type {number} precision (for packed/zoned) */
  precision = 0;
  /** @type {number} CCSID for char data */
  ccsid = 0;
  /** @type {boolean} trim trailing blanks on output */
  trim = false;
  /** @type {string|null} struct reference name (for type="struct") */
  struct = null;
  /** @type {string|null} date/time format */
  dateformat = null;
  /** @type {string|null} date/time separator */
  dateseparator = null;
  /** @type {boolean} bidirectional string type */
  bidistringtype = false;
  /** @type {number|null} min/max value constraints */
  minvrm = null;
  maxvrm = null;

  /** Runtime value storage. */
  value = undefined;

  constructor(name, attrs = {}) {
    super(name);
    this.type = attrs.type ?? 'char';
    this.length = attrs.length ?? 0;
    this.usage = attrs.usage ?? 'inherit';
    this.init = attrs.init ?? null;
    this.count = attrs.count ?? null;
    this.offset = attrs.offset ?? null;
    this.offsetfrom = attrs.offsetfrom ?? null;
    this.outputsize = attrs.outputsize ?? null;
    this.precision = parseInt(attrs.precision, 10) || 0;
    this.ccsid = parseInt(attrs.ccsid, 10) || 0;
    this.trim = attrs.trim === 'true';
    this.struct = attrs.struct ?? null;
    this.dateformat = attrs.dateformat ?? null;
    this.dateseparator = attrs.dateseparator ?? null;
    if (attrs.minvrm) this.minvrm = parseInt(attrs.minvrm, 10) || null;
    if (attrs.maxvrm) this.maxvrm = parseInt(attrs.maxvrm, 10) || null;
  }

  /**
   * Resolve the effective usage for this node.
   * "inherit" walks up the tree to find an explicit usage.
   */
  resolveUsage() {
    if (this.usage !== 'inherit') return this.usage;
    let node = this.parent;
    while (node) {
      if (node instanceof PcmlDataNode && node.usage !== 'inherit') {
        return node.usage;
      }
      if (node instanceof PcmlProgramNode) return 'inputOutput';
      node = node.parent;
    }
    return 'inputOutput';
  }

  /**
   * Resolve numeric length, potentially from a sibling reference.
   * @param {PcmlDocNode} doc
   * @param {Map<string, number>} [resolvedValues]
   * @returns {number}
   */
  resolveLength(doc, resolvedValues) {
    if (typeof this.length === 'number') return this.length;
    const n = parseInt(this.length, 10);
    if (!isNaN(n)) return n;
    // Reference to another field's value
    if (resolvedValues) {
      const val = resolvedValues.get(String(this.length));
      if (val !== undefined) return val;
    }
    return 0;
  }

  /**
   * Resolve count value (could be numeric or a reference).
   * @param {Map<string, number>} [resolvedValues]
   * @returns {number}
   */
  resolveCount(resolvedValues) {
    if (this.count === null || this.count === undefined) return 1;
    const n = parseInt(this.count, 10);
    if (!isNaN(n)) return n;
    if (resolvedValues) {
      const val = resolvedValues.get(String(this.count));
      if (val !== undefined) return val;
    }
    return 0;
  }
}
