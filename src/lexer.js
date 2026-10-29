// Lexical analysis (FR-L1 – FR-L5).
//
// lex() turns a SourceFile into an array of tokens ending in an EOF token.
// Every token carries a span (see span.js). Lexical errors are reported to the
// Diagnostics object and the scanner carries on, so that one run can surface
// several problems.
//
// Token shape: { kind, lexeme, value, span }
//   kind    'Int' | 'String' | 'Bool' | 'Ident' | 'Keyword' | 'Punct' |
//           'Error' | 'EOF'
//   lexeme  the exact source text of the token
//   value   the decoded value for literals (number, string, boolean), else null
//
// A token the lexer could not scan properly (an unknown character, or a
// string with no closing quote) is marked `reported: true`; unknown
// characters become 'Error' tokens. The lexer has already reported these,
// so the parser does not report a second error when it trips over one.

import { makeSpan } from './span.js';

export const KEYWORDS = new Set([
  'fn', 'let', 'if', 'else', 'while', 'for', 'break', 'continue', 'return', 'print',
  'int', 'bool', 'string',
  'true', 'false',
]);

// Longest first, so that '<=' wins over '<'.
const PUNCTUATORS = [
  '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
  '+', '-', '*', '/', '%', '!', '=', '<', '>',
  '(', ')', '{', '}', '[', ']', ',', ';', ':',
];

const ESCAPES = { n: '\n', t: '\t', '"': '"', '\\': '\\' };

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);
const isLineEnd = (c) => c === '\n' || c === '\r';

export function lex(source, diags) {
  const text = source.text;
  const file = source.name;
  const tokens = [];
  let offset = 0;
  let line = 1;
  let col = 1;

  // The only place the scanner moves forward, so line and column can never
  // drift from the offset.
  function advance() {
    const ch = text[offset++];
    if (ch === '\n' || (ch === '\r' && text[offset] !== '\n')) {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  }

  function push(kind, start, value = null, reported = false) {
    const { offset: so, line: sl, col: sc } = start;
    tokens.push({
      kind,
      lexeme: text.slice(so, offset),
      value,
      span: makeSpan(file, so, offset - so, sl, sc, line, col),
      reported,
    });
  }

  function scanString(start) {
    advance(); // opening quote
    let value = '';
    let terminated = true;
    for (;;) {
      const c = text[offset];
      if (c === undefined || isLineEnd(c)) {
        // FR-L4: point at the opening quote, not at the end of the line.
        diags.error(
          'unterminated string literal',
          makeSpan(file, start.offset, 1, start.line, start.col, start.line, start.col + 1),
        );
        terminated = false;
        break;
      }
      if (c === '"') {
        advance();
        break;
      }
      if (c === '\\') {
        const esc = { offset, line, col };
        advance();
        const e = text[offset];
        if (e === undefined || isLineEnd(e)) continue; // reported as unterminated
        advance();
        if (Object.hasOwn(ESCAPES, e)) {
          value += ESCAPES[e];
        } else {
          diags.error(
            `unknown escape sequence '\\${e}'`,
            makeSpan(file, esc.offset, 2, esc.line, esc.col, esc.line, esc.col + 2),
          );
        }
        continue;
      }
      value += advance();
    }
    push('String', start, value, !terminated);
  }

  while (offset < text.length) {
    const c = text[offset];

    if (c === ' ' || c === '\t' || isLineEnd(c)) {
      advance();
      continue;
    }
    if (c === '/' && text[offset + 1] === '/') {
      while (offset < text.length && !isLineEnd(text[offset])) advance();
      continue;
    }

    const start = { offset, line, col };

    if (isDigit(c)) {
      while (isDigit(text[offset])) advance();
      const value = Number(text.slice(start.offset, offset));
      if (!Number.isSafeInteger(value)) {
        diags.error('integer literal is too large', makeSpan(file, start.offset, offset - start.offset, start.line, start.col, line, col));
      }
      push('Int', start, value);
      continue;
    }

    if (isIdentStart(c)) {
      while (isIdentPart(text[offset])) advance();
      const word = text.slice(start.offset, offset);
      if (word === 'true' || word === 'false') push('Bool', start, word === 'true');
      else push(KEYWORDS.has(word) ? 'Keyword' : 'Ident', start);
      continue;
    }

    if (c === '"') {
      scanString(start);
      continue;
    }

    const punct = PUNCTUATORS.find((p) => text.startsWith(p, offset));
    if (punct) {
      for (let i = 0; i < punct.length; i++) advance();
      push('Punct', start);
      continue;
    }

    // Unknown character: report it, skip it, keep scanning.
    const cp = text.codePointAt(offset);
    const width = cp > 0xffff ? 2 : 1;
    for (let i = 0; i < width; i++) advance();
    const shown = cp < 0x20 || cp === 0x7f
      ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
      : `'${String.fromCodePoint(cp)}'`;
    const hint = c === '&' ? "; did you mean '&&'?" : c === '|' ? "; did you mean '||'?" : '';
    diags.error(
      `unexpected character ${shown}${hint}`,
      makeSpan(file, start.offset, width, start.line, start.col, line, col),
    );
    push('Error', start, null, true);
  }

  tokens.push({
    kind: 'EOF',
    lexeme: '',
    value: null,
    span: makeSpan(file, offset, 0, line, col, line, col),
    reported: false,
  });
  return tokens;
}
