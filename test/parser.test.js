import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SourceFile } from '../src/source.js';
import { Diagnostics } from '../src/diagnostics.js';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { children, walk } from '../src/ast.js';

function parseText(text, name = 't.tth') {
  const diags = new Diagnostics();
  const tokens = lex(new SourceFile(name, text), diags);
  const ast = parse(tokens, diags);
  return { ast, tokens, diags: diags.items };
}

// Renders an expression fully parenthesised, to check precedence.
function show(e) {
  switch (e.kind) {
    case 'Binary': return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case 'Unary': return `(${e.op}${show(e.operand)})`;
    case 'Paren': return `[${show(e.expr)}]`;
    case 'Call': return `${e.callee.name}(${e.args.map(show).join(', ')})`;
    case 'Ident': return e.name;
    case 'StringLit': return JSON.stringify(e.value);
    default: return String(e.value);
  }
}

const expr = (src) => {
  const { ast, diags } = parseText(`${src};`);
  assert.deepEqual(diags, []);
  return show(ast.body[0].expr);
};

test('binary operators follow the precedence table', () => {
  assert.equal(expr('1 + 2 * 3'), '(1 + (2 * 3))');
  assert.equal(expr('1 * 2 + 3'), '((1 * 2) + 3)');
  assert.equal(expr('a || b && c'), '(a || (b && c))');
  assert.equal(expr('a == b < c'), '(a == (b < c))');
  assert.equal(expr('a < b + 1 && c != d'), '((a < (b + 1)) && (c != d))');
  assert.equal(expr('x % 2 == 0 || y'), '(((x % 2) == 0) || y)');
});

test('binary operators are left-associative', () => {
  assert.equal(expr('a - b - c'), '((a - b) - c)');
  assert.equal(expr('a / b * c % d'), '(((a / b) * c) % d)');
  assert.equal(expr('a || b || c'), '((a || b) || c)');
});

test('unary operators bind tighter than binary ones', () => {
  assert.equal(expr('-a * b'), '((-a) * b)');
  assert.equal(expr('!a && !!b'), '((!a) && (!(!b)))');
  assert.equal(expr('--1'), '(-(-1))');
});

test('parentheses and calls', () => {
  assert.equal(expr('(1 + 2) * 3'), '([(1 + 2)] * 3)');
  assert.equal(expr('f()'), 'f()');
  assert.equal(expr('g(1, h(x) + 2, "s")'), 'g(1, (h(x) + 2), "s")');
});

test('statements', () => {
  const { ast, diags } = parseText(`
    let a = 1;
    let b: bool = true;
    a += 2;
    a = a * 3;
    if (b) { print(a); } else if (!b) { print(0); } else { }
    while (a > 0) { a -= 1; }
    for (let i = 0; i < 3; i += 1) { }
    for (;;) { }
    { let c = "x"; }
    fn f(x: int, y: string): int { return x; }
    fn g() { return; }
  `);
  assert.deepEqual(diags, []);
  assert.deepEqual(ast.body.map((n) => n.kind), [
    'Let', 'Let', 'Assign', 'Assign', 'If', 'While', 'For', 'For', 'Block', 'FnDecl', 'FnDecl',
  ]);
  const [, letB, plusEq, , ifs, , forLoop, emptyFor, , f, g] = ast.body;
  assert.equal(letB.type.name, 'bool');
  assert.equal(plusEq.op, '+=');
  assert.equal(ifs.else.kind, 'If');
  assert.equal(ifs.else.else.kind, 'Block');
  assert.equal(forLoop.init.kind, 'Let');
  assert.equal(forLoop.update.kind, 'Assign');
  assert.deepEqual([emptyFor.init, emptyFor.cond, emptyFor.update], [null, null, null]);
  assert.deepEqual(f.params.map((p) => [p.name.name, p.type.name]), [['x', 'int'], ['y', 'string']]);
  assert.equal(f.returnType.name, 'int');
  assert.equal(g.returnType, null);
  assert.equal(g.body.body[0].value, null);
});

test('statement spans include their keyword and terminating semicolon', () => {
  const { ast } = parseText('  let x = 1 + 2;\nprint(x);');
  const [letStmt, printStmt] = ast.body;
  assert.deepEqual([letStmt.span.line, letStmt.span.col, letStmt.span.length], [1, 3, 14]);
  assert.deepEqual([printStmt.span.line, printStmt.span.col, printStmt.span.length], [2, 1, 9]);
  assert.deepEqual([ast.span.offset, ast.span.length], [2, 24]);
});

