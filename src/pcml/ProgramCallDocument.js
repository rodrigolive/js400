/**
 * PCML document runtime -- parse and execute program calls from PCML definitions.
 *
 * Usage:
 *   const doc = new ProgramCallDocument(system, "./myprogram.pcml");
 *   doc.setValue("myprogram.inputParm", "VALUE1");
 *   await doc.callProgram("myprogram");
 *   console.log(doc.getValue("myprogram.outputParm"));
 *
 * Upstream: ProgramCallDocument.java
 * @module pcml/ProgramCallDocument
 */

import { readFile } from 'node:fs/promises';
import { PcmlError } from '../core/errors.js';
import { Trace } from '../core/Trace.js';
import { parsePcml } from './parser.js';
import { resolvePcmlType } from './types.js';
import {
  PcmlDocNode,
  PcmlProgramNode,
  PcmlStructNode,
  PcmlDataNode,
} from './model.js';
import { ProgramCall } from '../command/ProgramCall.js';
import { ProgramParameter } from '../command/ProgramParameter.js';

export class ProgramCallDocument {
  /** @type {import('../core/AS400.js').AS400} */
  #system;
  /** @type {PcmlDocNode} */
  #doc;
  /** @type {import('../core/AS400Message.js').AS400Message[]} */
  #messageList = [];

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string|Buffer|PcmlDocNode} source - File path, XML string/buffer, or pre-parsed doc
   */
  constructor(system, source) {
    this.#system = system;
    if (source instanceof PcmlDocNode) {
      this.#doc = source;
    } else if (typeof source === 'string' && !source.includes('<')) {
      // Will be loaded asynchronously via _loadFile
      this.#doc = null;
      this._pendingPath = source;
    } else {
      this.#doc = parsePcml(source);
    }
  }

  /**
   * Create from XML source (string or Buffer).
   * @param {import('../core/AS400.js').AS400} system
   * @param {string|Buffer} source
   * @returns {Promise<ProgramCallDocument>}
   */
  static async fromSource(system, source) {
    const doc = parsePcml(source);
    return new ProgramCallDocument(system, doc);
  }

  /**
   * Create from a file path.
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} filePath
   * @returns {Promise<ProgramCallDocument>}
   */
  static async fromFile(system, filePath) {
    const xml = await readFile(filePath, 'utf-8');
    const doc = parsePcml(xml);
    return new ProgramCallDocument(system, doc);
  }

  /**
   * Ensure the document is loaded (handles lazy file loading).
   * @returns {Promise<void>}
   */
  async #ensureLoaded() {
    if (!this.#doc && this._pendingPath) {
      const xml = await readFile(this._pendingPath, 'utf-8');
      this.#doc = parsePcml(xml);
      this._pendingPath = null;
    }
    if (!this.#doc) {
      throw new PcmlError('PCML document not loaded');
    }
  }

  /**
   * Get the parsed document model.
   * @returns {PcmlDocNode}
   */
  getDocument() { return this.#doc; }

  /**
   * Set a value on a data node by qualified name.
   *
   * @param {string} qualifiedName - e.g. "myprogram.inputParm"
   * @param {*} value
   */
  setValue(qualifiedName, value) {
    const node = this.#resolveDataNode(qualifiedName);
    node.value = value;
  }

  /**
   * Get a value from a data node by qualified name.
   *
   * @param {string} qualifiedName
   * @returns {*}
   */
  getValue(qualifiedName) {
    const node = this.#resolveDataNode(qualifiedName);
    return node.value;
  }

  /**
   * Get the message list from the last callProgram invocation.
   * @returns {import('../core/AS400Message.js').AS400Message[]}
   */
  getMessageList() { return this.#messageList; }

  /**
   * Call a program defined in the PCML.
   *
   * @param {string} programName - Name of the <program> element
   * @returns {Promise<boolean>}
   */
  async callProgram(programName) {
    await this.#ensureLoaded();

    const pgmNode = this.#findProgramNode(programName);
    if (!pgmNode) {
      throw new PcmlError(`Program '${programName}' not found in PCML document`);
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `ProgramCallDocument.callProgram: ${programName} (${pgmNode.path})`);
    }

    // Materialize parameters
    const params = this.#materializeParameters(pgmNode);

    // Create and run ProgramCall
    const pc = new ProgramCall(this.#system);
    pc.setProgram(pgmNode.path, params);

    const success = await pc.run();
    this.#messageList = pc.getMessageList();

    // Dematerialize output parameters back to data nodes
    this.#dematerializeParameters(pgmNode, params);

    return success;
  }

  /**
   * List all program names in this document.
   * @returns {string[]}
   */
  listPrograms() {
    if (!this.#doc) return [];
    return this.#doc.children
      .filter(c => c instanceof PcmlProgramNode)
      .map(c => c.name);
  }

  /**
   * Resolve a qualified name to a PcmlDataNode.
   * @param {string} qualifiedName - "program.field" or "program.struct.field"
   * @returns {PcmlDataNode}
   */
  #resolveDataNode(qualifiedName) {
    if (!this.#doc) {
      throw new PcmlError('PCML document not loaded');
    }

    const parts = qualifiedName.split('.');
    if (parts.length < 2) {
      throw new PcmlError(`Qualified name must have at least program.field: '${qualifiedName}'`);
    }

    let node = this.#doc;
    for (const part of parts) {
      const child = node.children.find(c => c.name === part);
      if (!child) {
        throw new PcmlError(`Node '${part}' not found in path '${qualifiedName}'`);
      }
      node = child;
    }

    if (!(node instanceof PcmlDataNode)) {
      throw new PcmlError(`Node '${qualifiedName}' is not a data node`);
    }

    return node;
  }

  /**
   * Find a program node by name.
   * @param {string} name
   * @returns {PcmlProgramNode|null}
   */
  #findProgramNode(name) {
    // Support qualified names like "doc.program"
    const simpleName = name.includes('.') ? name.split('.').pop() : name;
    return this.#doc.children.find(
      c => c instanceof PcmlProgramNode && c.name === simpleName
    ) ?? null;
  }

  /**
   * Materialize PCML data nodes into ProgramParameter instances.
   * @param {PcmlProgramNode} pgm
   * @returns {ProgramParameter[]}
   */
  #materializeParameters(pgm) {
    const params = [];

    for (const child of pgm.children) {
      if (child instanceof PcmlDataNode) {
        params.push(this.#materializeDataNode(child, pgm));
      }
    }

    return params;
  }

  /**
   * Materialize a single data node into a ProgramParameter.
   * @param {PcmlDataNode} node
   * @param {PcmlProgramNode} pgm
   * @returns {ProgramParameter}
   */
  #materializeDataNode(node, pgm) {
    const usage = node.resolveUsage();
    const isInput = usage === 'input' || usage === 'inputOutput';
    const isOutput = usage === 'output' || usage === 'inputOutput';

    // Handle struct references
    if (node.type === 'struct' && node.struct) {
      return this.#materializeStructParam(node, pgm);
    }

    const numericLength = node.resolveLength(this.#doc, null);
    const dt = resolvePcmlType({
      type: node.type,
      length: numericLength,
      precision: node.precision,
      ccsid: node.ccsid || 37,
    });

    const byteLen = dt.byteLength();
    let inputBuf = null;

    if (isInput) {
      const value = node.value !== undefined ? node.value : node.init;
      if (value !== null && value !== undefined) {
        inputBuf = dt.toBuffer(value);
      } else {
        inputBuf = Buffer.alloc(byteLen);
      }
    }

    // Determine output size
    let outputLen = 0;
    if (isOutput) {
      if (node.outputsize != null) {
        const n = parseInt(node.outputsize, 10);
        outputLen = isNaN(n) ? byteLen : n;
      } else {
        outputLen = byteLen;
      }
    }

    const pp = new ProgramParameter({
      inputData: inputBuf,
      outputLength: outputLen,
      usage: usage === 'input' ? ProgramParameter.INPUT
           : usage === 'output' ? ProgramParameter.OUTPUT
           : ProgramParameter.INOUT,
    });

    return pp;
  }

  /**
   * Materialize a struct-typed parameter.
   * @param {PcmlDataNode} node
   * @param {PcmlProgramNode} pgm
   * @returns {ProgramParameter}
   */
  #materializeStructParam(node, pgm) {
    const usage = node.resolveUsage();
    const isInput = usage === 'input' || usage === 'inputOutput';
    const isOutput = usage === 'output' || usage === 'inputOutput';

    // Find the struct definition
    const structDef = this.#doc.structs.get(node.struct);
    if (!structDef) {
      throw new PcmlError(`Struct '${node.struct}' not found`);
    }

    // Calculate total byte size of the struct
    let totalBytes = 0;
    for (const field of structDef.children) {
      if (field instanceof PcmlDataNode) {
        const len = field.resolveLength(this.#doc, null);
        const dt = resolvePcmlType({
          type: field.type,
          length: len,
          precision: field.precision,
          ccsid: field.ccsid || 37,
        });
        totalBytes += dt.byteLength();
      }
    }

    // Use outputsize if specified
    let outputLen = 0;
    if (isOutput) {
      if (node.outputsize != null) {
        const n = parseInt(node.outputsize, 10);
        outputLen = isNaN(n) ? totalBytes : n;
      } else {
        outputLen = totalBytes;
      }
    }

    let inputBuf = null;
    if (isInput) {
      inputBuf = Buffer.alloc(Math.max(totalBytes, outputLen));
      // Serialize struct fields
      let offset = 0;
      for (const field of structDef.children) {
        if (field instanceof PcmlDataNode) {
          const len = field.resolveLength(this.#doc, null);
          const dt = resolvePcmlType({
            type: field.type,
            length: len,
            precision: field.precision,
            ccsid: field.ccsid || 37,
          });
          const value = field.value !== undefined ? field.value : field.init;
          const fieldBuf = value != null ? dt.toBuffer(value) : Buffer.alloc(dt.byteLength());
          fieldBuf.copy(inputBuf, offset);
          offset += dt.byteLength();
        }
      }
    }

    return new ProgramParameter({
      inputData: inputBuf,
      outputLength: outputLen,
      usage: usage === 'input' ? ProgramParameter.INPUT
           : usage === 'output' ? ProgramParameter.OUTPUT
           : ProgramParameter.INOUT,
    });
  }

  /**
   * Dematerialize output parameters back to data node values.
   * @param {PcmlProgramNode} pgm
   * @param {ProgramParameter[]} params
   */
  #dematerializeParameters(pgm, params) {
    let idx = 0;
    for (const child of pgm.children) {
      if (child instanceof PcmlDataNode && idx < params.length) {
        const p = params[idx];
        const usage = child.resolveUsage();

        if (usage === 'output' || usage === 'inputOutput') {
          const outBuf = p.getOutputData();
          if (outBuf && outBuf.length > 0) {
            if (child.type === 'struct' && child.struct) {
              this.#dematerializeStruct(child, outBuf);
            } else {
              const numericLength = child.resolveLength(this.#doc, null);
              const dt = resolvePcmlType({
                type: child.type,
                length: numericLength,
                precision: child.precision,
                ccsid: child.ccsid || 37,
              });
              try {
                let val = dt.fromBuffer(outBuf, 0);
                if (child.trim && typeof val === 'string') {
                  val = val.trim();
                }
                child.value = val;
              } catch {
                child.value = outBuf;
              }
            }
          }
        }
        idx++;
      }
    }
  }

  /**
   * Dematerialize a struct output buffer into individual field values.
   * @param {PcmlDataNode} node
   * @param {Buffer} buf
   */
  #dematerializeStruct(node, buf) {
    const structDef = this.#doc.structs.get(node.struct);
    if (!structDef) return;

    let offset = 0;
    for (const field of structDef.children) {
      if (field instanceof PcmlDataNode) {
        const len = field.resolveLength(this.#doc, null);
        const dt = resolvePcmlType({
          type: field.type,
          length: len,
          precision: field.precision,
          ccsid: field.ccsid || 37,
        });
        const byteLen = dt.byteLength();
        if (offset + byteLen <= buf.length) {
          try {
            let val = dt.fromBuffer(buf, offset);
            if (field.trim && typeof val === 'string') {
              val = val.trim();
            }
            field.value = val;
          } catch {
            field.value = buf.subarray(offset, offset + byteLen);
          }
        }
        offset += byteLen;
      }
    }
  }
}
