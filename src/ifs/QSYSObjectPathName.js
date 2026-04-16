/**
 * QSYS path parser and builder.
 *
 * Provides an integrated file system path name that represents an object
 * in the QSYS library file system. Supports parsing and building paths
 * with library, object, member, type, and ASP components.
 *
 * Path formats:
 *   /QSYS.LIB/LIBRARY.LIB/OBJECT.TYPE
 *   /QSYS.LIB/LIBRARY.LIB/FILE.FILE/MEMBER.MBR
 *   /QSYS.LIB/OBJECT.TYPE                        (library = QSYS)
 *   /IASP1/QSYS.LIB/LIBRARY.LIB/OBJECT.TYPE     (with ASP prefix)
 *
 * Special values use percent delimiters in IFS paths:
 *   *LIBL   -> %LIBL%      *CURLIB  -> %CURLIB%
 *   *ALL    -> %ALL%       *ALLUSR  -> %ALLUSR%
 *   *USRLIBL -> %USRLIBL%  *FIRST   -> %FIRST%
 *   *LAST   -> %LAST%      *FILE    -> %FILE%
 *   *NONE   -> %NONE%
 *
 * Upstream: QSYSObjectPathName.java
 * @module ifs/QSYSObjectPathName
 */

const LIBRARY_SPECIALS = {
  '*LIBL': '%LIBL%',
  '*CURLIB': '%CURLIB%',
  '*USRLIBL': '%USRLIBL%',
  '*ALL': '%ALL%',
  '*ALLUSR': '%ALLUSR%',
};

const LIBRARY_SPECIALS_REV = {
  '%LIBL%': '*LIBL',
  '%CURLIB%': '*CURLIB',
  '%USRLIBL%': '*USRLIBL',
  '%ALL%': '*ALL',
  '%ALLUSR%': '*ALLUSR',
};

const MEMBER_SPECIALS_REV = {
  '%FIRST%': '*FIRST',
  '%LAST%': '*LAST',
  '%FILE%': '*FILE',
  '%ALL%': '*ALL',
  '%NONE%': '*NONE',
};

const MEMBER_SPECIALS = {
  '*FIRST': '%FIRST%',
  '*LAST': '%LAST%',
  '*FILE': '%FILE%',
  '*ALL': '%ALL%',
  '*NONE': '%NONE%',
};

/**
 * Selectively uppercase a QSYS name, preserving case inside double-quotes.
 * @param {string} name
 * @returns {string}
 */
function toQSYSName(name) {
  if (!name.includes('"')) {
    return name.toUpperCase();
  }
  let result = '';
  let inQuotes = false;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (inQuotes) {
      result += ch;
    } else {
      result += ch.toUpperCase();
    }
  }
  return result;
}

function convertLibraryName(name) {
  return LIBRARY_SPECIALS[name] ?? name;
}

function convertObjectName(name) {
  if (name === '*ALL') return '%ALL%';
  return name;
}

function convertMemberName(name) {
  return MEMBER_SPECIALS[name] ?? name;
}

function buildPathName(aspName, libraryName, objectName, memberName, objectType) {
  if (!libraryName || !objectType) return '';
  if (objectType === 'MBR' && !memberName) return '';

  let result = '';
  if (aspName) {
    result += '/' + aspName;
  }
  result += '/QSYS.LIB';

  if (libraryName !== 'QSYS') {
    result += '/' + convertLibraryName(libraryName) + '.LIB';
  }

  if (objectName) {
    result += '/' + convertObjectName(objectName);
    if (memberName) {
      result += '.FILE/' + convertMemberName(memberName) + '.MBR';
    } else {
      result += '.' + objectType;
    }
  }

  return result;
}

export class QSYSObjectPathName {
  #path = '';
  #libraryName = '';
  #objectName = '';
  #memberName = '';
  #objectType = '';
  #aspName = '';

