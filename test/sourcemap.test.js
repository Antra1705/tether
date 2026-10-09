// Source map generation (milestone 6): FR-X1 – FR-X5, PRD section 7, AC-3.
//
// The reference decoder is Node's built-in SourceMap class (node:module). It
// is part of Node, not of this project, so it is independent of src/vlq.js
// and src/sourcemap.js (NFR-4) and adds no dependency (NFR-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { SourceMap } from 'node:module';
import { compile } from '../src/compiler.js';
import { encodeMappings } from '../src/sourcemap.js';
import { decodeVLQ } from '../src/vlq.js';
import { walk } from '../src/ast.js';
import { toMapPosition } from '../src/span.js';
import { main } from '../src/cli.js';

const benchmarks = readdirSync('examples').filter((f) => f.endsWith('.tth')).map((f) => f.slice(0, -4));

function build(name) {
  const text = readFileSync(`examples/${name}.tth`, 'utf8');
  const r = compile(`examples/${name}.tth`, text, { jsFile: `${name}.js`, sourcePath: `../examples/${name}.tth` });
  assert.equal(r.diags.errorCount, 0);
  return { r, text };
}

// Splits a mappings string into segments of absolute values, using the
// format's rules directly (a second, separate reading of the encoding).
function segments(mappings) {
  const out = [];
  const state = [0, 0, 0, 0, 0];
  mappings.split(';').forEach((line, genLine) => {
    state[0] = 0;
    for (const seg of line ? line.split(',') : []) {
      const fields = [];
      for (let pos = 0; pos < seg.length;) {
        const { value, next } = decodeVLQ(seg, pos);
        fields.push(value);
        pos = next;
      }
      fields.forEach((v, i) => { state[i] += v; });
      out.push({ genLine, fields: fields.length, abs: state.slice(0, fields.length) });
    }
  });
  return out;
}

for (const name of benchmarks) {
  test(`${name}: the map has the Source Map v3 fields (FR-X1, FR-X5)`, () => {
    const { r, text } = build(name);
    assert.deepEqual(Object.keys(r.map), ['version', 'file', 'sources', 'sourcesContent', 'names', 'mappings']);
    assert.equal(r.map.version, 3);
    assert.equal(r.map.file, `${name}.js`);
    assert.deepEqual(r.map.sources, [`../examples/${name}.tth`]);
    assert.deepEqual(r.map.sourcesContent, [text]);
    assert.match(r.map.mappings, /^[A-Za-z0-9+/,;]*$/);
  });

  test(`${name}: every mapping-table entry round-trips through Node's decoder (AC-3)`, () => {
    const { r } = build(name);
    const decoder = new SourceMap(r.map);
    for (const m of r.table) {
      const e = decoder.findEntry(m.generatedLine, m.generatedColumn);
      assert.equal(e.generatedLine, m.generatedLine);
      assert.equal(e.generatedColumn, m.generatedColumn);
      assert.equal(e.originalLine, m.originalLine);
      assert.equal(e.originalColumn, m.originalColumn);
      assert.equal(e.name ?? null, m.name);
    }
    assert.ok(r.table.length > 30);
  });

  test(`${name}: every segment is well formed and points into the source (PRD section 7)`, () => {
    const { r } = build(name);
    const lines = r.map.sourcesContent[0].split('\n');
    const segs = segments(r.map.mappings);
    assert.equal(segs.length, r.table.length);
    for (const s of segs) {
      assert.ok(s.fields === 4 || s.fields === 5, 'four or five fields (FR-X2)');
      const [, src, line, col, nameIdx] = s.abs;
      assert.equal(src, 0);
      assert.ok(line >= 0 && line < lines.length, `line ${line} exists`);
      assert.ok(col >= 0 && col < lines[line].length, `column ${col} exists on line ${line}`);
      if (s.fields === 5) assert.ok(nameIdx >= 0 && nameIdx < r.map.names.length, 'name index in bounds');
    }
  });

  test(`${name}: every statement and every identifier has a mapping (FR-X4)`, () => {
    const { r } = build(name);
    const mapped = new Set(r.table.map((m) => `${m.originalLine}:${m.originalColumn}`));
    const at = (span) => {
      const p = toMapPosition(span);
      return `${p.line}:${p.column}`;
    };
    walk(r.ast, (node, parent) => {
      const isStatement = parent && (parent.kind === 'Program' || parent.kind === 'Block');
      if (isStatement || node.kind === 'Ident') assert.ok(mapped.has(at(node.span)), `${node.kind} at ${node.span.line}:${node.span.col}`);
    });
  });
}

test('delta encoding matches the hand-computed example in the review report (FR-X3)', () => {
  const { r } = build('fib');
  // Line 0 is "use strict"; line 1 is `function fib(n) {`; line 2 is `  if (n < 2) {`.
  assert.ok(r.map.mappings.startsWith(';AAEA,SAAGA,IAAIC;EACL,IAAIA;'), r.map.mappings.slice(0, 40));
});

test('the generated column restarts on each line; the other fields carry on', () => {
  const { mappings, names } = encodeMappings([
    { generatedLine: 0, generatedColumn: 4, originalLine: 10, originalColumn: 6, name: 'a' },
    { generatedLine: 2, generatedColumn: 4, originalLine: 9, originalColumn: 2, name: null },
    { generatedLine: 2, generatedColumn: 8, originalLine: 9, originalColumn: 5, name: 'b' },
    { generatedLine: 3, generatedColumn: 0, originalLine: 9, originalColumn: 5, name: 'a' },
  ]);
  // [4,0,10,6,0] ; (empty line) ; [4,0,-1,-4] , [4,0,0,3,1] ; [0,0,0,0,-1]
  assert.equal(mappings, 'IAUMA;;IADJ,IAAGC;AAAAD');
  assert.deepEqual(names, ['a', 'b']);
});

test('the CLI writes a .js whose sourceMappingURL and sources resolve on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-'));
  try {
    const out = join(dir, 'build');
    let stderr = '';
    const code = main(['build', 'examples/primes.tth', '-o', out], {
      stdout: () => {}, stderr: (s) => { stderr += s; },
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, s) => writeFileSync(p, s),
      mkdir: (d) => mkdirSync(d, { recursive: true }),
    });
    assert.equal(code, 0, stderr);
    const js = readFileSync(join(out, 'primes.js'), 'utf8');
    const url = js.trimEnd().split('\n').pop().replace('//# sourceMappingURL=', '');
    const mapPath = resolve(out, url);
    assert.ok(existsSync(mapPath));
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    assert.equal(resolve(dirname(mapPath), map.sources[0]), resolve('examples/primes.tth'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node reports a runtime error at the original .tth line and column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-'));
  try {
    const src = join(dir, 'down.tth');
    writeFileSync(src, '// Recurses until the stack overflows.\n\nfn down(n: int): int {\n  return down(n + 1) + 1;\n}\n\nprint(down(0));\n');
    const code = main(['build', src, '-o', dir], {
      stdout: () => {}, stderr: () => {},
      readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, s) => writeFileSync(p, s), mkdir: () => {},
    });
    assert.equal(code, 0);
    const res = spawnSync(process.execPath, ['--enable-source-maps', join(dir, 'down.js')], { encoding: 'utf8' });
    assert.match(res.stderr, /RangeError: Maximum call stack size exceeded/);
    assert.match(res.stderr, /at down \(.*down\.tth:4:10\)/);
    const plain = spawnSync(process.execPath, [join(dir, 'down.js')], { encoding: 'utf8' });
    assert.match(plain.stderr, /down\.js:3:10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
