// -O1: constant folding, dead-code removal, and mapping retention
// (FR-O1 – FR-O3, AC-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { mappingRetention } from '../src/optimize.js';
import { walk } from '../src/ast.js';
import { runJs } from './support/run.js';

const O1 = (text) => {
  const r = compile('t.tth', text, { jsFile: 't.js', optimise: true });
  assert.equal(r.diags.errorCount, 0, JSON.stringify(r.diags.items.map((d) => d.message)));
  return r;
};
const O0 = (text) => compile('t.tth', text, { jsFile: 't.js' });
const body = (r) => r.code.split('\n').slice(1, -2).join('\n');

test('folds integer arithmetic, with division truncating toward zero', () => {
  assert.equal(body(O1('print(2 * 3 + 4);')), 'console.log(10);');
  assert.equal(body(O1('print(7 / 2); print(-7 / 2); print(7 % 3);')), 'console.log(3);\nconsole.log(-3);\nconsole.log(1);');
  assert.equal(body(O1('print(-(2 + 3));')), 'console.log(-5);');
});

test('folds comparisons, equality, logic and string concatenation', () => {
  assert.equal(body(O1('print(1 < 2); print(3 == 4); print("a" != "b"); print(!true);')),
    'console.log(true);\nconsole.log(false);\nconsole.log(true);\nconsole.log(false);');
  assert.equal(body(O1('print(true && 1 > 2); print(false || 2 > 1);')), 'console.log(false);\nconsole.log(true);');
  assert.equal(body(O1('print("te" + "th" + "er");')), 'console.log("tether");');
});

test('keeps an expression whenever folding could change the result', () => {
  assert.match(body(O1('print(1 / 0);')), /Math\.trunc\(1 \/ 0\)/);         // Infinity at run time
  assert.match(body(O1('print(1 % 0);')), /1 % 0/);                          // NaN at run time
  assert.match(body(O1('print(0 * -1);')), /0 \* -1/);                       // -0 at run time
  assert.match(body(O1('print(9007199254740991 + 1);')), /9007199254740991 \+ 1/); // not a safe integer
});

test('a constant that is never assigned is propagated, and folding continues', () => {
  assert.equal(body(O1('let x = 2; print(x * 3);')), 'let x = 2;\nconsole.log(6);');
  assert.equal(body(O1('let a = 2; let b = a * 3; print(b);')), 'let a = 2;\nlet b = 6;\nconsole.log(6);');
  assert.equal(body(O1('let s = "te"; print(s + "ther");')), 'let s = "te";\nconsole.log("tether");');
});

test('a variable that is assigned anywhere is not a constant', () => {
  assert.equal(body(O1('let x = 2; x = 3; print(x);')), 'let x = 2;\nx = 3;\nconsole.log(x);');
  assert.match(body(O1('let i = 0; while (i < 3) { i += 1; } print(i);')), /console\.log\(i\)/);
  assert.match(body(O1('let n = f(); print(n); fn f(): int { return 1; }')), /console\.log\(n\)/); // not a literal
});

test('propagation follows the checker\'s symbols, so shadowing cannot mix variables up', () => {
  const r = O1('let n = 1; { let n = 2; n = 3; print(n); } print(n);');
  assert.deepEqual(runJs(r.code), ['3', '1']);
  assert.match(r.code, /console\.log\(n\$1\);\n\}\nconsole\.log\(1\);/);
});

test('a propagated constant takes the span of the identifier it replaces', () => {
  const r = O1('let limit = 10;\nprint(limit);');
  const lits = [];
  walk(r.core, (n) => { if (n.folded) lits.push([n.kind, n.value, n.span.line, n.span.col, n.span.length]); });
  assert.deepEqual(lits, [['IntLit', 10, 2, 7, 5]]);
  assert.equal(r.optimisation.propagated, 1);
});