  /**
   * Construct a QSYSObjectPathName.
   *
   * Signatures:
   *   new QSYSObjectPathName(path)
   *   new QSYSObjectPathName(library, object, type)
   *   new QSYSObjectPathName(library, object, member, 'MBR')
   *   new QSYSObjectPathName(asp, library, object, member, 'MBR')
   *
   * @param {...string} args
   */
  constructor(...args) {
    if (args.length === 0) return;

    if (args.length === 1) {
      this.#parse(args[0]);
      return;
    }

    if (args.length === 3) {
      const [lib, obj, type] = args;
      this.#validateName(lib, 'libraryName', 10);
      this.#validateName(obj, 'objectName', 10);
      this.#validateName(type, 'objectType', 6);
      this.#libraryName = toQSYSName(lib);
      this.#objectName = toQSYSName(obj);
      this.#objectType = type.toUpperCase();
      this.#path = buildPathName('', this.#libraryName, this.#objectName, '', this.#objectType);
      return;
    }

    if (args.length === 4) {
      const [lib, obj, mbr, type] = args;
      this.#validateName(lib, 'libraryName', 10);
      this.#validateName(obj, 'objectName', 10);
      this.#validateName(mbr, 'memberName', 10);
      if (type.toUpperCase() !== 'MBR') {
        throw new Error(`objectType must be 'MBR' when memberName is specified, got '${type}'`);
      }
      this.#libraryName = toQSYSName(lib);
      this.#objectName = toQSYSName(obj);
      this.#memberName = toQSYSName(mbr);
      this.#objectType = 'MBR';
      this.#path = buildPathName('', this.#libraryName, this.#objectName, this.#memberName, 'MBR');
      return;
    }

    if (args.length === 5) {
      const [asp, lib, obj, mbr, type] = args;
      this.#validateName(asp, 'aspName', 10);
      this.#validateName(lib, 'libraryName', 10);
      this.#validateName(obj, 'objectName', 10);
      this.#validateName(mbr, 'memberName', 10);
      if (type.toUpperCase() !== 'MBR') {
        throw new Error(`objectType must be 'MBR' when memberName is specified, got '${type}'`);
      }
      this.#aspName = asp;
      this.#libraryName = toQSYSName(lib);
      this.#objectName = toQSYSName(obj);
      this.#memberName = toQSYSName(mbr);
      this.#objectType = 'MBR';
      this.#path = buildPathName(this.#aspName, this.#libraryName, this.#objectName, this.#memberName, 'MBR');
      return;
    }

    throw new Error(`Invalid argument count: ${args.length}`);
  }

