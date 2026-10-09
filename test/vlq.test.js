// Base64 VLQ (milestone 5). Vectors are checked against the expected strings
// and, independently, against Node's built-in source map decoder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceMap } from 'node:module';
import { encodeVLQ, decodeVLQ, VLQ_MAX } from '../src/vlq.js';

const VECTORS = [
  [0, 'A'], [1, 'C'], [-1, 'D'], [2, 'E'], [-5, 'L'], [15, 'e'], [-15, 'f'],
  [16, 'gB'], [-16, 'hB'], [31, '+B'], [32, 'gC'], [123, '2H'], [511, '+f'], [512, 'ggB'],
  [1000, 'w+B'], [-1000, 'x+B'], [VLQ_MAX, '+/////D'], [-VLQ_MAX, '//////D'],
];

test('encodes the test vectors', () => {
  for (const [n, s] of VECTORS) assert.equal(encodeVLQ(n), s, `encode ${n}`);
});

test('decodes the test vectors', () => {
  for (const [n, s] of VECTORS) assert.deepEqual(decodeVLQ(s), { value: n, next: s.length }, `decode ${s}`);
});

// Node's decoder reads the vector as the original-column delta of a second
// segment whose predecessor sits at original column 2000, so negative values
// can be checked too.
test('Node\'s independent decoder reads the vectors the same way', () => {
  for (const [n, s] of VECTORS) {
    if (Math.abs(n) > 2000) continue;
    const map = new SourceMap({ version: 3, sources: ['a.tth'], names: [], mappings: `AAA${encodeVLQ(2000)},CAA${s}` });
    assert.equal(map.findEntry(0, 1).originalColumn, 2000 + n, `vector ${n}`);
  }
});

test('round-trips random values across the whole range', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 5000; i++) {
    const n = Math.round((rand() * 2 - 1) * VLQ_MAX);
    assert.equal(decodeVLQ(encodeVLQ(n)).value, n);
  }
  for (let n = -300; n <= 300; n++) assert.equal(decodeVLQ(encodeVLQ(n)).value, n);
});

test('decodes values back to back, the way a segment is laid out', () => {
  const text = [5, -3, 0, 1000, -1].map(encodeVLQ).join('');
  const out = [];
  for (let pos = 0; pos < text.length;) {
    const { value, next } = decodeVLQ(text, pos);
    out.push(value);
    pos = next;
  }
  assert.deepEqual(out, [5, -3, 0, 1000, -1]);
});

test('rejects values the format cannot hold, and malformed input', () => {
  assert.throws(() => encodeVLQ(VLQ_MAX + 1), RangeError);
  assert.throws(() => encodeVLQ(1.5), RangeError);
  assert.throws(() => decodeVLQ('g'), SyntaxError); // continuation bit, then nothing
  assert.throws(() => decodeVLQ('*'), SyntaxError);
});
