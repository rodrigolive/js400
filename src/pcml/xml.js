/**
 * Minimal XML tokenizer for PCML parsing.
 *
 * Zero-dependency SAX-style parser sufficient for PCML/XPCML.
 * Handles: elements, attributes, comments, CDATA, processing instructions.
 * Does not handle: namespaces, DTD validation, entities beyond basics.
 *
 * Upstream: internal
 * @module pcml/xml
 */

/**
 * @typedef {object} XmlElement
 * @property {string} tag
 * @property {Record<string, string>} attrs
 * @property {XmlElement[]} children
 * @property {string} text
 */

/**
 * Parse an XML string into a simple DOM tree.
 *
 * @param {string|Buffer} source
 * @returns {XmlElement} Root element
 */
export function parseXml(source) {
  const xml = typeof source === 'string' ? source : source.toString('utf-8');
  const len = xml.length;
  let pos = 0;

  function skipWhitespace() {
    while (pos < len && (xml[pos] === ' ' || xml[pos] === '\t' || xml[pos] === '\n' || xml[pos] === '\r')) {
      pos++;
    }
  }

  function readUntil(terminator) {
    const start = pos;
    const idx = xml.indexOf(terminator, pos);
    if (idx === -1) {
      pos = len;
      return xml.slice(start);
    }
    pos = idx;
    return xml.slice(start, idx);
  }

  function parseAttributes() {
    const attrs = {};
    while (pos < len) {
      skipWhitespace();
      if (pos >= len || xml[pos] === '>' || xml[pos] === '/' || xml[pos] === '?') break;

      // Attribute name
      const nameStart = pos;
      while (pos < len && xml[pos] !== '=' && xml[pos] !== ' ' && xml[pos] !== '>' && xml[pos] !== '/') {
        pos++;
      }
      const name = xml.slice(nameStart, pos).trim();
      if (!name) break;

      skipWhitespace();
      if (pos < len && xml[pos] === '=') {
        pos++; // skip '='
        skipWhitespace();
        if (pos < len && (xml[pos] === '"' || xml[pos] === "'")) {
          const quote = xml[pos];
          pos++;
          const valStart = pos;
          while (pos < len && xml[pos] !== quote) pos++;
          attrs[name] = decodeEntities(xml.slice(valStart, pos));
          if (pos < len) pos++; // skip closing quote
        }
      }
    }
    return attrs;
  }

  function parseElement() {
    skipWhitespace();
    if (pos >= len || xml[pos] !== '<') return null;

    // Skip comments, CDATA, processing instructions, XML declaration
    while (pos < len && xml[pos] === '<') {
      if (xml.startsWith('<!--', pos)) {
        pos += 4;
        readUntil('-->');
        pos += 3;
        skipWhitespace();
        continue;
      }
      if (xml.startsWith('<![CDATA[', pos)) {
        pos += 9;
        const data = readUntil(']]>');
        pos += 3;
        return { tag: '#cdata', attrs: {}, children: [], text: data };
      }
      if (xml.startsWith('<?', pos)) {
        pos += 2;
        readUntil('?>');
        pos += 2;
        skipWhitespace();
        continue;
      }
      if (xml.startsWith('<!', pos)) {
        pos += 2;
        readUntil('>');
        pos += 1;
        skipWhitespace();
        continue;
      }
      break;
    }

    if (pos >= len || xml[pos] !== '<') return null;

    pos++; // skip '<'

    // Closing tag
    if (xml[pos] === '/') return null;

    // Read tag name
    const tagStart = pos;
    while (pos < len && xml[pos] !== ' ' && xml[pos] !== '>' && xml[pos] !== '/' && xml[pos] !== '\t' && xml[pos] !== '\n' && xml[pos] !== '\r') {
      pos++;
    }
    const tag = xml.slice(tagStart, pos);

    const attrs = parseAttributes();
    skipWhitespace();

    // Self-closing tag
    if (pos < len && xml[pos] === '/') {
      pos++; // skip '/'
      if (pos < len && xml[pos] === '>') pos++; // skip '>'
      return { tag, attrs, children: [], text: '' };
    }

    if (pos < len && xml[pos] === '>') pos++; // skip '>'

    // Parse children and text content
    const children = [];
    let text = '';

    while (pos < len) {
      skipWhitespace();
      if (pos >= len) break;

      if (xml[pos] === '<') {
        // Check for closing tag
        if (xml[pos + 1] === '/') {
          // Closing tag — read past it
          pos += 2;
          readUntil('>');
          pos++; // skip '>'
          break;
        }

        // Check for comment
        if (xml.startsWith('<!--', pos)) {
          pos += 4;
          readUntil('-->');
          pos += 3;
          continue;
        }

        const child = parseElement();
        if (child) {
          children.push(child);
        }
      } else {
        // Text content
        const t = readUntil('<');
        text += decodeEntities(t);
      }
    }

    return { tag, attrs, children, text: text.trim() };
  }

  // Find the first element (skip prologs, comments, etc.)
  const root = parseElement();
  if (!root) {
    throw new Error('No root element found in XML');
  }
  return root;
}

/**
 * Decode basic XML entities.
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
  if (!str.includes('&')) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * Legacy export name for backward compatibility with pcml/index.js
 */
export const tokenizeXml = parseXml;
