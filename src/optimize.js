// Optimisation, enabled by -O1 (FR-O1, FR-O2).
//
// optimize() runs on the lowered core tree and returns a new tree:
//
//   Constant folding   an operator applied to literals becomes a literal:
//                      2 * 3 -> 6, "a" + "b" -> "ab", 1 < 2 -> true,
//                      true ? x : y -> x
//   Dead code          if (false) { … } and while (false) { … } disappear,
//                      if (true) A else B becomes A, and statements after a
//                      statement that always returns are dropped
//
// A folded expression takes the span of the whole expression it replaces
// (FR-O2) and is marked `folded: true`. Folding never changes what a program
// prints: it is skipped where JavaScript would give a different value, for
// division or remainder by zero, a result that is not a safe integer, and
// negative zero.
//
// Removed code loses its mappings. `--map-report` measures how many source
// statements keep one (FR-O3).

import { returns } from './checker.js';
import { children } from './ast.js';

export function optimize(program) {
  const stats = { folded: 0, removed: 0 };

  // Counts the statements in a subtree that is being dropped. A block is a
  // container, not a statement of its own.
  const countRemoved = (node) => {
    let n = isStatement(node) && node.kind !== 'Block' ? 1 : 0;
    for (const [, c] of children(node)) n += countRemoved(c);
    return n;
  };
  const drop = (nodes) => { for (const n of nodes) stats.removed += countRemoved(n); };

  const literal = (kind, value, span) => {
    stats.folded++;
    return { kind, span, value, folded: true };
  };

  function expr(e) {
    switch (e.kind) {
      case 'Unary': {
        const operand = expr(e.operand);
        if (e.op === '-' && operand.kind === 'IntLit' && operand.value !== 0) return literal('IntLit', -operand.value, e.span);
        if (e.op === '!' && operand.kind === 'BoolLit') return literal('BoolLit', !operand.value, e.span);
        return { ...e, operand };
      }
      case 'Binary': {
        const left = expr(e.left);
        const right = expr(e.right);
        const folded = foldBinary(e.op, left, right);
        if (folded) return literal(folded.kind, folded.value, e.span);
        return { ...e, left, right };
      }
      case 'Cond': {
        const test = expr(e.test);
        if (test.kind === 'BoolLit') {
          const chosen = expr(test.value ? e.then : e.else);
          stats.folded++;
          return { ...chosen, span: e.span, folded: true };
        }
        return { ...e, test, then: expr(e.then), else: expr(e.else) };
      }
      case 'Call':
        return { ...e, args: e.args.map(expr) };
      default:
        return e;
    }
  }

  function block(b) {
    return { ...b, body: stmts(b.body) };
  }

  // Optimises a statement list, dropping whatever follows a statement that
  // always returns.
  function stmts(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (const s of stmt(list[i])) out.push(s);
      if (out.length && returns(out[out.length - 1])) {
        drop(list.slice(i + 1));
        break;
      }
    }
    return out;
  }

  // Returns the statements that replace `s`: usually one, possibly none.
  function stmt(s) {
    switch (s.kind) {
      case 'FnDecl': return [{ ...s, body: block(s.body) }];
      case 'Block': return [block(s)];
      case 'Let': return [{ ...s, init: expr(s.init) }];
      case 'Assign': return [{ ...s, value: expr(s.value) }];
      case 'ExprStmt': return [{ ...s, expr: expr(s.expr) }];
      case 'Print': return [{ ...s, value: expr(s.value) }];
      case 'Return': return [{ ...s, value: s.value ? expr(s.value) : null }];
      case 'If': {
        const cond = expr(s.cond);
        if (cond.kind === 'BoolLit') {
          const kept = cond.value ? s.then : s.else;
          const gone = cond.value ? s.else : s.then;
          stats.removed += 1; // the if itself
          if (gone) drop([gone]);
          if (!kept) return [];
          return kept.kind === 'If' ? stmt(kept) : [block(kept)];
        }
        return [{ ...s, cond, then: block(s.then), else: s.else ? stmt(s.else)[0] ?? null : null }];
      }
      case 'While': {
        const cond = expr(s.cond);
        if (cond.kind === 'BoolLit' && !cond.value) {
          drop([s]);
          return [];
        }
        return [{ ...s, cond, body: block(s.body) }];
      }
      default:
        throw new Error(`optimize: unexpected statement kind '${s.kind}'`);
    }
  }

  return { program: { ...program, body: stmts(program.body) }, stats };
}

const STATEMENTS = new Set(['FnDecl', 'Block', 'Let', 'Assign', 'ExprStmt', 'Print', 'Return', 'If', 'While']);
const isStatement = (n) => STATEMENTS.has(n.kind);

const isLit = (n) => n.kind === 'IntLit' || n.kind === 'BoolLit' || n.kind === 'StringLit';

// The literal an operator gives for literal operands, or null when it should
// not be folded.
function foldBinary(op, l, r) {
  if (!isLit(l) || !isLit(r)) return null;
  const a = l.value;
  const b = r.value;
  if (l.kind === 'IntLit' && r.kind === 'IntLit') {
    let v;
    switch (op) {
      case '+': v = a + b; break;
      case '-': v = a - b; break;
      case '*': v = a * b; break;
      case '/': if (b === 0) return null; v = Math.trunc(a / b); break;
      case '%': if (b === 0) return null; v = a % b; break;
      case '<': return { kind: 'BoolLit', value: a < b };
      case '<=': return { kind: 'BoolLit', value: a <= b };
      case '>': return { kind: 'BoolLit', value: a > b };
      case '>=': return { kind: 'BoolLit', value: a >= b };
      case '==': return { kind: 'BoolLit', value: a === b };
      case '!=': return { kind: 'BoolLit', value: a !== b };
      default: return null;
    }
    // Keep the runtime result exactly: no unsafe integers, no -0.
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) return null;
    return { kind: 'IntLit', value: v };
  }
  if (l.kind !== r.kind) return null;
  if (op === '==') return { kind: 'BoolLit', value: a === b };
  if (op === '!=') return { kind: 'BoolLit', value: a !== b };
  if (op === '+' && l.kind === 'StringLit') return { kind: 'StringLit', value: a + b };
  return null;
}

// --- mapping retention (FR-O3) -------------------------------------------------

// The proportion of source statements whose first token still has a mapping.
// ast: the parsed program; table: the emitter's mapping table.
export function mappingRetention(ast, table) {
  const mapped = new Set(table.map((m) => m.span.offset));
  let statements = 0;
  let kept = 0;
  const visit = (node, parentKind) => {
    if (parentKind === 'Program' || parentKind === 'Block') {
      statements++;
      if (mapped.has(node.span.offset)) kept++;
    }
    for (const [, c] of children(node)) visit(c, node.kind);
  };
  visit(ast, null);
  return { statements, kept, mappings: table.length, ratio: statements ? kept / statements : 1 };
}
