// Lowering (FR-M1, FR-M2).
//
// lower() turns the checked AST into a smaller core tree that the emitter
// translates almost one to one. It builds a new tree and leaves the input
// unchanged.
//
//   for (init; cond; update) B   ->  { init; while (cond) { B...; update; } }
//   continue  (in that for's B)  ->  update; continue;
//   x op= e                      ->  x = x op e
//   a && b                       ->  a ? b : false
//   a || b                       ->  a ? true : b
//   ( e )                        ->  e            (the emitter adds parentheses
//                                                  wherever precedence needs them)
//
// Every node that lowering creates has `synthetic: true` and the span of the
// construct that caused it (FR-M2): the block and loop made from a `for` take
// the span of the whole `for` statement, the `x op e` made from `x op= e`
// takes the span of the assignment, and so on. Nodes copied from the input
// keep their own spans.
//
// Moving the update to the end of the loop body would skip it on `continue`,
// because a JavaScript `continue` in a while loop jumps straight to the
// condition. So every `continue` that belongs to the for loop (not to a loop
// nested inside it) is preceded by a copy of the update. The copy is marked
// synthetic and keeps the update's span, so a debugger stepping through it
// lands on the update in the for header. `break` needs nothing: it leaves the
// while loop, and the block around it, exactly as it left the for loop.
// Folding the body's statements into the loop block is safe because the
// checker has already given any shadowing declaration in the body its own
// JavaScript name, and that is also why a copied update still names the loop
// variable correctly wherever it lands.

// `loop` describes the innermost enclosing loop while lowering its body:
// { update } for a for loop (update may be null), or null outside any loop.
// A while loop's body gets { update: null }.

import { isArray } from './checker.js';
import { CHILD_FIELDS } from './ast.js';

export function lower(program) {
  return { kind: 'Program', span: program.span, body: lowerStmts(program.body, null) };
}

const synth = (node) => ({ ...node, synthetic: true });

function lowerIdent(id) {
  return { kind: 'Ident', span: id.span, name: id.name, symbol: id.symbol };
}

function lowerBlock(block, loop) {
  return { kind: 'Block', span: block.span, body: lowerStmts(block.body, loop) };
}

// Lowers a statement list. Usually one statement becomes one, but a continue
// in a for loop becomes two.
function lowerStmts(list, loop) {
  const out = [];
  for (const s of list) {
    if (s.kind === 'Continue' && loop?.update) out.push({ ...markSynthetic(lowerStmt(loop.update, null)), forUpdate: true });
    out.push(lowerStmt(s, loop));
  }
  return out;
}

// Marks a whole subtree as created by lowering.
function markSynthetic(node) {
  const copy = synth(node);
  for (const field of CHILD_FIELDS[node.kind]) {
    const value = node[field];
    if (Array.isArray(value)) copy[field] = value.map(markSynthetic);
    else if (value) copy[field] = markSynthetic(value);
  }
  return copy;
}

function lowerStmt(s, loop) {
  switch (s.kind) {
    case 'FnDecl':
      return {
        kind: 'FnDecl', span: s.span, name: lowerIdent(s.name),
        params: s.params.map((p) => ({ kind: 'Param', span: p.span, name: lowerIdent(p.name), type: null })),
        returnType: null, body: lowerBlock(s.body, null),
      };
    case 'Let':
      return { kind: 'Let', span: s.span, name: lowerIdent(s.name), type: null, init: lowerExpr(s.init) };
    case 'Assign': {
      // The checker allows compound assignment only to a variable, not to an array element.
      const target = s.target.kind === 'Index' ? lowerExpr(s.target) : lowerIdent(s.target);
      if (s.op === '=') return { kind: 'Assign', span: s.span, op: '=', target, value: lowerExpr(s.value) };
      const value = synth({ kind: 'Binary', span: s.span, op: s.op[0], opSpan: s.opSpan, left: lowerIdent(s.target), right: lowerExpr(s.value) });
      return synth({ kind: 'Assign', span: s.span, op: '=', target, value });
    }
    case 'ExprStmt': return { kind: 'ExprStmt', span: s.span, expr: lowerExpr(s.expr) };
    case 'Print': return { kind: 'Print', span: s.span, value: lowerExpr(s.value), array: isArray(s.value.type) };
    case 'Return': return { kind: 'Return', span: s.span, value: s.value ? lowerExpr(s.value) : null };
    case 'Block': return lowerBlock(s, loop);
    case 'If':
      return {
        kind: 'If', span: s.span, cond: lowerExpr(s.cond), then: lowerBlock(s.then, loop),
        else: s.else ? (s.else.kind === 'If' ? lowerStmt(s.else, loop) : lowerBlock(s.else, loop)) : null,
      };
    case 'While':
      return { kind: 'While', span: s.span, cond: lowerExpr(s.cond), body: lowerBlock(s.body, { update: null }) };
    case 'For': return lowerFor(s);
    case 'Break': case 'Continue': return { kind: s.kind, span: s.span };
    default:
      throw new Error(`lower: unexpected statement kind '${s.kind}'`);
  }
}

function lowerFor(s) {
  const body = lowerBlock(s.body, { update: s.update });
  // forUpdate marks the update as part of the for statement, not a statement
  // of its own (see the removed count in optimize.js).
  if (s.update) body.body.push({ ...lowerStmt(s.update, null), forUpdate: true });
  const cond = s.cond ? lowerExpr(s.cond) : synth({ kind: 'BoolLit', span: s.span, value: true });
  const loop = synth({ kind: 'While', span: s.span, cond, body });
  if (!s.init) return loop;
  // The block keeps the loop variable scoped to the loop.
  return synth({ kind: 'Block', span: s.span, body: [lowerStmt(s.init, null), loop] });
}

function lowerExpr(e) {
  switch (e.kind) {
    case 'IntLit': case 'StringLit': case 'BoolLit':
      return { kind: e.kind, span: e.span, value: e.value };
    case 'Ident': return lowerIdent(e);
    case 'Paren': return lowerExpr(e.expr);
    case 'Unary': return { kind: 'Unary', span: e.span, op: e.op, operand: lowerExpr(e.operand) };
    case 'Call': return { kind: 'Call', span: e.span, callee: lowerIdent(e.callee), args: e.args.map(lowerExpr) };
    case 'ArrayLit': return { kind: 'ArrayLit', span: e.span, elements: e.elements.map(lowerExpr) };
    case 'Index': return { kind: 'Index', span: e.span, object: lowerExpr(e.object), index: lowerExpr(e.index) };
    case 'Binary': {
      const left = lowerExpr(e.left);
      const right = lowerExpr(e.right);
      if (e.op === '&&') {
        return synth({ kind: 'Cond', span: e.span, opSpan: e.opSpan, test: left, then: right, else: synth({ kind: 'BoolLit', span: e.span, value: false }) });
      }
      if (e.op === '||') {
        return synth({ kind: 'Cond', span: e.span, opSpan: e.opSpan, test: left, then: synth({ kind: 'BoolLit', span: e.span, value: true }), else: right });
      }
      return { kind: 'Binary', span: e.span, op: e.op, opSpan: e.opSpan, left, right };
    }
    default:
      throw new Error(`lower: unexpected expression kind '${e.kind}'`);
  }
}
