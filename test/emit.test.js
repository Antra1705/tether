// JavaScript emission (FR-G1 – FR-G4) and runtime behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { jsString } from '../src/emit.js';
import { compileText, run, runJs } from './support/run.js';

test('integer division truncates toward zero; % keeps the sign of the dividend', () => {
  assert.deepEqual(run('print(7 / 2); print(-7 / 2); print(7 % 3); print(-7 % 3);'), ['3', '-3', '1', '-1']);
});

test('operators keep Tether precedence and associativity in the output', () => {
  assert.deepEqual(run('print((1 + 2) * 3); print(1 + 2 * 3); print(10 - (4 - 3)); print(10 - 4 - 3); print(100 / (10 / 2));'),
    ['9', '7', '9', '3', '20']);
  assert.deepEqual(run('let x = 5; print(- -x); print(-(-x)); print(!!(x > 1));'), ['5', '5', 'true']);
});

test('&& and || short-circuit after lowering', () => {
  const out = run(`
    fn loud(b: bool): bool { print("evaluated"); return b; }
    print(false && loud(true));
    print(true || loud(false));
    print(true && loud(false));`);
  assert.deepEqual(out, ['false', 'true', 'evaluated', 'false']);
});

test('strings, booleans and equality', () => {
  assert.deepEqual(run('print("a" + "b"); print("tab\\there"); print("q\\"uote"); print(1 == 1); print("a" != "a");'),
    ['ab', 'tab\there', 'q"uote', 'true', 'false']);
});

test('jsString escapes characters ES2015 does not allow raw in a string', () => {
  assert.equal(jsString('a b c'), '"a\\u2028b\\u2029c"');
  assert.equal(eval(jsString('x "\\\n')), 'x "\\\n');
});

test('shadowing behaves as in Tether, not as JavaScript\'s temporal dead zone would', () => {
  assert.deepEqual(run('let x = 1;\n{ let x = x + 1; print(x); }\nprint(x);'), ['2', '1']);
  assert.deepEqual(run('for (let i = 0; i < 2; i += 1) { let i = 10; print(i); }'), ['10', '10']);
});

test('names that are reserved in JavaScript still work', () => {
  assert.deepEqual(run('let var = 1; let class = 2; let console = 3; let Math = 4; print(var + class + console + Math / 4);'), ['7']);
});

test('the output is ES2015: strict mode, let, no newer syntax', () => {
  const { code } = compileText(readFileSync('examples/fizzbuzz.tth', 'utf8'));
  assert.ok(code.startsWith('"use strict";\n'));
  assert.doesNotMatch(code, /\?\?|\?\.|=>|\bclass\s|\bconst\s|\bvar\s|`/);
});

test('the last line is the sourceMappingURL comment (FR-G4), and --no-map omits it', () => {
  const text = readFileSync('examples/fib.tth', 'utf8');
  const withMap = compile('fib.tth', text, { jsFile: 'fib.js' });
  const lines = withMap.code.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], '//# sourceMappingURL=fib.js.map');
  const noMap = compile('fib.tth', text, { jsFile: 'fib.js', mapFile: null });
  assert.doesNotMatch(noMap.code, /sourceMappingURL/);
  assert.equal(noMap.map, null);
  assert.deepEqual(runJs(noMap.code), runJs(withMap.code));
});

test('generated positions in the mapping table point at the text they describe', () => {
  const r = compileText(readFileSync('examples/collatz.tth', 'utf8'));
  const lines = r.code.split('\n');
  for (const m of r.table) {
    if (m.name === null) continue;
    const name = m.span ? r.source.text.slice(m.span.offset, m.span.offset + m.span.length) : '';
    assert.equal(name, m.name);
    const jsText = lines[m.generatedLine].slice(m.generatedColumn);
    assert.ok(jsText.startsWith(m.name), `${m.name} at ${m.generatedLine}:${m.generatedColumn}`);
  }
});

test('compilation is deterministic (NFR-2)', () => {
  const text = readFileSync('examples/fizzbuzz.tth', 'utf8');
  const a = compile('fizzbuzz.tth', text, { jsFile: 'fizzbuzz.js' });
  const b = compile('fizzbuzz.tth', text, { jsFile: 'fizzbuzz.js' });
  assert.equal(a.code, b.code);
  assert.equal(JSON.stringify(a.map), JSON.stringify(b.map));
});

test('no code is generated when there are errors (FR-S4)', () => {
  const r = compileText('print(1 + true);');
  assert.equal(r.code, null);
  assert.equal(r.map, null);
});

test('break and continue behave as in C and Java, including continue in a for loop', () => {
  assert.deepEqual(run(`
    for (let i = 0; i < 10; i += 1) {
      if (i % 3 == 0) { continue; }
      if (i > 7) { break; }
      print(i);
    }`), ['1', '2', '4', '5', '7']);
  // Without the update before continue, this loop would never end.
  assert.deepEqual(run('let n = 0; for (let i = 0; i < 5; i += 1) { continue; } print(n);'), ['0']);
  assert.deepEqual(run('let i = 0; while (true) { i += 1; if (i < 3) { continue; } break; } print(i);'), ['3']);
});

test('arrays: literals, indexing, element assignment, len, push and printing', () => {
  assert.deepEqual(run(`
    fn sum(xs: int[]): int { let t = 0; for (let i = 0; i < len(xs); i += 1) { t += xs[i]; } return t; }
    let xs = [3, 1, 4];
    xs[1] = 9;
    push(xs, 2);
    print(xs);
    print(sum(xs));
    print(len("tether"));
    let words: string[] = [];
    push(words, "a");
    push(words, "b");
    print(words);
    print([true, false]);`), ['[3, 9, 4, 2]', '18', '6', '[a, b]', '[true, false]']);
});

test('arrays are passed by reference, as in Java', () => {
  assert.deepEqual(run('fn grow(xs: int[]) { push(xs, 0); } let a = [1]; grow(a); print(len(a));'), ['2']);
});

test('the index helpers are emitted only into programs that index an array', () => {
  assert.doesNotMatch(compileText('let xs = [1]; print(len(xs));').code, /\$get/);
  assert.match(compileText('let xs = [1]; print(xs[0]);').code, /^"use strict";\nfunction \$get/);
});

test('an index out of range throws a RangeError instead of reading undefined', () => {
  assert.throws(() => run('let xs = [1, 2]; print(xs[2]);'), (e) => e.name === 'RangeError' && /index 2 is out of range for an array of length 2/.test(e.message));
  assert.throws(() => run('let xs = [1]; xs[-1] = 5;'), /index -1 is out of range for an array of length 1/);
});
