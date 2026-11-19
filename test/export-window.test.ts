import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextExportWindow } from '../src/state/export-window.js';

test('first import leaves the start open', () => {
  assert.deepEqual(nextExportWindow(undefined), { from: null });
});

test('uses three calendar days of overlap by default, including leap day', () => {
  assert.deepEqual(nextExportWindow('2024-03-02'), { from: '2024-02-28' });
});

test('supports a custom overlap across years and a zero overlap', () => {
  assert.deepEqual(nextExportWindow('2025-01-01', 2), { from: '2024-12-30' });
  assert.deepEqual(nextExportWindow('2025-01-01', 0), { from: '2025-01-01' });
});

test('rejects invalid dates and overlaps', () => {
  for (const date of ['2025-02-29', '2024-2-01', '2024-01-01T00:00:00Z']) {
    assert.throws(() => nextExportWindow(date), RangeError);
  }
  for (const overlap of [-1, 0.5, Infinity]) {
    assert.throws(() => nextExportWindow(undefined, overlap), RangeError);
  }
});

test('clamps the window to the earliest four-digit year', () => {
  assert.deepEqual(nextExportWindow('0000-01-02'), { from: '0000-01-01' });
});
