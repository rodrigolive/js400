/**
 * Date/time conversion helper.
 *
 * Provides utilities for converting between JS Date objects
 * and IBM i date/time string formats.
 *
 * Upstream: AS400DateTimeConverter.java, AS400Calendar.java
 * @module datatypes/datetime/AS400DateTimeConverter
 */

export class AS400DateTimeConverter {
  static dateToIso(date) {
    if (!(date instanceof Date)) {
      throw new Error('Expected a Date object');
    }
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  static timeToIso(date) {
    if (!(date instanceof Date)) {
      throw new Error('Expected a Date object');
    }
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${h}.${mi}.${s}`;
  }

  static toTimestamp(date) {
    if (!(date instanceof Date)) {
      throw new Error('Expected a Date object');
    }
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    const us = String(date.getMilliseconds() * 1000).padStart(6, '0');
    return `${y}-${mo}-${d}-${h}.${mi}.${s}.${us}`;
  }

  static parseIsoDate(str) {
    const parts = str.split('-');
    if (parts.length !== 3) throw new Error(`Invalid ISO date: ${str}`);
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  }

  static parseTimestamp(str) {
    const dateStr = str.substring(0, 10);
    const timeStr = str.substring(11);
    const dateParts = dateStr.split('-');
    const timeParts = timeStr.split('.');

    const y = parseInt(dateParts[0]);
    const mo = parseInt(dateParts[1]) - 1;
    const d = parseInt(dateParts[2]);
    const h = parseInt(timeParts[0]) || 0;
    const mi = parseInt(timeParts[1]) || 0;
    const s = parseInt(timeParts[2]) || 0;
    const us = parseInt(timeParts[3]) || 0;

    const dt = new Date(y, mo, d, h, mi, s, Math.floor(us / 1000));
    return dt;
  }
}
