// Semantic analysis (FR-S1, FR-S2): scopes, types, return paths, and the
// JavaScript names the checker assigns (FR-G3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileText } from './support/run.js';

const errors = (text) => compileText(text).errors;
const ok = (text) => assert.deepEqual(errors(text), []);
const fails = (text, pattern) => {
  const es = errors(text);
  assert.equal(es.length, 1, `expected one error, got: ${JSON.stringify(es)}`);
  assert.match(es[0], pattern);
};

// ---- scopes (FR-S1) -------------------------------------------------------

test('every identifier must be declared', () => {
  fails('print(x);', /unknown variable 'x'/);
  fails('x = 1;', /unknown variable 'x'/);
  fails('print(f(1));', /unknown function 'f'/);
});

test('redeclaration in the same scope is an error, with a note at the first one', () => {
  const r = compileText('let x = 1;\nlet x = 2;');
  assert.deepEqual(r.errors, ["'x' is already declared in this scope"]);
  const d = r.diags.items[0];
  assert.equal(d.span.line, 2);
  assert.equal(d.notes[0].span.line, 1);
});

test('shadowing in a nested block is legal', () => {
  ok('let x = 1; { let x = true; print(x); } print(x + 1);');
  ok('fn f(n: int): int { if (n > 0) { let n = 2; return n; } return n; }');
});

test('a parameter and a top-level local of the same function share a scope', () => {
  fails('fn f(a: int): int { let a = 1; return a; }', /'a' is already declared/);
  fails('fn f(a: int, a: int) { }', /'a' is already declared/);
});

test('functions may be called before they are declared, and recursively', () => {
  ok('print(even(10));\nfn even(n: int): bool { if (n == 0) { return true; } return odd(n - 1); }\nfn odd(n: int): bool { if (n == 0) { return false; } return even(n - 1); }');
});

test('function bodies cannot see top-level variables', () => {
  fails('let limit = 3;\nfn f(): int { return limit; }', /unknown variable 'limit'/);
});

test('a for-loop variable is scoped to the loop', () => {
  fails('for (let i = 0; i < 3; i += 1) { } print(i);', /unknown variable 'i'/);
  ok('for (let i = 0; i < 3; i += 1) { } let i = 5; print(i);');
});

test('duplicate functions are reported once', () => {
  fails('fn f() { }\nfn f() { }', /'f' is already declared/);
});

// ---- types (FR-S2) -----------------------------------------------------------

test('mismatched operand types', () => {
  fails('print(1 + true);', /operator '\+' cannot be applied to 'int' and 'bool'/);
  fails('print(1 - true);', /operator '-' needs 'int' operands; this one is 'bool'/);
  fails('print(1 + "a");', /operator '\+' cannot be applied to 'int' and 'string'/);
  fails('print(true < false);', /operator '<' cannot be applied/);
  fails('print(1 && true);', /operator '&&' needs 'bool' operands; this one is 'int'/);
  fails('print(1 == "1");', /cannot compare 'int' with 'string'/);
  fails('print(-true);', /operator '-' needs an 'int' operand/);
  fails('print(!1);', /operator '!' needs a 'bool' operand/);
  ok('print("a" + "b"); print("a" == "b"); print(true != false); print(!(1 < 2) || 3 >= 4);');
});

test('non-boolean conditions', () => {
  fails('if (1) { }', /'if' condition must be 'bool', found 'int'/);
  fails('while ("x") { }', /'while' condition must be 'bool', found 'string'/);
  fails('for (let i = 0; i; i += 1) { }', /'for' condition must be 'bool'/);
});

test('wrong argument count and wrong argument type', () => {
  const add = 'fn add(a: int, b: int): int { return a + b; }\n';
  fails(`${add}print(add(1));`, /'add' expects 2 arguments, but got 1/);
  fails(`${add}print(add(1, 2, 3));`, /expects 2 arguments, but got 3/);
  fails(`${add}print(add(1, "2"));`, /argument 2 of 'add' must be 'int', found 'string'/);
});

test('declarations, assignments and compound assignments are typed', () => {
  fails('let x: int = "a";', /'x' is declared 'int', but is initialised with 'string'/);
  fails('let x = 1; x = false;', /cannot assign 'bool' to 'x', which is 'int'/);
  fails('let s = "a"; s -= "b";', /operator '-=' cannot be applied to 'string' and 'string'/);
  ok('let s = "a"; s += "b"; let n = 1; n *= 3; n %= 2;');
});

test('functions and variables are not interchangeable', () => {
  fails('fn f() { } let x = f;', /function 'f' cannot be used as a value/);
  fails('fn f() { } f = 1;', /cannot assign to 'f': it is a function/);
  fails('let g = 1; g(2);', /'g' is not a function/);
});

test('calls to functions without a return type have no value', () => {
  fails('fn f() { } let x = f();', /cannot initialise 'x' with a call that returns nothing/);
  fails('fn f() { } print(f());', /print needs a value/);
  ok('fn f() { } f();');
});

test('return statements match the function', () => {
  fails('return;', /'return' outside a function/);
  fails('fn f() { return 1; }', /'f' has no return type, so it cannot return a value/);
  fails('fn f(): int { return; }', /'f' must return a value of type 'int'/);
  fails('fn f(): int { return true; }', /'f' returns 'int', but this value is 'bool'/);
});

// ---- return paths (FR-S2) -------------------------------------------------------

test('a missing return on a value-returning path is reported at the function name', () => {
  const r = compileText('fn sign(n: int): int {\n  if (n > 0) { return 1; }\n}');
  assert.deepEqual(r.errors, ["function 'sign' does not return a value on every path"]);
  assert.equal(r.diags.items[0].span.col, 4);
});

test('definite-return analysis', () => {
  ok('fn f(n: int): int { if (n > 0) { return 1; } else { return 2; } }');
  ok('fn f(n: int): int { if (n > 0) { return 1; } else if (n < 0) { return -1; } else { return 0; } }');
  ok('fn f(n: int): int { { return n; } }');
  fails('fn f(n: int): int { if (n > 0) { return 1; } else if (n < 0) { return -1; } }', /does not return/);
  fails('fn f(n: int): int { while (true) { return 1; } }', /does not return/); // loops are conservative
  ok('fn f() { if (true) { return; } }');
});

// ---- no cascades -----------------------------------------------------------------

test('one mistake gives one error', () => {
  fails('print(missing + 1);', /unknown variable 'missing'/);
  fails('let x = missing; print(x * 2 + 1);', /unknown variable 'missing'/);
  fails('print(nope(1) + 2);', /unknown function 'nope'/);
  fails('fn f(a: int): int { return a; } print(f(true) + 1);', /argument 1 of 'f'/);
});

// ---- JavaScript names (FR-G3) ------------------------------------------------------

test('reserved JavaScript words and shadowing declarations get deterministic names', () => {
  const r = compileText('let var = 1;\nlet x = 2;\n{ let x = x + 1; let var = 3; print(x + var); }\nfn class(new: int): int { return new; }');
  assert.deepEqual(r.errors, []);
  assert.match(r.code, /let var\$ = 1;/);
  assert.match(r.code, /let x\$1 = x \+ 1;/);
  assert.match(r.code, /let var\$1 = 3;/);
  assert.match(r.code, /function class\$\(new\$\)/);
});
