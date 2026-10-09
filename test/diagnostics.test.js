import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSpan } from '../src/span.js';
import { SourceFile } from '../src/source.js';
import { Diagnostics, renderDiagnostic, renderAll } from '../src/diagnostics.js';

test('renders file:line:col, the source line, and carets under the span', () => {
  const src = new SourceFile('a.tth', 'let x = 1;\nlet yy = x + true;\n');
  const d = { severity: 'error', message: 'bad operand', span: makeSpan('a.tth', 24, 4, 2, 14, 2, 18) };
  assert.equal(
    renderDiagnostic(d, src),
    'a.tth:2:14: error: bad operand\n' +
    '  2 | let yy = x + true;\n' +
    '    |              ^^^^\n',
  );
});

test('the caret prefix reuses tabs from the source line', () => {
  const src = new SourceFile('a.tth', '\tx\t= @;');
  const d = { severity: 'error', message: 'm', span: makeSpan('a.tth', 5, 1, 1, 6, 1, 7) };
  assert.equal(renderDiagnostic(d, src).split('\n')[2], '    | \t \t  ^');
});

test('a zero-length span still gets one caret', () => {
  const src = new SourceFile('a.tth', 'print(1)');
  const d = { severity: 'error', message: 'm', span: makeSpan('a.tth', 8, 0, 1, 9, 1, 9) };
  assert.equal(renderDiagnostic(d, src).split('\n')[2], '    |         ^');
});

test('a span crossing lines is underlined to the end of its first line', () => {
  const src = new SourceFile('a.tth', 'ab cd\nef');
  const d = { severity: 'error', message: 'm', span: makeSpan('a.tth', 3, 5, 1, 4, 2, 3) };
  assert.equal(renderDiagnostic(d, src).split('\n')[2], '    |    ^^');
});

test('diagnostics render in source order, with span-less notes last', () => {
  const src = new SourceFile('a.tth', 'a b c');
  const diags = new Diagnostics();
  diags.note('done');
  diags.error('second', makeSpan('a.tth', 4, 1, 1, 5, 1, 6));
  diags.error('first', makeSpan('a.tth', 0, 1, 1, 1, 1, 2));
  const headers = renderAll(diags, src).split('\n').filter((l) => !l.startsWith(' '));
  assert.deepEqual(headers.filter(Boolean), ['a.tth:1:1: error: first', 'a.tth:1:5: error: second', 'a.tth: note: done']);
  assert.equal(diags.errorCount, 2);
});

test('notes are printed straight after their error, in the same format', () => {
  const src = new SourceFile('a.tth', 'let x = 1;\nlet x = 2;');
  const diags = new Diagnostics();
  diags.error("'x' is already declared in this scope", makeSpan('a.tth', 15, 1, 2, 5, 2, 6),
    [{ message: "previous declaration of 'x' is here", span: makeSpan('a.tth', 4, 1, 1, 5, 1, 6) }]);
  assert.equal(
    renderAll(diags, src),
    "a.tth:2:5: error: 'x' is already declared in this scope\n" +
    '  2 | let x = 2;\n' +
    '    |     ^\n' +
    "a.tth:1:5: note: previous declaration of 'x' is here\n" +
    '  1 | let x = 1;\n' +
    '    |     ^\n',
  );
  assert.equal(diags.errorCount, 1);
});
