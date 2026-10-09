// End-to-end tests through the CLI, including golden files (NFR-6).
//
// Golden files live in test/golden. To regenerate them after an intentional
// change to an output format, run `npm run test:update-golden` and review
// the diff. Generated JavaScript is stored as <name>.js.txt so that the test
// runner does not mistake it for a test file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { main } from '../src/cli.js';
import { runJs } from './support/run.js';

const UPDATE = process.env.TETHER_UPDATE_GOLDEN === '1';

// Runs the CLI in-process. Files it writes are kept in memory.
function runCli(...argv) {
  let stdout = '';
  let stderr = '';
  const files = new Map();
  const dirs = [];
  const code = main(argv, {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, s) => files.set(p.split('\\').join('/'), s),
    mkdir: (d) => dirs.push(d),
  });
  return { code, stdout, stderr, files, dirs };
}

function golden(name, actual) {
  const path = `test/golden/${name}`;
  if (UPDATE || !existsSync(path)) {
    writeFileSync(path, actual);
    if (!UPDATE) assert.fail(`created missing golden file ${path}; review it and re-run`);
    return;
  }
  assert.equal(actual, readFileSync(path, 'utf8'), `output differs from ${path}`);
}

const benchmarks = readdirSync('examples').filter((f) => f.endsWith('.tth')).map((f) => f.slice(0, -4));

test('there are four benchmark programs', () => {
  assert.deepEqual(benchmarks.sort(), ['collatz', 'fib', 'fizzbuzz', 'primes']);
});

for (const name of benchmarks) {
  test(`${name}: --dump-tokens matches golden`, () => {
    const r = runCli('build', `examples/${name}.tth`, '--dump-tokens');
    assert.equal(r.code, 0, r.stderr);
    golden(`${name}.tokens`, r.stdout);
  });

  test(`${name}: --dump-ast matches golden`, () => {
    const r = runCli('build', `examples/${name}.tth`, '--dump-ast');
    assert.equal(r.code, 0, r.stderr);
    golden(`${name}.ast`, r.stdout);
  });

  test(`${name}: --dump-core matches golden (FR-M3)`, () => {
    const r = runCli('build', `examples/${name}.tth`, '--dump-core');
    assert.equal(r.code, 0, r.stderr);
    golden(`${name}.core`, r.stdout);
  });

  test(`${name}: --dump-mappings matches golden`, () => {
    const r = runCli('build', `examples/${name}.tth`, '--dump-mappings');
    assert.equal(r.code, 0, r.stderr);
    golden(`${name}.mappings`, r.stdout);
  });

  test(`${name}: build writes .js and .js.map that match golden`, () => {
    const r = runCli('build', `examples/${name}.tth`, '-o', 'out');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...r.files.keys()], [`out/${name}.js`, `out/${name}.js.map`]);
    golden(`${name}.js.txt`, r.files.get(`out/${name}.js`));
    golden(`${name}.js.map`, r.files.get(`out/${name}.js.map`));
  });

  test(`${name}: the generated program prints exactly the expected output (AC-1)`, () => {
    const r = runCli('build', `examples/${name}.tth`);
    assert.equal(r.code, 0, r.stderr);
    const out = runJs(r.files.get(`out/${name}.js`));
    assert.equal(`${out.join('\n')}\n`, readFileSync(`test/expected/${name}.out`, 'utf8'));
  });

  test(`${name}: -O1 prints the same output, and --map-report records retention (AC-6)`, () => {
    const r = runCli('build', `examples/${name}.tth`, '-O1');
    assert.equal(r.code, 0, r.stderr);
    const out = runJs(r.files.get(`out/${name}.js`));
    assert.equal(`${out.join('\n')}\n`, readFileSync(`test/expected/${name}.out`, 'utf8'));
    golden(`${name}.map-report`, runCli('build', `examples/${name}.tth`, '--map-report').stdout);
  });

  test(`${name}: output is deterministic (NFR-2)`, () => {
    const flags = ['--dump-tokens', '--dump-ast', '--dump-core', '--dump-mappings'];
    const a = runCli('build', `examples/${name}.tth`, ...flags);
    const b = runCli('build', `examples/${name}.tth`, ...flags);
    assert.equal(a.stdout, b.stdout);
    assert.deepEqual(runCli('build', `examples/${name}.tth`).files, runCli('build', `examples/${name}.tth`).files);
  });
}

