// JavaScript emission (FR-G1 – FR-G4) and the mapping table (FR-X4).
//
// emit() turns the core tree from lower.js into ECMAScript 2015 and, while it
// writes, records a mapping table: each entry says that a generated position
// came from an original span.
//
// The Writer owns the only write path to the output (FR-G2). write() updates
// the generated line and column on every call, so a mapping always records
// exactly where its text starts. After the last write the counters are
// checked against the finished string (PRD risk table: column drift).
//
// Mappings are recorded for the first token of every statement, for every
// identifier, declared or referenced (FR-X4), and inside expressions: at the
// start of every expression and at every binary operator. Identifier mappings
// carry the original Tether name, which may differ from the JavaScript name
// (FR-G3). Expression mappings let a debugger resolve a position inside a long
// expression to the sub-expression it came from, not just to the statement.
// Where several mappings start at the same generated column, the innermost
// one wins (Writer.map).
//
// Array indexing is checked: xs[i] becomes $get(xs, i) and xs[i] = v becomes
// $set(xs, i, v). The two helpers are written at the top of a program that
// indexes an array, and only then. An index out of range throws a RangeError
// whose stack trace starts at the caller, not inside the helper, so with the
// source map it names the .tth line that did the indexing. '$' cannot appear
// in a Tether name, so the helpers cannot clash with the program's names.
//
// Positions in the mapping table are 0-based, as the source map stores them.
// They come from toMapPosition(), the single 1-based to 0-based conversion
// (FR-L2).

import { toMapPosition } from './span.js';
import { walk } from './ast.js';

// The checked-indexing helpers, one per line.
export const INDEX_HELPERS = [
  'function $get(a, i) { if (i >= 0 && i < a.length) return a[i]; throw $outOfRange(a, i, $get); }',
  'function $set(a, i, v) { if (i >= 0 && i < a.length) { a[i] = v; return; } throw $outOfRange(a, i, $set); }',
  'function $outOfRange(a, i, helper) { const e = new RangeError("index " + i + " is out of range for an array of length " + a.length); if (Error.captureStackTrace) Error.captureStackTrace(e, helper); return e; }',
];

const INDENT = '  ';

class Writer {
  constructor() {
    this.chunks = [];
    this.line = 0;
    this.column = 0;
    this.mappings = [];
  }

  write(text) {
    this.chunks.push(text);
    const nl = text.lastIndexOf('\n');
    if (nl < 0) {
      this.column += text.length;
    } else {
      for (let i = 0; i <= nl; i++) if (text.charCodeAt(i) === 10) this.line++;
      this.column = text.length - nl - 1;
    }
  }

  // Records that the next character written comes from `span`.
  map(span, name = null) {
    const { line, column } = toMapPosition(span);
    const entry = { generatedLine: this.line, generatedColumn: this.column, originalLine: line, originalColumn: column, name, span };
    const last = this.mappings[this.mappings.length - 1];
    // A statement and its first identifier start at the same generated
    // column; keep the more specific (later) entry.
    if (last && last.generatedLine === entry.generatedLine && last.generatedColumn === entry.generatedColumn) {
      this.mappings[this.mappings.length - 1] = entry;
    } else {
      this.mappings.push(entry);
    }
  }

  finish() {
    const code = this.chunks.join('');
    const lines = code.split('\n');
    if (lines.length - 1 !== this.line || lines[lines.length - 1].length !== this.column) {
      throw new Error('emitter position counters drifted from the generated text');
    }
    return code;
  }
}

// JavaScript precedence levels (higher binds tighter).
const PREC = {
  cond: 2,
  '==': 7, '!=': 7,
  '<': 8, '<=': 8, '>': 8, '>=': 8,
  '+': 10, '-': 10,
  '*': 11, '%': 11,
  unary: 14,
  call: 17,
  atom: 18,
};

function precOf(e) {
  switch (e.kind) {
    case 'Cond': return PREC.cond;
    case 'Binary': return e.op === '/' ? PREC.call : PREC[e.op]; // '/' becomes Math.trunc(...)
    case 'Unary': return PREC.unary;
    case 'Call': return PREC.call;
    case 'Index': return PREC.call; // $get(...)
    default: return PREC.atom;
  }
}