  get path() { return this.#path; }
  get library() { return this.#libraryName; }
  get object() { return this.#objectName; }
  get member() { return this.#memberName; }
  get objectType() { return this.#objectType; }
  get aspName() { return this.#aspName; }

  getPath() { return this.#path; }
  getLibraryName() { return this.#libraryName; }
  getObjectName() { return this.#objectName; }
  getMemberName() { return this.#memberName; }
  getObjectType() { return this.#objectType; }
  getAspName() { return this.#aspName; }

  /**
   * Parse a full IFS path into its components.
   * Static convenience method.
   *
   * @param {string} path
   * @returns {{ library: string, object: string, member: string, objectType: string, aspName: string, path: string }}
   */
  static parse(path) {
    const p = new QSYSObjectPathName(path);
    return {
      library: p.library,
      object: p.object,
      member: p.member,
      objectType: p.objectType,
      aspName: p.aspName,
      path: p.path,
    };
  }

  /**
   * Build a QSYS IFS path from components.
   *
   * @param {string} library
   * @param {string} object
   * @param {string} type
   * @returns {string}
   */
  static toPath(library, object, type) {
    const lib = toQSYSName(library);
    const obj = toQSYSName(object);
    const t = type.toUpperCase();
    return buildPathName('', lib, obj, '', t);
  }

  /**
   * Build a QSYS IFS member path from components.
   *
   * @param {string} library
   * @param {string} object
   * @param {string} member
   * @param {string} type - Must be 'MBR'
   * @returns {string}
   */
  static toMemberPath(library, object, member, type = 'MBR') {
    const lib = toQSYSName(library);
    const obj = toQSYSName(object);
    const mbr = toQSYSName(member);
    return buildPathName('', lib, obj, mbr, type.toUpperCase());
  }

  toString() {
    return this.#path;
  }

  #validateName(value, paramName, maxLen) {
    if (typeof value !== 'string' || value.length < 1 || value.length > maxLen) {
      throw new Error(`${paramName} must be 1-${maxLen} characters, got '${value}'`);
    }
  }

  #parse(path) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('path must be a non-empty string');
    }

    const upperPath = toQSYSName(path);

    const qsysIdx = upperPath.indexOf('/QSYS.LIB');
    if (qsysIdx === -1) {
      throw new Error(`Path does not contain '/QSYS.LIB': ${path}`);
    }

    if (qsysIdx > 0) {
      this.#aspName = upperPath.substring(1, qsysIdx);
    }

    const afterQsys = upperPath.substring(qsysIdx);
    if (afterQsys === '/QSYS.LIB' || afterQsys === '/QSYS.LIB/') {
      this.#libraryName = 'QSYS';
      this.#objectType = 'LIB';
      this.#path = buildPathName(this.#aspName, this.#libraryName, this.#objectName, this.#memberName, this.#objectType);
      return;
    }

    let currentOffset = qsysIdx + 10;
    if (upperPath[currentOffset] === '/') currentOffset++;

    const libSuffix = upperPath.indexOf('.LIB/', currentOffset);
    if (libSuffix > currentOffset) {
      this.#libraryName = upperPath.substring(currentOffset, libSuffix);
      if (this.#libraryName === 'QSYS') {
        throw new Error(`Object in library QSYS specified incorrectly: ${path}`);
      }
      if (this.#libraryName.startsWith('%')) {
        this.#libraryName = LIBRARY_SPECIALS_REV[this.#libraryName] ?? this.#libraryName;
      }
      currentOffset = libSuffix + 5;
    } else {
      this.#libraryName = 'QSYS';
    }

    if (this.#libraryName.length > 10) {
      throw new Error(`Library name too long: ${this.#libraryName}`);
    }

    const lastDot = upperPath.lastIndexOf('.');
    if (lastDot < currentOffset || upperPath.length - lastDot - 1 > 6) {
      throw new Error(`Invalid object type in path: ${path}`);
    }
    this.#objectType = upperPath.substring(lastDot + 1);

    let objectEnd = lastDot;

    if (this.#objectType === 'MBR') {
      const fileIdx = upperPath.lastIndexOf('.FILE/', lastDot);
      if (fileIdx === -1 || fileIdx < currentOffset) {
        throw new Error(`Member not contained in a file: ${path}`);
      }
      const memberStart = fileIdx + 6;
      if (lastDot < memberStart || lastDot - memberStart > 10) {
        throw new Error(`Invalid member name length in path: ${path}`);
      }
      this.#memberName = upperPath.substring(memberStart, lastDot);
      if (this.#memberName.startsWith('%')) {
        this.#memberName = MEMBER_SPECIALS_REV[this.#memberName] ?? this.#memberName;
      }
      objectEnd = fileIdx;
    }

    if (objectEnd < currentOffset || objectEnd - currentOffset > 10) {
      throw new Error(`Invalid object name length in path: ${path}`);
    }
    this.#objectName = upperPath.substring(currentOffset, objectEnd);
    if (this.#objectName === '%ALL%') this.#objectName = '*ALL';

    this.#path = buildPathName(this.#aspName, this.#libraryName, this.#objectName, this.#memberName, this.#objectType);
  }
}