test('a folded expression takes the span of the whole expression (FR-O2)', () => {
  // x is assigned, so it is not a constant and stays a variable.
  const r = O1('let x = 1;\nx = 4;\nprint(x + (2 * 3 - 1));');
  const spans = [];
  walk(r.core, (n) => { if (n.folded) spans.push([n.kind, n.value, n.span.line, n.span.col, n.span.length]); });
  // `(2 * 3 - 1)` lost its parentheses in lowering; the literal 5 covers `2 * 3 - 1`.
  assert.deepEqual(spans, [['IntLit', 5, 3, 12, 9]]);
});

test('removes dead branches, dead loops and code after return', () => {
  const r = O1(`
    fn f(): int { return 1; print("gone"); }
    if (false) { print("gone"); }
    if (true) { print("kept"); } else { print("gone"); }
    if (1 > 2) { print("gone"); } else if (2 > 1) { print("kept too"); } else { print("gone"); }
    while (false) { print("gone"); }
    print(f());`);
  assert.doesNotMatch(r.code, /gone|while|if/);
  assert.deepEqual(runJs(r.code), ['kept', 'kept too', '1']);
  assert.equal(r.optimisation.removed, 11); // 1 + 2 + 2 + 4 + 2 statements
});

test('a loop that may run is kept', () => {
  assert.match(body(O1('let i = 0; while (i < 3) { i += 1; }')), /while \(i < 3\)/);
});

// -O1 must never change what a program prints.
const programs = [
  ...readdirSync('examples').filter((f) => f.endsWith('.tth')).map((f) => `examples/${f}`),
  'test/fixtures/optimisable.tth',
];
for (const file of programs) {
  test(`${file}: -O1 output equals -O0 output`, () => {
    const text = readFileSync(file, 'utf8');
    assert.deepEqual(runJs(O1(text).code), runJs(O0(text).code));
  });
}

test('mapping retention: all statements keep a mapping at -O0; dead code loses its mappings at -O1 (FR-O3)', () => {
  const text = readFileSync('test/fixtures/optimisable.tth', 'utf8');
  const a = O0(text);
  const b = O1(text);
  assert.deepEqual(mappingRetention(a.ast, a.table), { statements: 14, kept: 14, mappings: 55, ratio: 1 });
  assert.deepEqual(mappingRetention(b.ast, b.table), { statements: 14, kept: 7, mappings: 24, ratio: 0.5 });
  assert.deepEqual(b.optimisation, { folded: 8, propagated: 1, removed: 7 });
});

test('an -O1 source map is still valid: every entry round-trips through Node\'s decoder', async () => {
  const { SourceMap } = await import('node:module');
  const r = O1(readFileSync('test/fixtures/optimisable.tth', 'utf8'));
  const decoder = new SourceMap(r.map);
  for (const m of r.table) {
    const e = decoder.findEntry(m.generatedLine, m.generatedColumn);
    assert.deepEqual([e.originalLine, e.originalColumn], [m.originalLine, m.originalColumn]);
  }
});

test('statements after break or continue are dead code at -O1', () => {
  const r = O1('for (let i = 0; i < 3; i += 1) { if (i == 1) { continue; print("gone"); } print(i); break; print("gone"); }');
  assert.doesNotMatch(r.code, /gone/);
  assert.deepEqual(runJs(r.code), ['0']);
  // The two prints. The update that lowering appends after `break` can never
  // run and is dropped too, but it is part of the for statement, not a source
  // statement of its own, so it is not counted.
  assert.equal(r.optimisation.removed, 2);
  assert.doesNotMatch(r.code, /break;\n\s*i = i \+ 1;/);
});

test('a loop body that always breaks or continues has no dead source code, so nothing is counted as removed', () => {
  const r = O1('for (let i = 0; i < 6; i += 1) { if (i == 2) { print(i); continue; } else { break; } }');
  assert.equal(r.optimisation.removed, 0);
  assert.deepEqual(runJs(r.code), []);
});

test('-O1 folds inside arrays and indexes but never propagates an array', () => {
  const r = O1('let xs = [1 + 1, 2 * 3];\nprint(xs[2 - 1]);');
  assert.match(r.code, /let xs = \[2, 6\];/);
  assert.match(r.code, /\$get\(xs, 1\)/);
  assert.deepEqual(runJs(r.code), ['6']);
});
