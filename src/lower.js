// Lowering (FR-M1, FR-M2).
//
// lower() turns the checked AST into a smaller core tree that the emitter
// translates almost one to one. It builds a new tree and leaves the input
// unchanged.
//
//   for (init; cond; update) B   ->  { init; while (cond) { B...; update; } }
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
// Moving the update to the end of the loop body is safe because Tether has no
// `break` or `continue`. Folding the body's statements into the loop block is
// safe because the checker has already given any shadowing declaration in the
// body its own JavaScript name.

export function lower(program) {
  return { kind: 'Program', span: program.span, body: program.body.map(lowerStmt) };
}

const synth = (node) => ({ ...node, synthetic: true });

function lowerIdent(id) {
  return { kind: 'Ident', span: id.span, name: id.name, symbol: id.symbol };
}

function lowerBlock(block) {
  return { kind: 'Block', span: block.span, body: block.body.map(lowerStmt) };
}

function lowerStmt(s) {
  switch (s.kind) {
    case 'FnDecl':
      return {
        kind: 'FnDecl', span: s.span, name: lowerIdent(s.name),
        params: s.params.map((p) => ({ kind: 'Param', span: p.span, name: lowerIdent(p.name), type: null })),
        returnType: null, body: lowerBlock(s.body),
      };
    case 'Let':
      return { kind: 'Let', span: s.span, name: lowerIdent(s.name), type: null, init: lowerExpr(s.init) };
    case 'Assign': {
      const target = lowerIdent(s.target);
      if (s.op === '=') return { kind: 'Assign', span: s.span, op: '=', target, value: lowerExpr(s.value) };
      const value = synth({ kind: 'Binary', span: s.span, op: s.op[0], left: lowerIdent(s.target), right: lowerExpr(s.value) });
      return synth({ kind: 'Assign', span: s.span, op: '=', target, value });
    }
    case 'ExprStmt': return { kind: 'ExprStmt', span: s.span, expr: lowerExpr(s.expr) };
    case 'Print': return { kind: 'Print', span: s.span, value: lowerExpr(s.value) };
    case 'Return': return { kind: 'Return', span: s.span, value: s.value ? lowerExpr(s.value) : null };
    case 'Block': return lowerBlock(s);
    case 'If':
      return {
        kind: 'If', span: s.span, cond: lowerExpr(s.cond), then: lowerBlock(s.then),
        else: s.else ? (s.else.kind === 'If' ? lowerStmt(s.else) : lowerBlock(s.else)) : null,
      };
    case 'While':
      return { kind: 'While', span: s.span, cond: lowerExpr(s.cond), body: lowerBlock(s.body) };
    case 'For': return lowerFor(s);
    default:
      throw new Error(`lower: unexpected statement kind '${s.kind}'`);
  }
}

function lowerFor(s) {
  const body = lowerBlock(s.body);
  if (s.update) body.body.push(lowerStmt(s.update));
  const cond = s.cond ? lowerExpr(s.cond) : synth({ kind: 'BoolLit', span: s.span, value: true });
  const loop = synth({ kind: 'While', span: s.span, cond, body });
  if (!s.init) return loop;
  // The block keeps the loop variable scoped to the loop.
  return synth({ kind: 'Block', span: s.span, body: [lowerStmt(s.init), loop] });
}

function lowerExpr(e) {
  switch (e.kind) {
    case 'IntLit': case 'StringLit': case 'BoolLit':
      return { kind: e.kind, span: e.span, value: e.value };
    case 'Ident': return lowerIdent(e);
    case 'Paren': return lowerExpr(e.expr);
    case 'Unary': return { kind: 'Unary', span: e.span, op: e.op, operand: lowerExpr(e.operand) };
    case 'Call': return { kind: 'Call', span: e.span, callee: lowerIdent(e.callee), args: e.args.map(lowerExpr) };
    case 'Binary': {
      const left = lowerExpr(e.left);
      const right = lowerExpr(e.right);
      if (e.op === '&&') {
        return synth({ kind: 'Cond', span: e.span, test: left, then: right, else: synth({ kind: 'BoolLit', span: e.span, value: false }) });
      }
      if (e.op === '||') {
        return synth({ kind: 'Cond', span: e.span, test: left, then: synth({ kind: 'BoolLit', span: e.span, value: true }), else: right });
      }
      return { kind: 'Binary', span: e.span, op: e.op, left, right };
    }
    default:
      throw new Error(`lower: unexpected expression kind '${e.kind}'`);
  }
}
