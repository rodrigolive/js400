/**
 * Run-Length Encoding (RLE) datastream compression.
 *
 * Compresses and decompresses IBM i database datastreams using the
 * proprietary RLE format. Used to shrink large INSERT/UPDATE requests
 * (the parameter marker data region in particular) and the result-set
 * reply blocks, which are frequently padded with repeating EBCDIC
 * spaces (0x40 0x40) and zero bytes.
 *
 * Wire format (matches LIPI spec; see JTOpen DataStreamCompression.java):
 *
 *   - Escape record (2 bytes):
 *       1B 1B               -> single literal 0x1B byte
 *
 *   - Repeater record (5 bytes):
 *       1B <b1> <b2> <ct_hi> <ct_lo>
 *                           -> the pair (b1,b2) repeated `count` times
 *                              (2 * count bytes total)
 *
 *   - Anything else copies verbatim.
 *
 * The algorithm scans source bytes. When it encounters an escape byte
 * it emits an escape record. Otherwise it looks at the next two bytes
 * as a "pair" and counts consecutive identical pairs. If the pair
 * repeats five or more times (10+ bytes), it emits a repeater record;
 * otherwise the bytes are copied literally.
 *
 * The output is never compressed if it would be larger than the input;
 * in that case compressRLE returns -1 so the caller can fall back to
 * uncompressed.
 *
 * Upstream: DataStreamCompression.java
 * @module db/compression/rle
 */

/** Default escape byte (marks compression records). */
export const DEFAULT_ESCAPE = 0x1B;

/** Minimum packet size at which compression is worth attempting. */
export const RLE_THRESHOLD = 1064;

/** Minimum savings (bytes) below which compressed output is rejected. */
export const MIN_SAVINGS_BYTES = 512;

/** Minimum savings (percent) below which compressed output is rejected. */
export const MIN_SAVINGS_PERCENT = 10;

const ESCAPE_SIZE = 1;
const REPEATER_SIZE = 2;
const COUNT_SIZE = 2;
const REPEATER_RECORD_SIZE = ESCAPE_SIZE + REPEATER_SIZE + COUNT_SIZE; // 5
const ESCAPE_RECORD_SIZE = ESCAPE_SIZE + ESCAPE_SIZE;                 // 2
/** Minimum uncompressed length at which a repeater record is preferred (2 * 5). */
const MIN_REPEAT_LEN = REPEATER_RECORD_SIZE * 2; // 10

/**
 * Compress a range of bytes into `destination` using RLE.
 *
 * Returns the number of bytes written. If the compressed form would be
 * larger than the source (or `destination` overflows), returns -1 and
 * the partial contents of `destination` must be discarded.
 *
 * @param {Buffer|Uint8Array} source
 * @param {number} sourceOffset - first byte of source range
 * @param {number} length - number of bytes to compress
 * @param {Buffer|Uint8Array} destination
 * @param {number} destinationOffset - first byte of destination range
 * @param {number} [escape=0x1B]
 * @returns {number} compressed byte count, or -1 if not beneficial
 */