// FR-P2, checked over every benchmark: each node's span covers all of its
// children, children appear in source order without overlapping, and each
// leaf has exactly the span of a real token.
for (const file of readdirSync('examples').filter((f) => f.endsWith('.tth'))) {
  test(`span invariants hold across examples/${file}`, () => {
    const { ast, tokens, diags } = parseText(readFileSync(`examples/${file}`, 'utf8'), `examples/${file}`);
    assert.deepEqual(diags, []);
    const tokenSpans = new Set(tokens.map((t) => `${t.span.offset}:${t.span.length}`));
    let nodes = 0;
    walk(ast, (node) => {
      nodes++;
      const kids = [...children(node)].map(([, c]) => c);
      if (kids.length === 0) {
        assert.ok(tokenSpans.has(`${node.span.offset}:${node.span.length}`), `${node.kind} leaf has a token span`);
      }
      let prevEnd = node.span.offset;
      for (const c of kids) {
        assert.ok(c.span.offset >= prevEnd, `${c.kind} starts after its previous sibling inside ${node.kind}`);
        prevEnd = c.span.offset + c.span.length;
        assert.ok(prevEnd <= node.span.offset + node.span.length, `${c.kind} ends inside ${node.kind}`);
      }
    });
    assert.ok(nodes > 50);
  });
}

// ---- error recovery (FR-P3) ----------------------------------------------

test('reports several syntax errors in one run and keeps the good statements', () => {
  const { ast, diags } = parseText([
    'let a = ;',
    'let b = 2;',
    'print(b)',
    'let c = 3;',
    'if (c { print(c); }',
    'print(c);',
  ].join('\n'));
  assert.deepEqual(diags.map((d) => [d.span.line, d.message]), [
    [1, "expected an expression, found ';'"],
    [3, "expected ';' after print statement, found keyword 'let'"],
    [5, "expected ')' after if condition, found '{'"],
  ]);
  // b, c, the block recovered after the bad `if`, and the final print survive.
  assert.deepEqual(ast.body.map((n) => n.kind), ['Let', 'Let', 'Block', 'Print']);
});

test("a missing ';' is reported just after the previous token", () => {
  const { diags } = parseText('let a = 1\n\nlet b = 2;');
  assert.equal(diags.length, 1);
  assert.deepEqual([diags[0].span.line, diags[0].span.col, diags[0].span.length], [1, 10, 0]);
});

test('errors inside a function body recover inside that body', () => {
  const { ast, diags } = parseText('fn f(): int {\n  let = 1;\n  return 2;\n}\nprint(f());');
  assert.equal(diags.length, 1);
  assert.deepEqual(ast.body.map((n) => n.kind), ['FnDecl', 'Print']);
  assert.deepEqual(ast.body[0].body.body.map((n) => n.kind), ['Return']);
});

test('a missing closing brace is reported at end of file', () => {
  const { diags } = parseText('fn f() {\n  print(1);\n');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].message, "expected '}' to close the block, found end of file");
});

test('nested function declarations are rejected but parsing continues', () => {
  const { ast, diags } = parseText('fn outer() {\n  fn inner() { }\n  print(1);\n}');
  assert.deepEqual(diags.map((d) => d.message), ['functions can only be declared at the top level']);
  assert.deepEqual(diags[0].span.col, 6);
  assert.deepEqual(ast.body[0].body.body.map((n) => n.kind), ['Print']);
});

test('stray tokens never cause an infinite loop', () => {
  const { diags } = parseText(') ) } } else ; ; :');
  assert.ok(diags.length > 0);
});

test('stops after 20 syntax errors with a note', () => {
  const src = Array.from({ length: 30 }, () => 'let = 1;').join('\n');
  const { diags } = parseText(src);
  assert.equal(diags.filter((d) => d.severity === 'error').length, 20);
  assert.equal(diags.at(-1).severity, 'note');
  assert.match(diags.at(-1).message, /too many syntax errors \(20\)/);
});

test('lexer errors do not cascade into parser errors', () => {
  const { diags } = parseText('let s = "open;\nlet t = 1 & 2;\nlet u = #;\nprint(s);');
  assert.deepEqual(diags.map((d) => d.message), [
    'unterminated string literal',
    "unexpected character '&'; did you mean '&&'?",
    "unexpected character '#'",
  ]);
});
