// Text dumps of each phase's output (FR-C3). The formats are stable, because
// golden-file tests compare them byte for byte.

import { CHILD_FIELDS } from './ast.js';
import { formatSpan } from './span.js';

// One token per line: position+length, kind, lexeme.
export function dumpTokens(tokens) {
  const rows = tokens.map((t) => [
    formatSpan(t.span),
    t.kind,
    t.kind === 'EOF' ? '<eof>' : t.lexeme,
  ]);
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  return rows.map(([s, k, l]) => `${s.padEnd(w0)}  ${k.padEnd(w1)}  ${l}\n`).join('');
}

function label(node, showJsNames) {
  switch (node.kind) {
    case 'Ident': {
      // In the core tree, show the JavaScript name when it differs (FR-G3).
      const js = showJsNames ? node.symbol?.jsName : null;
      return js && js !== node.name ? `Ident ${node.name} => ${js}` : `Ident ${node.name}`;
    }
    case 'TypeRef': return `TypeRef ${node.name}`;
    case 'IntLit': return `IntLit ${node.value}`;
    case 'BoolLit': return `BoolLit ${node.value}`;
    case 'StringLit': return `StringLit ${JSON.stringify(node.value)}`;
    case 'Binary':
    case 'Unary':
    case 'Assign':
      return `${node.kind} ${node.op}`;
    default:
      return node.kind;
  }
}

// An indented tree, one node per line, each with its span. A child held in a
// single-node field is prefixed with the field name. Elements of a list
// field are printed as they are. Nodes created by lowering are marked
// [lowered] and nodes made by -O1 constant folding are marked [folded]; in
// both cases the span is the span of the construct they replace (FR-M2,
// FR-O2).
// showJsNames is set for the core tree (--dump-core).
export function dumpAst(root, { showJsNames = false } = {}) {
  let out = '';
  const visit = (node, depth, field) => {
    const prefix = field ? `${field}: ` : '';
    const synth = (node.synthetic ? ' [lowered]' : '') + (node.folded ? ' [folded]' : '');
    out += `${'  '.repeat(depth)}${prefix}${label(node, showJsNames)} @${formatSpan(node.span)}${synth}\n`;
    for (const f of CHILD_FIELDS[node.kind]) {
      const v = node[f];
      if (Array.isArray(v)) v.forEach((c) => visit(c, depth + 1, null));
      else if (v) visit(v, depth + 1, f);
    }
  };
  visit(root, 0, null);
  return out;
}

// The mapping table, one entry per line, before VLQ encoding. Positions are
// 0-based, exactly as the source map stores them.
export function dumpMappings(table) {
  const rows = table.map((m) => [
    `${m.generatedLine}:${m.generatedColumn}`,
    `${m.originalLine}:${m.originalColumn}`,
    m.name ?? '',
  ]);
  const w0 = Math.max(9, ...rows.map((r) => r[0].length));
  const w1 = Math.max(8, ...rows.map((r) => r[1].length));
  let out = `${'generated'.padEnd(w0)}  ${'original'.padEnd(w1)}  name   (0-based line:column)\n`;
  for (const [g, o, n] of rows) out += `${g.padEnd(w0)}  ${o.padEnd(w1)}  ${n}`.trimEnd() + '\n';
  return out;
}

// The --map-report table: how many source statements keep a mapping at each
// optimisation level (FR-O3).
export function dumpMapReport(file, rows) {
  let out = `Mapping retention for ${file} (source statements whose first token has a mapping)\n\n`;
  out += 'level  statements  mapped  retained  mappings  folded  propagated  removed\n';
  for (const r of rows) {
    out += `${r.level.padEnd(5)}  ${String(r.statements).padStart(10)}  ${String(r.kept).padStart(6)}  ` +
      `${(r.ratio * 100).toFixed(1).padStart(7)}%  ${String(r.mappings).padStart(8)}  ` +
      `${String(r.folded).padStart(6)}  ${String(r.propagated).padStart(10)}  ${String(r.removed).padStart(7)}\n`;
  }
  return out;
}