export function compressRLE(source, sourceOffset, length, destination, destinationOffset, escape = DEFAULT_ESCAPE) {
  if (!source) throw new TypeError('source is required');
  if (!destination) throw new TypeError('destination is required');
  if (length <= 0) return -1;

  const srcEnd = sourceOffset + length;
  const dstEnd = destination.length;

  let i = sourceOffset;
  let j = destinationOffset;
  let overflow = false;

  while (i < srcEnd && !overflow) {
    const b = source[i];

    if (b === escape) {
      // Emit an escape record (two escape bytes) for the literal 0x1B.
      if (j + ESCAPE_RECORD_SIZE <= dstEnd) {
        destination[j++] = escape;
        destination[j++] = escape;
        i++;
      } else {
        overflow = true;
      }
      continue;
    }

    // Last byte (odd tail): just copy.
    if (i + 1 >= srcEnd) {
      if (j < dstEnd) {
        destination[j++] = source[i++];
      } else {
        overflow = true;
      }
      continue;
    }

    // If the next byte is an escape, copy b literally, then emit the
    // escape record, then advance past the escape byte.
    if (source[i + 1] === escape) {
      if (j + 1 + ESCAPE_RECORD_SIZE <= dstEnd) {
        destination[j++] = source[i++];
        destination[j++] = escape;
        destination[j++] = escape;
        i++;
      } else {
        overflow = true;
      }
      continue;
    }

    // We have at least two non-escape bytes. Count how many times the
    // pair (b, source[i+1]) repeats.
    const saveOffset = i;
    const b1 = source[i];
    const b2 = source[i + 1];
    let count = 1;
    i += 2;
    while (i + 1 < srcEnd
        && source[i] === b1
        && source[i + 1] === b2
        && count < 0xFFFF) {
      count++;
      i += 2;
    }
    const repeatLen = count * REPEATER_SIZE;

    if (repeatLen >= MIN_REPEAT_LEN) {
      // Worth a repeater record.
      if (j + REPEATER_RECORD_SIZE <= dstEnd) {
        destination[j] = escape;
        destination[j + 1] = b1;
        destination[j + 2] = b2;
        destination[j + 3] = (count >>> 8) & 0xFF;
        destination[j + 4] = count & 0xFF;
        j += REPEATER_RECORD_SIZE;
      } else {
        overflow = true;
      }
    } else {
      // Not worth encoding; copy the pairs verbatim. Reset i to the
      // saved offset and copy repeatLen bytes.
      if (j + repeatLen <= dstEnd) {
        i = saveOffset;
        const end = j + repeatLen;
        while (j < end) {
          destination[j++] = source[i++];
        }
      } else {
        overflow = true;
      }
    }
  }

  const written = j - destinationOffset;
  if (overflow || written >= length) {
    return -1;
  }
  return written;
}

/**
 * Decompress a range of RLE-encoded bytes into `destination`.
 *
 * The caller is expected to know the exact decompressed length (read
 * from the 0x3832 code point header on the wire) and pre-allocate
 * `destination` accordingly.
 *
 * @param {Buffer|Uint8Array} source
 * @param {number} sourceOffset
 * @param {number} length - number of compressed bytes to consume
 * @param {Buffer|Uint8Array} destination
 * @param {number} destinationOffset
 * @param {number} [escape=0x1B]
 * @returns {number} number of decompressed bytes written
 */
export function decompressRLE(source, sourceOffset, length, destination, destinationOffset, escape = DEFAULT_ESCAPE) {
  if (!source) throw new TypeError('source is required');
  if (!destination) throw new TypeError('destination is required');
  if (length <= 0) return 0;

  const srcEnd = sourceOffset + length;
  const dstEnd = destination.length;

  let i = sourceOffset;
  let j = destinationOffset;

  while (i < srcEnd) {
    const b = source[i];

    if (b === escape) {
      if (i + ESCAPE_SIZE >= srcEnd) {
        throw new Error('RLE: incomplete escape record before EOD');
      }

      if (source[i + ESCAPE_SIZE] === escape) {
        // Escape record -> literal 0x1B byte.
        if (j >= dstEnd) {
          throw new Error('RLE: destination overflow during escape record');
        }
        destination[j++] = escape;
        i += ESCAPE_RECORD_SIZE;
        continue;
      }

      // Repeater record: 1B b1 b2 ct_hi ct_lo
      if (i + REPEATER_SIZE + COUNT_SIZE >= srcEnd) {
        throw new Error('RLE: incomplete repeater record before EOD');
      }
      const b1 = source[i + 1];
      const b2 = source[i + 2];
      const count = ((source[i + 3] & 0xFF) << 8) | (source[i + 4] & 0xFF);
      const totalBytes = count * REPEATER_SIZE;
      if (j + totalBytes > dstEnd) {
        throw new Error(`RLE: destination overflow during repeater (need ${totalBytes}, have ${dstEnd - j})`);
      }
      if (b1 === 0 && b2 === 0) {
        // Assume destination was zero-filled at allocation (Buffer.alloc
        // or a buffer we just cleared). Just bump j.
        j += totalBytes;
      } else {
        const end = j + totalBytes;
        while (j < end) {
          destination[j] = b1;
          destination[j + 1] = b2;
          j += REPEATER_SIZE;
        }
      }
      i += REPEATER_RECORD_SIZE;
      continue;
    }

    // Literal byte.
    if (j >= dstEnd) {
      throw new Error('RLE: destination overflow during literal copy');
    }
    destination[j++] = source[i++];
  }

  return j - destinationOffset;
}
