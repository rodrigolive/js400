/**
 * Tests for LOB wrappers (Blob, Clob, SQLXML).
 */
import { describe, test, expect } from 'bun:test';
import { Blob } from '../../src/db/lob/Blob.js';
import { Clob } from '../../src/db/lob/Clob.js';
import { SQLXML } from '../../src/db/lob/SQLXML.js';

describe('Blob', () => {
  test('from() creates Blob from Buffer', () => {
    const blob = Blob.from(Buffer.from('hello'));
    expect(blob.length).toBe(5);
  });

  test('from() creates Blob from Uint8Array', () => {
    const blob = Blob.from(new Uint8Array([1, 2, 3, 4]));
    expect(blob.length).toBe(4);
  });

  test('toBuffer() returns data', async () => {
    const blob = Blob.from(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
    const buf = await blob.toBuffer();
    expect(buf[0]).toBe(0xDE);
    expect(buf[3]).toBe(0xEF);
    expect(buf.length).toBe(4);
  });

  test('toUint8Array() returns Uint8Array', async () => {
    const blob = Blob.from(Buffer.from([1, 2, 3]));
    const arr = await blob.toUint8Array();
    expect(arr instanceof Uint8Array).toBe(true);
    expect(arr[0]).toBe(1);
    expect(arr.length).toBe(3);
  });

  test('read() with offset and length', async () => {
    const blob = Blob.from(Buffer.from('abcdefgh'));
    const chunk = await blob.read(2, 3);
    expect(chunk.toString()).toBe('cde');
  });

  test('read() from offset to end', async () => {
    const blob = Blob.from(Buffer.from('abcdefgh'));
    const chunk = await blob.read(5);
    expect(chunk.toString()).toBe('fgh');
  });

  test('getReadableStream() produces all data', async () => {
    const blob = Blob.from(Buffer.from('stream test data'));
    const stream = blob.getReadableStream({ chunkSize: 4 });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const result = Buffer.concat(chunks).toString();
    expect(result).toBe('stream test data');
  });

  test('empty Blob', async () => {
    const blob = new Blob({});
    expect(blob.length).toBe(0);
    const buf = await blob.toBuffer();
    expect(buf.length).toBe(0);
  });

  test('free() with no lobHandle is a no-op', async () => {
    const blob = Blob.from(Buffer.from('test'));
    await blob.free(); // should not throw
  });

  test('Blob backed by LobHandle', async () => {
    const mockHandle = {
      isFreed: false,
      length: 6,
      async readAll() { return Buffer.from('lobdat'); },
      async read(offset, len) { return Buffer.from('lobdat').subarray(offset, offset + (len || 6)); },
      async free() { this.isFreed = true; },
    };

    const blob = new Blob({ lobHandle: mockHandle, length: 6 });
    expect(blob.length).toBe(6);

    const buf = await blob.toBuffer();
    expect(buf.toString()).toBe('lobdat');

    const chunk = await blob.read(0, 3);
    expect(chunk.toString()).toBe('lob');

    await blob.free();
    expect(mockHandle.isFreed).toBe(true);
  });
});

describe('Clob', () => {
  test('from() creates Clob from string', () => {
    const clob = Clob.from('hello world');
    expect(clob.length).toBe(11);
  });

  test('text() returns string content', async () => {
    const clob = Clob.from('hello');
    const text = await clob.text();
    expect(text).toBe('hello');
  });

  test('toString() aliases text()', async () => {
    const clob = Clob.from('hello');
    const text = await clob.toString();
    expect(text).toBe('hello');
  });

  test('substring() returns portion of text', async () => {
    const clob = Clob.from('hello world');
    expect(await clob.substring(6)).toBe('world');
    expect(await clob.substring(0, 5)).toBe('hello');
  });

  test('toBuffer() converts to Buffer', async () => {
    const clob = Clob.from('ABC');
    const buf = await clob.toBuffer();
    expect(buf.toString('utf8')).toBe('ABC');
  });

  test('getReadableStream() produces string data', async () => {
    const clob = Clob.from('stream clob test');
    const stream = clob.getReadableStream({ chunkSize: 5 });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('stream clob test');
  });

  test('empty Clob', async () => {
    const clob = new Clob({});
    expect(clob.length).toBe(0);
    const text = await clob.text();
    expect(text).toBe('');
  });

  test('Clob backed by LobHandle', async () => {
    const mockHandle = {
      isFreed: false,
      async readAll() { return Buffer.from('lob text data', 'utf8'); },
      async free() { this.isFreed = true; },
    };

    const clob = new Clob({ lobHandle: mockHandle, length: 13 });
    const text = await clob.text();
    expect(text).toBe('lob text data');

    await clob.free();
    expect(mockHandle.isFreed).toBe(true);
  });
});

describe('SQLXML', () => {
  test('from() creates SQLXML from string', () => {
    const xml = SQLXML.from('<root><item>test</item></root>');
    expect(xml.length).toBe(30);
  });

  test('text() returns XML string', async () => {
    const xml = SQLXML.from('<doc/>');
    expect(await xml.text()).toBe('<doc/>');
  });

  test('getString() aliases text()', async () => {
    const xml = SQLXML.from('<doc/>');
    expect(await xml.getString()).toBe('<doc/>');
  });

  test('toBuffer() returns buffer', async () => {
    const xml = SQLXML.from('<x/>');
    const buf = await xml.toBuffer();
    expect(buf.toString()).toBe('<x/>');
  });

  test('getReadableStream() produces data', async () => {
    const xml = SQLXML.from('<stream/>');
    const stream = xml.getReadableStream();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('<stream/>');
  });

  test('free() is safe on data-backed SQLXML', async () => {
    const xml = SQLXML.from('<test/>');
    await xml.free(); // should not throw
  });
});
