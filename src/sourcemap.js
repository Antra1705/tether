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
export function encodeMappings(table) {
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
  return { mappings: lines.join(';'), names };
}

// file: the generated file's name, e.g. "fib.js".
// source: the original file's path relative to the map file.
// sourceContent: the original text, embedded so the debugger needs no access
// to the source file (FR-X5).
export function buildSourceMap({ file, source, sourceContent, table }) {
  const { mappings, names } = encodeMappings(table);
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
