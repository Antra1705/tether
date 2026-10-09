import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSpan, union, unionAll, spanAfter, formatSpan, toMapPosition } from '../src/span.js';
import { SourceFile } from '../src/source.js';
import { Diagnostics } from '../src/diagnostics.js';
import { lex } from '../src/lexer.js';

const s = (offset, length, line, col, endLine, endCol) => makeSpan('f', offset, length, line, col, endLine, endCol);

test('union covers both spans whatever the argument order', () => {
  const a = s(4, 3, 1, 5, 1, 8);
  const b = s(20, 2, 2, 3, 2, 5);
  const expected = s(4, 18, 1, 5, 2, 5);
  assert.deepEqual(union(a, b), expected);
  assert.deepEqual(union(b, a), expected);
});

test('union with a contained span returns the outer span', () => {
  const outer = s(0, 10, 1, 1, 1, 11);
  const inner = s(2, 3, 1, 3, 1, 6);
  assert.deepEqual(union(outer, inner), outer);
  assert.deepEqual(union(inner, outer), outer);
});

test('union and unionAll treat null as the identity', () => {
  const a = s(1, 1, 1, 2, 1, 3);
  assert.equal(union(null, a), a);
  assert.equal(union(a, null), a);
  assert.equal(unionAll([]), null);
});

test('spanAfter is an empty span at the end of its argument', () => {
  assert.deepEqual(spanAfter(s(4, 3, 1, 5, 1, 8)), s(7, 0, 1, 8, 1, 8));
});

test('formatSpan prints line:col+length', () => {
  assert.equal(formatSpan(s(4, 3, 1, 5, 1, 8)), '1:5+3');
});

// The off-by-one risk from section 10 of the PRD: a property test that
// toMapPosition agrees with an offset-based 0-based position, computed
// independently, for random positions in random text.
test('toMapPosition is the 0-based position of the span start (property)', () => {
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = ['a', 'b', ' ', '\t', '\n', '\r\n', '\r', 'x1', '"s"', '// c\n'];
  for (let trial = 0; trial < 200; trial++) {
    let text = '';
    for (let i = 0; i < 1 + rand(60); i++) text += alphabet[rand(alphabet.length)];
    const source = new SourceFile('f', text);
    const tokens = lex(source, new Diagnostics());
    for (const t of tokens) {
      const { line, column } = toMapPosition(t.span);
      // Independent calculation from the raw text.
      const before = text.slice(0, t.span.offset);
      const lines = before.split(/\r\n|\r|\n/);
      assert.equal(line, lines.length - 1, `line of token at offset ${t.span.offset} in ${JSON.stringify(text)}`);
      assert.equal(column, lines[lines.length - 1].length, `column of token at offset ${t.span.offset} in ${JSON.stringify(text)}`);
    }
  }
});
