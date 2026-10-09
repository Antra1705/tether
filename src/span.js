// Source positions.
//
// A span records where a piece of source text lives:
//
//   file     the source file name, exactly as given on the command line
//   offset   0-based index of the first UTF-16 code unit in the file text
//   length   number of UTF-16 code units covered
//   line     1-based line of the first code unit
//   col      1-based column of the first code unit
//   endLine  1-based line of the position just past the last code unit
//   endCol   1-based column of the position just past the last code unit
//
// Conventions (documented in docs/positions.md):
//   * Columns count UTF-16 code units, the unit that JavaScript strings and
//     Source Map v3 consumers use.
//   * A tab advances the column by exactly one (FR-L5).
//   * "\n", "\r\n" and a lone "\r" each end a line.
//
// Every position inside the compiler is 1-based, matching what diagnostics
// show the user. toMapPosition() is the single place where a position becomes
// 0-based for the source map (FR-L2). No other code may subtract 1 from a line
// or column.

export function makeSpan(file, offset, length, line, col, endLine, endCol) {
  return { file, offset, length, line, col, endLine, endCol };
}

// The smallest span that covers both a and b. Either argument may be null.
export function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const start = b.offset < a.offset ? b : a;
  const end = b.offset + b.length > a.offset + a.length ? b : a;
  return makeSpan(
    start.file,
    start.offset,
    end.offset + end.length - start.offset,
    start.line,
    start.col,
    end.endLine,
    end.endCol,
  );
}

export function unionAll(spans) {
  return spans.reduce((acc, s) => union(acc, s), null);
}

// A zero-length span just past the end of `s`. Used to point at a missing
// token, such as a ';' that should follow the previous token.
export function spanAfter(s) {
  return makeSpan(s.file, s.offset + s.length, 0, s.endLine, s.endCol, s.endLine, s.endCol);
}

// "line:col+length", the compact form used by the dump flags.
export function formatSpan(s) {
  return `${s.line}:${s.col}+${s.length}`;
}

// The 1-based to 0-based boundary (FR-L2). The source-map writer must obtain
// every original-position field through this function.
export function toMapPosition(s) {
  return { line: s.line - 1, column: s.col - 1 };
}
