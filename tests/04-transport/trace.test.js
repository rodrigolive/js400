/**
 * Trace category enablement, hex dump, file sink, and redaction tests.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Trace } from '../../src/core/Trace.js';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

beforeEach(() => {
  Trace.reset();
});

afterEach(() => {
  Trace.reset();
});

describe('Trace', () => {
  test('isTraceOn defaults to false', () => {
    expect(Trace.isTraceOn()).toBe(false);
  });

  test('setTraceOn/isTraceOn', () => {
    Trace.setTraceOn(true);
    expect(Trace.isTraceOn()).toBe(true);
    Trace.setTraceOn(false);
    expect(Trace.isTraceOn()).toBe(false);
  });

  test('category constants are correct', () => {
    expect(Trace.DATASTREAM).toBe(0);
    expect(Trace.DIAGNOSTIC).toBe(1);
    expect(Trace.ERROR).toBe(2);
    expect(Trace.INFORMATION).toBe(3);
    expect(Trace.WARNING).toBe(4);
    expect(Trace.CONVERSION).toBe(5);
    expect(Trace.PROXY).toBe(6);
    expect(Trace.PCML).toBe(7);
    expect(Trace.JDBC).toBe(8);
  });

  test('per-category switches', () => {
    Trace.setTraceDatastreamOn(true);
    expect(Trace.isTraceDatastreamOn()).toBe(true);
    Trace.setTraceDatastreamOn(false);
    expect(Trace.isTraceDatastreamOn()).toBe(false);

    Trace.setTraceErrorOn(true);
    expect(Trace.isTraceErrorOn()).toBe(true);

    Trace.setTraceWarningOn(true);
    expect(Trace.isTraceWarningOn()).toBe(true);

    Trace.setTraceInformationOn(true);
    expect(Trace.isTraceInformationOn()).toBe(true);

    Trace.setTraceDiagnosticOn(true);
    expect(Trace.isTraceDiagnosticOn()).toBe(true);

    Trace.setTraceConversionOn(true);
    expect(Trace.isTraceConversionOn()).toBe(true);

    Trace.setTraceProxyOn(true);
    expect(Trace.isTraceProxyOn()).toBe(true);

    Trace.setTracePCMLOn(true);
    expect(Trace.isTracePCMLOn()).toBe(true);

    Trace.setTraceJDBCOn(true);
    expect(Trace.isTraceJDBCOn()).toBe(true);
  });

  test('setTraceAllOn enables all categories', () => {
    Trace.setTraceAllOn(true);
    expect(Trace.isTraceDatastreamOn()).toBe(true);
    expect(Trace.isTraceDiagnosticOn()).toBe(true);
    expect(Trace.isTraceErrorOn()).toBe(true);
    expect(Trace.isTraceInformationOn()).toBe(true);
    expect(Trace.isTraceWarningOn()).toBe(true);
    expect(Trace.isTraceConversionOn()).toBe(true);
    expect(Trace.isTraceProxyOn()).toBe(true);
    expect(Trace.isTracePCMLOn()).toBe(true);
    expect(Trace.isTraceJDBCOn()).toBe(true);
  });

  test('setTraceAllOn(false) disables all categories', () => {
    Trace.setTraceAllOn(true);
    Trace.setTraceAllOn(false);
    expect(Trace.isTraceDatastreamOn()).toBe(false);
    expect(Trace.isTraceErrorOn()).toBe(false);
  });

  test('log does nothing when traceOn is false', () => {
    const lines = [];
    Trace.setCallbackSink(line => lines.push(line));
    Trace.setTraceErrorOn(true);
    // trace is off, so log should do nothing
    Trace.log(Trace.ERROR, 'should not appear');
    expect(lines.length).toBe(0);
  });

  test('log outputs when traceOn and category are both enabled', () => {
    const lines = [];
    Trace.setCallbackSink(line => lines.push(line));
    Trace.setTraceOn(true);
    Trace.setTraceErrorOn(true);
    Trace.log(Trace.ERROR, 'test error message');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('ERROR');
    expect(lines[0]).toContain('test error message');
  });

  test('log skips disabled category', () => {
    const lines = [];
    Trace.setCallbackSink(line => lines.push(line));
    Trace.setTraceOn(true);
    Trace.setTraceErrorOn(true);
    // WARNING is not enabled
    Trace.log(Trace.WARNING, 'should not appear');
    expect(lines.length).toBe(0);
  });

  test('logHex outputs hex dump', () => {
    const lines = [];
    Trace.setCallbackSink(line => lines.push(line));
    Trace.setTraceOn(true);
    Trace.setTraceDatastreamOn(true);

    const data = Buffer.from([0x00, 0x14, 0xE0, 0x09, 0xFF]);
    Trace.logHex(Trace.DATASTREAM, 'Test buffer', data);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('DATASTREAM');
    expect(lines[0]).toContain('Test buffer');
    expect(lines[0]).toContain('5 bytes');
    expect(lines[0]).toContain('E0');
  });

  test('toHexString formats single byte', () => {
    expect(Trace.toHexString(0x00)).toBe('00');
    expect(Trace.toHexString(0xFF)).toBe('FF');
    expect(Trace.toHexString(0xAB)).toBe('AB');
    expect(Trace.toHexString(0x0D)).toBe('0D');
  });

  test('toHexDump formats buffer', () => {
    const data = Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
    const dump = Trace.toHexDump(data);
    expect(dump).toContain('48');
    expect(dump).toContain('|Hello');
  });

  test('correlation ID appears in log', () => {
    const lines = [];
    Trace.setCallbackSink(line => lines.push(line));
    Trace.setTraceOn(true);
    Trace.setTraceErrorOn(true);
    Trace.setCorrelationId('ABC-123');

    Trace.log(Trace.ERROR, 'correlated message');
    expect(lines[0]).toContain('[corr=ABC-123]');
  });

  test('secret redaction replaces password values', () => {
    const lines = [];
    Trace.setCallbackSink(line => lines.push(line));
    Trace.setTraceOn(true);
    Trace.setTraceErrorOn(true);

    Trace.log(Trace.ERROR, 'password=secretValue&user=bob');
    expect(lines[0]).toContain('***REDACTED***');
    expect(lines[0]).not.toContain('secretValue');
  });

  test('file sink writes to file', async () => {
    const filePath = join(tmpdir(), `js400-trace-test-${Date.now()}.log`);
    try {
      Trace.setFileName(filePath);
      Trace.setTraceOn(true);
      Trace.setTraceInformationOn(true);
      Trace.log(Trace.INFORMATION, 'file test message');

      // Close the file stream
      Trace.reset();

      // Give it a moment to flush
      await new Promise(r => setTimeout(r, 100));

      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('file test message');
    } finally {
      try { unlinkSync(filePath); } catch {}
    }
  });

  test('reset clears all state', () => {
    Trace.setTraceOn(true);
    Trace.setTraceAllOn(true);
    Trace.setCorrelationId('test');
    Trace.reset();

    expect(Trace.isTraceOn()).toBe(false);
    expect(Trace.isTraceErrorOn()).toBe(false);
    expect(Trace.getCorrelationId()).toBeNull();
    expect(Trace.getFileName()).toBeNull();
  });

  test('isTraceCategoryOn works with valid and invalid categories', () => {
    Trace.setTraceErrorOn(true);
    expect(Trace.isTraceCategoryOn(Trace.ERROR)).toBe(true);
    expect(Trace.isTraceCategoryOn(Trace.WARNING)).toBe(false);
    expect(Trace.isTraceCategoryOn(-1)).toBe(false);
    expect(Trace.isTraceCategoryOn(99)).toBe(false);
  });

  test('log with Error extra includes stack', () => {
    const lines = [];
    Trace.setCallbackSink(line => lines.push(line));
    Trace.setTraceOn(true);
    Trace.setTraceErrorOn(true);

    const err = new Error('boom');
    Trace.log(Trace.ERROR, 'Something failed', err);
    expect(lines[0]).toContain('boom');
  });
});