// A JavaScript string literal for any Tether string value. U+2028 and U+2029
// are escaped because ES2015 does not allow them raw inside a string.
export function jsString(value) {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

// options.mapUrl: the value for the sourceMappingURL comment, or null for none.
export function emit(program, { mapUrl = null } = {}) {
  const w = new Writer();
  let depth = 0;
  const indent = () => w.write(INDENT.repeat(depth));
  const jsName = (id) => id.symbol?.jsName ?? id.name;

  function ident(id) {
    w.map(id.span, id.name);
    w.write(jsName(id));
  }

  function block(b) {
    w.write('{\n');
    depth++;
    for (const s of b.body) {
      indent();
      stmt(s);
      w.write('\n');
    }
    depth--;
    indent();
    w.write('}');
  }

  function stmt(s) {
    w.map(s.span);
    switch (s.kind) {
      case 'FnDecl':
        w.write('function ');
        ident(s.name);
        w.write('(');
        s.params.forEach((p, i) => {
          if (i) w.write(', ');
          ident(p.name);
        });
        w.write(') ');
        block(s.body);
        return;
      case 'Let':
        w.write('let ');
        ident(s.name);
        w.write(' = ');
        expr(s.init, 0);
        w.write(';');
        return;
      case 'Assign':
        if (s.target.kind === 'Index') {
          w.write('$set(');
          expr(s.target.object, PREC.cond);
          w.write(', ');
          expr(s.target.index, PREC.cond);
          w.write(', ');
          expr(s.value, PREC.cond);
          w.write(');');
          return;
        }
        ident(s.target);
        w.write(' = ');
        expr(s.value, 0);
        w.write(';');
        return;
      case 'ExprStmt':
        expr(s.expr, 0);
        w.write(';');
        return;
      case 'Print':
        w.write('console.log(');
        if (s.array) {
          // An array prints as [1, 2, 3] wherever the program runs.
          w.write('"[" + ');
          expr(s.value, PREC.call);
          w.write('.join(", ") + "]"');
        } else {
          expr(s.value, PREC.cond);
        }
        w.write(');');
        return;
      case 'Break':
        w.write('break;');
        return;
      case 'Continue':
        w.write('continue;');
        return;
      case 'Return':
        w.write('return');
        if (s.value) {
          w.write(' ');
          expr(s.value, 0);
        }
        w.write(';');
        return;
      case 'Block':
        block(s);
        return;
      case 'If':
        w.write('if (');
        expr(s.cond, 0);
        w.write(') ');
        block(s.then);
        if (s.else) {
          w.write(' else ');
          if (s.else.kind === 'If') stmt(s.else);
          else block(s.else);
        }
        return;
      case 'While':
        w.write('while (');
        expr(s.cond, 0);
        w.write(') ');
        block(s.body);
        return;
      default:
        throw new Error(`emit: unexpected statement kind '${s.kind}'`);
    }
  }

  // len(x) -> x.length; push(xs, v) -> xs.push(v)
  // The generated text starts with the argument, not with the function name,
  // so the property name is mapped back to the built-in's name. Otherwise a
  // statement such as `push(xs, 1);` would have no mapping to its first token.
  function builtin(e) {
    expr(e.args[0], PREC.call);
    w.write('.');
    w.map(e.callee.span, e.callee.name);
    if (e.callee.name === 'len') {
      w.write('length');
      return;
    }
    w.write('push(');
    expr(e.args[1], PREC.cond);
    w.write(')');
  }

  // Writes ' op ', mapping the operator itself to its source token.
  function operator(op, span) {
    w.write(' ');
    if (span) w.map(span);
    w.write(`${op} `);
  }

  // Writes `e`, in parentheses if it binds more loosely than minPrec allows.
  function expr(e, minPrec) {
    const p = precOf(e);
    const paren = p < minPrec;
    if (paren) w.write('(');
    if (e.kind !== 'Ident') w.map(e.span); // ident() maps with the name
    switch (e.kind) {
      case 'IntLit': w.write(String(e.value)); break;
      case 'BoolLit': w.write(e.value ? 'true' : 'false'); break;
      case 'StringLit': w.write(jsString(e.value)); break;
      case 'Ident': ident(e); break;
      case 'Call':
        if (e.callee.symbol?.kind === 'builtin') {
          builtin(e);
          break;
        }
        ident(e.callee);
        w.write('(');
        e.args.forEach((a, i) => {
          if (i) w.write(', ');
          expr(a, PREC.cond);
        });
        w.write(')');
        break;
      case 'ArrayLit':
        w.write('[');
        e.elements.forEach((el, i) => {
          if (i) w.write(', ');
          expr(el, PREC.cond);
        });
        w.write(']');
        break;
      case 'Index':
        w.write('$get(');
        expr(e.object, PREC.cond);
        w.write(', ');
        expr(e.index, PREC.cond);
        w.write(')');
        break;
      case 'Unary':
        w.write(e.op);
        // '- -x' must not become '--x'.
        if (e.op === '-' && e.operand.kind === 'Unary' && e.operand.op === '-') w.write(' ');
        expr(e.operand, PREC.unary);
        break;
      case 'Cond':
        expr(e.test, PREC.cond + 1);
        // A conditional made from && or || maps its '?' to that operator.
        w.write(' ');
        if (e.opSpan) w.map(e.opSpan);
        w.write('? ');
        expr(e.then, PREC.cond);
        w.write(' : ');
        expr(e.else, PREC.cond);
        break;
      case 'Binary':
        if (e.op === '/') {
          // Integer division truncates toward zero, like C and Java.
          w.write('Math.trunc(');
          expr(e.left, PREC['*']);
          operator('/', e.opSpan);
          expr(e.right, PREC['*'] + 1);
          w.write(')');
        } else {
          // Both operands always have the same static type, so strict equality is exact.
          const op = e.op === '==' ? '===' : e.op === '!=' ? '!==' : e.op;
          expr(e.left, p);
          operator(op, e.opSpan);
          expr(e.right, p + 1); // all binary operators are left-associative
        }
        break;
      default:
        throw new Error(`emit: unexpected expression kind '${e.kind}'`);
    }
    if (paren) w.write(')');
  }

  w.write('"use strict";\n');
  let indexes = false;
  walk(program, (n) => { if (n.kind === 'Index') indexes = true; });
  if (indexes) for (const line of INDEX_HELPERS) w.write(`${line}\n`);
  for (const item of program.body) {
    stmt(item);
    w.write('\n');
  }
  if (mapUrl !== null) w.write(`//# sourceMappingURL=${mapUrl}\n`);
  return { code: w.finish(), mappings: w.mappings };
}