for (const fixture of ['syntax-errors', 'lex-errors', 'semantic-errors']) {
  test(`${fixture}.tth: diagnostics match golden and exit code is 1`, () => {
    const r = runCli('build', `test/fixtures/${fixture}.tth`);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.files.size, 0, 'no output written (FR-S4)');
    golden(`${fixture}.stderr`, r.stderr);
  });
}

test('syntax-errors.tth reports all seven errors in one run', () => {
  const r = runCli('build', 'test/fixtures/syntax-errors.tth');
  assert.equal(r.stderr.match(/: error: /g).length, 7);
});

test('semantic-errors.tth reports all eight errors in one run, with no cascades (AC-4)', () => {
  const r = runCli('build', 'test/fixtures/semantic-errors.tth');
  const lines = r.stderr.match(/:\d+:\d+: error: .*/g).map((l) => l.replace(/^.*?:(\d+):(\d+): error: /, '$1:$2 '));
  assert.deepEqual(lines, [
    "9:4 function 'sign' does not return a value on every path",
    "15:14 'x' is declared 'int', but is initialised with 'bool'",
    "16:5 'x' is already declared in this scope",
    "17:5 'if' condition must be 'bool', found 'int'",
    "20:7 'add' expects 2 arguments, but got 1",
    "21:14 argument 2 of 'add' must be 'int', found 'string'",
    "22:7 unknown variable 'total'",
    "23:7 operator '+' cannot be applied to 'int' and 'string'",
  ]);
});

test('exit codes (FR-C2)', () => {
  assert.equal(runCli('build', 'examples/fib.tth').code, 0);
  assert.equal(runCli('build', 'test/fixtures/syntax-errors.tth').code, 1);
  assert.equal(runCli('build', 'test/fixtures/semantic-errors.tth').code, 1);
  assert.equal(runCli('build', 'no/such/file.tth').code, 1);
  assert.equal(runCli('build').code, 2);
  assert.equal(runCli('frobnicate', 'x').code, 2);
  assert.equal(runCli('build', 'examples/fib.tth', '--bogus').code, 2);
  assert.equal(runCli('build', 'examples/fib.tth', '-o').code, 2);
});

test('accepts the full FR-C1 flag set', () => {
  const r = runCli('build', 'examples/fib.tth', '-o', 'dist', '-O1', '--no-map');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([...r.files.keys()], ['dist/fib.js']);
  assert.doesNotMatch(r.files.get('dist/fib.js'), /sourceMappingURL/);
});

test('-O1 folds constants and removes dead code, without changing the output', () => {
  const r0 = runCli('build', 'test/fixtures/optimisable.tth');
  const r1 = runCli('build', 'test/fixtures/optimisable.tth', '-O1');
  assert.equal(r1.code, 0, r1.stderr);
  const js0 = r0.files.get('out/optimisable.js');
  const js1 = r1.files.get('out/optimisable.js');
  assert.match(js0, /24 \* 60 \* 60/);
  assert.match(js1, /let secondsPerDay = 86400;/);
  assert.doesNotMatch(js1, /never|unreachable/);
  assert.deepEqual(runJs(js1), runJs(js0));
  golden('optimisable.O1.js.txt', js1);
});

test('--map-report compares mapping retention at -O0 and -O1 (FR-O3)', () => {
  const r = runCli('build', 'test/fixtures/optimisable.tth', '--map-report');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.files.size, 0);
  golden('optimisable.map-report', r.stdout);
});

test('dump flags print instead of writing files', () => {
  const r = runCli('build', 'examples/fib.tth', '--dump-core');
  assert.equal(r.code, 0);
  assert.equal(r.files.size, 0);
  assert.match(r.stdout, /While @\d+:\d+\+\d+ \[lowered\]/);
});

test('an exception inside the compiler is an internal error: exit 2', () => {
  let stderr = '';
  const code = main(['build', 'examples/fib.tth', '--dump-tokens'], {
    stdout: () => { throw new Error('simulated failure'); },
    stderr: (s) => { stderr += s; },
    readFile: (p) => readFileSync(p, 'utf8'),
  });
  assert.equal(code, 2);
  assert.match(stderr, /internal compiler error: Error: simulated failure/);
});
