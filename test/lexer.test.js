import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFile } from '../src/source.js';
import { Diagnostics } from '../src/diagnostics.js';
import { lex } from '../src/lexer.js';

function scan(text) {
  const diags = new Diagnostics();
  const tokens = lex(new SourceFile('t.tth', text), diags);
  return { tokens, diags: diags.items };
}

const brief = (t) => [t.kind, t.lexeme, t.span.line, t.span.col, t.span.length];

test('every token carries file, line, column and length', () => {
  const { tokens } = scan('let x = 42;');
  assert.deepEqual(tokens.map(brief), [
    ['Keyword', 'let', 1, 1, 3],
    ['Ident', 'x', 1, 5, 1],
    ['Punct', '=', 1, 7, 1],
    ['Int', '42', 1, 9, 2],
    ['Punct', ';', 1, 11, 1],
    ['EOF', '', 1, 12, 0],
  ]);
  for (const t of tokens) assert.equal(t.span.file, 't.tth');
});

test('recognises literals, keywords, identifiers and all operators', () => {
  const { tokens, diags } = scan('fn f_1 true false "hi" 7 && || == != <= >= += -= *= /= %= + - * / % ! = < > ( ) { } , ; :');
  assert.deepEqual(diags, []);
  const kinds = tokens.map((t) => t.kind);
  assert.deepEqual(kinds.slice(0, 6), ['Keyword', 'Ident', 'Bool', 'Bool', 'String', 'Int']);
  assert.ok(kinds.slice(6, -1).every((k) => k === 'Punct'));
  assert.equal(tokens.length, 6 + 27 + 1);
  assert.equal(tokens[2].value, true);
  assert.equal(tokens[3].value, false);
  assert.equal(tokens[4].value, 'hi');
  assert.equal(tokens[5].value, 7);
});

test('longest operator wins', () => {
  assert.deepEqual(scan('a<=b').tokens.map((t) => t.lexeme), ['a', '<=', 'b', '']);
  assert.deepEqual(scan('a<-b').tokens.map((t) => t.lexeme), ['a', '<', '-', 'b', '']);
});

test('line comments are skipped', () => {
  const { tokens } = scan('a // comment ;;;\nb');
  assert.deepEqual(tokens.map(brief), [
    ['Ident', 'a', 1, 1, 1],
    ['Ident', 'b', 2, 1, 1],
    ['EOF', '', 2, 2, 0],
  ]);
});

test('a tab advances the column by one (FR-L5)', () => {
  const { tokens } = scan('\t\tx');
  assert.equal(tokens[0].span.col, 3);
});

test('\\n, \\r\\n and a lone \\r each end one line', () => {
  const { tokens } = scan('a\nb\r\nc\rd');
  assert.deepEqual(tokens.slice(0, 4).map((t) => [t.lexeme, t.span.line, t.span.col]), [
    ['a', 1, 1], ['b', 2, 1], ['c', 3, 1], ['d', 4, 1],
  ]);
});

test('columns count UTF-16 code units', () => {
  // The emoji is two code units, so `x` starts at column 6.
  const { tokens } = scan('"😀" x');
  assert.equal(tokens[0].span.length, 4);
  assert.equal(tokens[1].span.col, 6);
});

test('string escapes are decoded', () => {
  const { tokens, diags } = scan('"a\\n\\t\\"\\\\b"');
  assert.deepEqual(diags, []);
  assert.equal(tokens[0].value, 'a\n\t"\\b');
});

test('an unterminated string is reported at its opening quote (FR-L4)', () => {
  const { tokens, diags } = scan('let s = "abc;\nlet t = 1;');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].message, 'unterminated string literal');
  assert.deepEqual([diags[0].span.line, diags[0].span.col, diags[0].span.length], [1, 9, 1]);
  // The string stops at the end of the line; the next line still lexes.
  assert.equal(tokens[3].lexeme, '"abc;');
  assert.equal(tokens[3].reported, true);
  assert.deepEqual(tokens.slice(4, 6).map((t) => [t.lexeme, t.span.line]), [['let', 2], ['t', 2]]);
});

test('an unknown escape is reported on the escape itself', () => {
  const { diags } = scan('"ab\\qc"');
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /unknown escape sequence '\\q'/);
  assert.deepEqual([diags[0].span.col, diags[0].span.length], [4, 2]);
});

test('an unknown character becomes a reported Error token', () => {
  const { tokens, diags } = scan('a @ b & c');
  assert.deepEqual(diags.map((d) => d.message), [
    "unexpected character '@'",
    "unexpected character '&'; did you mean '&&'?",
  ]);
  assert.deepEqual(tokens.map((t) => t.kind), ['Ident', 'Error', 'Ident', 'Error', 'Ident', 'EOF']);
  assert.ok(tokens[1].reported);
});

test('an integer literal too large to be exact is reported', () => {
  const { diags } = scan('99999999999999999999');
  assert.equal(diags[0].message, 'integer literal is too large');
});

test('the EOF token sits just past the last character', () => {
  const { tokens } = scan('ab\ncd');
  const eof = tokens.at(-1);
  assert.deepEqual([eof.span.line, eof.span.col, eof.span.offset], [2, 3, 5]);
});
