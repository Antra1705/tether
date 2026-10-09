// Diagnostics: collection and rendering (FR-S3).
//
// A rendered diagnostic looks like
//
//   examples/bad.tth:3:9: error: unterminated string literal
//       3 | let s = "hello;
//         |         ^
//
// The caret run sits under the exact span. If the span runs past the end of
// its first line, the carets stop at the end of that line.
//
// An error may carry notes that point somewhere else, for example at an
// earlier declaration. Notes are printed straight after their error, in the
// same format, so they stay next to the error they explain.

export class Diagnostics {
  constructor() {
    this.items = [];
  }

  // notes: [{ message, span }]
  error(message, span, notes = []) {
    this.items.push({ severity: 'error', message, span, notes });
  }

  note(message, span = null) {
    this.items.push({ severity: 'note', message, span, notes: [] });
  }

  get errorCount() {
    return this.items.filter((d) => d.severity === 'error').length;
  }

  hasErrors() {
    return this.errorCount > 0;
  }

  // Diagnostics in source order. Those without a span keep their relative
  // order and come last.
  sorted() {
    const withSpan = this.items.filter((d) => d.span);
    const without = this.items.filter((d) => !d.span);
    withSpan.sort((a, b) => a.span.offset - b.span.offset);
    return [...withSpan, ...without];
  }
}

// One header with its source line and caret line, without attached notes.
export function renderEntry(severity, message, span, source) {
  if (!span) return `${source.name}: ${severity}: ${message}\n`;
  const { line, col } = span;
  const header = `${span.file}:${line}:${col}: ${severity}: ${message}`;
  const text = source.lineText(line);
  const gutter = String(line).length + 4;
  // Reproduce tabs from the source line so the carets line up however the
  // terminal expands them.
  let pad = '';
  for (let i = 0; i < col - 1; i++) pad += text[i] === '\t' ? '\t' : ' ';
  const sameLine = span.endLine === line;
  const width = sameLine ? span.length : text.length - (col - 1);
  const carets = '^'.repeat(Math.max(1, width));
  return (
    `${header}\n` +
    `${String(line).padStart(gutter - 2)} | ${text}\n` +
    `${' '.repeat(gutter - 2)} | ${pad}${carets}\n`
  );
}

export function renderDiagnostic(d, source) {
  let out = renderEntry(d.severity, d.message, d.span, source);
  for (const n of d.notes ?? []) out += renderEntry('note', n.message, n.span, source);
  return out;
}

export function renderAll(diags, source) {
  return diags.sorted().map((d) => renderDiagnostic(d, source)).join('');
}
