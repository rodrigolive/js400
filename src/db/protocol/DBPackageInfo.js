/**
 * SQL package-info decoding.
 *
 * Decodes the DB2 for i package blob returned in reply code point 0x380B
 * during FUNCTIONID_RETURN_PACKAGE. Mirrors JTOpen DBReplyPackageInfo and
 * reuses existing descriptor parsers so the skip-prepare path can populate
 * statement metadata without a live PREPARE_AND_DESCRIBE round trip.
 *
 * Upstream:
 *   - DBReplyPackageInfo.java
 *   - JDPackageManager.java
 *
 * @module db/protocol/DBPackageInfo
 */

import { CharConverter } from '../../ccsid/CharConverter.js';
import { parseBasicDataFormat, parseSuperExtendedDataFormat } from './DBDescriptors.js';
import { getCodePointData } from './DBReplyDS.js';

const PACKAGE_INFO_CP = 0x380B;
const ENTRY_OFFSET = 42;
const ENTRY_SIZE = 64;

export function parsePackageInfo(replyOrBuffer, { serverCCSID = 37 } = {}) {
  const packageData = Buffer.isBuffer(replyOrBuffer)
    ? replyOrBuffer
    : getCodePointData(replyOrBuffer, PACKAGE_INFO_CP);
  if (!packageData || packageData.length < ENTRY_OFFSET) return null;

  const packageInfoOffset = 6;
  const packageInfoAbsoluteBase = packageInfoOffset - 6;
  const totalLength = packageData.readInt32BE(0);
  const packageCCSID = packageData.readUInt16BE(4);
  const defaultCollection = decodeBytes(packageData, 6, 18, packageCCSID).trimEnd();
  const statementCount = packageData.readUInt16BE(24);

  const entries = [];
  for (let i = 0; i < statementCount; i++) {
    const entryOffset = ENTRY_OFFSET + (ENTRY_SIZE * i);
    if (entryOffset + ENTRY_SIZE > packageData.length) break;

    const statementName = decodeStatementName(packageData, entryOffset + 3, serverCCSID);
    const textOffset = packageData.readInt32BE(entryOffset + 48);
    const textLength = packageData.readInt32BE(entryOffset + 52);
    const resultFormatOffset = packageData.readInt32BE(entryOffset + 40);
    const resultFormatLength = packageData.readInt32BE(entryOffset + 44);
    const parameterFormatOffset = packageData.readInt32BE(entryOffset + 56);
    const parameterFormatLength = packageData.readInt32BE(entryOffset + 60);

    const statementText = decodeStatementText(
      packageData,
      packageInfoAbsoluteBase + textOffset,
      textLength,
      packageCCSID,
    );

    entries.push({
      index: i,
      needsDefaultCollection: packageData[entryOffset],
      statementType: packageData.readUInt16BE(entryOffset + 1),
      statementName,
      statementText,
      statementTextLength: textLength,
      resultDataFormat: parseEmbeddedFormat(
        packageData,
        packageInfoAbsoluteBase + resultFormatOffset,
        resultFormatLength,
      ),
      parameterMarkerFormat: parseEmbeddedFormat(
        packageData,
        packageInfoAbsoluteBase + parameterFormatOffset,
        parameterFormatLength,
      ),
    });
  }

  return {
    totalLength,
    packageCCSID,
    defaultCollection,
    statementCount,
    entries,
  };
}

function parseEmbeddedFormat(buf, absoluteOffset, length) {
  if (length === 0 || length === 6) return null;
  if (absoluteOffset < 0 || absoluteOffset + length > buf.length) return null;
  const slice = buf.subarray(absoluteOffset, absoluteOffset + length);
  if (slice.length < 8) return null;
  if (slice.length >= 16) {
    const numFields = slice.readInt32BE(4);
    if (numFields >= 0 && 16 + (48 * numFields) <= slice.length) {
      return parseSuperExtendedDataFormat(slice);
    }
  }
  return parseBasicDataFormat(slice);
}

function decodeStatementText(buf, offset, length, ccsid) {
  if (length <= 0 || offset < 0 || offset + length > buf.length) return '';
  return decodeBytes(buf, offset, length, ccsid);
}

function decodeStatementName(buf, offset, ccsid) {
  try {
    return decodeBytes(buf, offset, 18, ccsid).trimEnd();
  } catch {
    return '';
  }
}

function decodeBytes(buf, offset, length, ccsid) {
  if (ccsid === 13488 || ccsid === 1200 || ccsid === 61952) {
    return decodeUtf16BE(buf.subarray(offset, offset + length));
  }
  if (ccsid === 1208) {
    return buf.toString('utf8', offset, offset + length);
  }
  try {
    return CharConverter.byteArrayToString(buf, offset, length, ccsid);
  } catch {
    return buf.toString('latin1', offset, offset + length);
  }
}

function decodeUtf16BE(buf) {
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out += String.fromCharCode(buf.readUInt16BE(i));
  }
  return out;
}
