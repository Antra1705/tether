// Source Map v3 generation (FR-X1 – FR-X5).
//
// The input is the mapping table the emitter recorded: entries in generated
// order, each with 0-based generated and original positions and an optional
// original name.
//
// `mappings` has one group per generated line, separated by ';'. Within a
// line, segments are separated by ','. A segment has four fields, or five
// when a name applies (FR-X2):
//
//   [generated column, source index, original line, original column, (name index)]
//
// Every field is the difference from the same field in the previous segment
// (FR-X3). The generated column restarts at 0 on each generated line. The
// other four carry on across the whole file. Getting this wrong still gives a
// map that loads, but points at the wrong places, which is why the test suite
// checks every entry with an independent decoder.

import { encodeVLQ } from './vlq.js';

// Returns { mappings, names }. names lists each original name once, in the
// order of first use.
//
// lineCount, when given, is the number of lines in the generated file. Every
// line then gets a group, including trailing lines with no mappings (the
// sourceMappingURL comment and the empty last line), so the string ends with
// ';'. The format allows either form. Writing every line is the more literal
// reading, and it matters in practice: Node's SourceMap decoder gives the last
// segment of a string that does not end in a separator the name of the
// segment before it, even when the last segment has no name field.
export function encodeMappings(table, lineCount = 0) {
  const names = [];
  const nameIndex = new Map();
  const lines = [];
  let genLine = 0;
  let segments = [];
  let prevColumn = 0;
  let prevSource = 0;
  let prevLine = 0;
  let prevOrigColumn = 0;
  let prevName = 0;

  for (const m of table) {
    if (m.generatedLine < genLine) throw new Error('mapping table is not in generated order');
    while (genLine < m.generatedLine) {
      lines.push(segments.join(','));
      segments = [];
      genLine++;
      prevColumn = 0;
    }
    const source = 0; // one source file per compilation
    let seg =
      encodeVLQ(m.generatedColumn - prevColumn) +
      encodeVLQ(source - prevSource) +
      encodeVLQ(m.originalLine - prevLine) +
      encodeVLQ(m.originalColumn - prevOrigColumn);
    prevColumn = m.generatedColumn;
    prevSource = source;
    prevLine = m.originalLine;
    prevOrigColumn = m.originalColumn;
    if (m.name !== null && m.name !== undefined) {
      if (!nameIndex.has(m.name)) {
        nameIndex.set(m.name, names.length);
        names.push(m.name);
      }
      const idx = nameIndex.get(m.name);
      seg += encodeVLQ(idx - prevName);
      prevName = idx;
    }
    segments.push(seg);
  }
  lines.push(segments.join(','));
  while (lines.length < lineCount) lines.push('');
  return { mappings: lines.join(';'), names };
}

// file: the generated file's name, e.g. "fib.js".
// source: the original file's path relative to the map file.
// sourceContent: the original text, embedded so the debugger needs no access
// to the source file (FR-X5).
// lineCount: the number of lines in the generated file (see encodeMappings).
export function buildSourceMap({ file, source, sourceContent, table, lineCount = 0 }) {
  const { mappings, names } = encodeMappings(table, lineCount);
  // Key order is fixed so that output is byte-identical between runs (NFR-2).
  return {
    version: 3,
    file,
    sources: [source],
    sourcesContent: [sourceContent],
    names,
    mappings,
  };
}

export function serializeSourceMap(map) {
  return `${JSON.stringify(map)}\n`;
}
