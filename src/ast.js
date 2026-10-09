// AST schema.
//
// Nodes are plain objects with a `kind` and a `span`. CHILD_FIELDS lists, in
// source order, the fields of each kind that hold child nodes (a single node,
// null, or an array of nodes). Every pass that walks the tree goes through
// this table, so adding a node kind means adding exactly one entry here.
//
// Span invariant (FR-P2): a node's span is the union of the spans of its
// children and of the tokens it consumed directly (keywords, punctuation).
// A leaf takes its token's span.

export const CHILD_FIELDS = {
  Program: ['body'],
  FnDecl: ['name', 'params', 'returnType', 'body'],
  Param: ['name', 'type'],
  TypeRef: [],
  Block: ['body'],
  Let: ['name', 'type', 'init'],
  Assign: ['target', 'value'],
  If: ['cond', 'then', 'else'],
  While: ['cond', 'body'],
  For: ['init', 'cond', 'update', 'body'],
  Return: ['value'],
  Print: ['value'],
  ExprStmt: ['expr'],
  Binary: ['left', 'right'],
  Unary: ['operand'],
  Call: ['callee', 'args'],
  Paren: ['expr'],
  Cond: ['test', 'then', 'else'], // only in the lowered core tree (lower.js)
  Ident: [],
  IntLit: [],
  StringLit: [],
  BoolLit: [],
};

// Yields [fieldName, childNode] pairs in source order, skipping absent
// optional children.
export function* children(node) {
  const fields = CHILD_FIELDS[node.kind];
  if (!fields) throw new Error(`unknown AST node kind '${node.kind}'`);
  for (const field of fields) {
    const v = node[field];
    if (Array.isArray(v)) for (const c of v) yield [field, c];
    else if (v) yield [field, v];
  }
}

// Visits every node in the tree, parents before children.
export function walk(node, visit, parent = null) {
  visit(node, parent);
  for (const [, child] of children(node)) walk(child, visit, node);
}
