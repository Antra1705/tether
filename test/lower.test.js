// Lowering (FR-M1, FR-M2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { walk } from '../src/ast.js';
import { compileText } from './support/run.js';

const lowered = (text) => {
  const r = compileText(text);
  assert.deepEqual(r.errors, []);
  return r;
};

const kinds = (node) => {
  const out = [];
  walk(node, (n) => out.push(n.kind));
  return out;
};

test('for becomes a block holding the initialiser and a while loop', () => {
  const { core } = lowered('for (let i = 0; i < 3; i += 1) { print(i); }');
  const block = core.body[0];
  assert.equal(block.kind, 'Block');
  assert.equal(block.synthetic, true);
  const [init, loop] = block.body;
  assert.equal(init.kind, 'Let');
  assert.equal(loop.kind, 'While');
  // The body is the original body followed by the update.
  assert.deepEqual(loop.body.body.map((s) => s.kind), ['Print', 'Assign']);
  assert.ok(!kinds(core).includes('For'));
});

test('a for without initialiser or condition', () => {
  const { core } = lowered('let i = 0; for (; ; i += 1) { if (i > 2) { return; } }'.replace('return;', 'i = 10;'));
  const loop = core.body[1];
  assert.equal(loop.kind, 'While');
  assert.equal(loop.cond.kind, 'BoolLit');
  assert.equal(loop.cond.value, true);
  assert.equal(loop.cond.synthetic, true);
});

test('compound assignment becomes assignment of a binary operation', () => {
  const { core } = lowered('let x = 1; x *= 3 + 4;');
  const a = core.body[1];
  assert.equal(a.op, '=');
  assert.equal(a.value.kind, 'Binary');
  assert.equal(a.value.op, '*');
  assert.equal(a.value.left.name, 'x');
  assert.equal(a.value.right.op, '+');
});

test('&& and || become conditional expressions', () => {
  const { core } = lowered('let a = true; let b = false; print(a && b); print(a || b);');
  const and = core.body[2].value;
  const or = core.body[3].value;
  assert.deepEqual([and.kind, and.test.name, and.then.name, and.else.value], ['Cond', 'a', 'b', false]);
  assert.deepEqual([or.kind, or.test.name, or.then.value, or.else.name], ['Cond', 'a', true, 'b']);
  assert.ok(!kinds(core).some((k) => k === 'Paren'));
});

test('lowering does not change the input tree', () => {
  const r = lowered('for (let i = 0; i < 2; i += 1) { print(i && true == true); }'.replace('i && true', 'true && true'));
  assert.ok(kinds(r.ast).includes('For'));
  assert.equal(r.ast.body[0].kind, 'For');
});

// FR-M2, over every benchmark: every lowered node has a span inside the
// program, and every node lowering created has exactly the span of the source
// construct that caused it.
for (const file of readdirSync('examples').filter((f) => f.endsWith('.tth'))) {
  test(`lowered nodes inherit their cause's span in examples/${file}`, () => {
    const { ast, core } = lowered(readFileSync(`examples/${file}`, 'utf8'));
    const causes = new Map();
    walk(ast, (n) => {
      if (n.kind === 'For' || (n.kind === 'Assign' && n.op !== '=') || (n.kind === 'Binary' && (n.op === '&&' || n.op === '||'))) {
        causes.set(`${n.span.offset}:${n.span.length}`, n.kind);
      }
    });
    const end = ast.span.offset + ast.span.length;
    let synthetic = 0;
    walk(core, (n) => {
      assert.ok(n.span && n.span.offset >= ast.span.offset && n.span.offset + n.span.length <= end, `${n.kind} span inside program`);
      if (n.synthetic) {
        synthetic++;
        assert.ok(causes.has(`${n.span.offset}:${n.span.length}`), `${n.kind} has the span of a for, compound assignment, && or ||`);
      }
    });
    assert.ok(synthetic > 0);
  });
}

test('a continue in a for loop runs the update first; a nested while keeps its own continue', () => {
  const { core } = lowered('for (let i = 0; i < 3; i += 1) { if (i == 1) { continue; } while (false) { continue; } }');
  const loop = core.body[0].body[1];
  const [guard, inner] = loop.body.body;
  // `if (i == 1) { i = i + 1; continue; }`: a synthetic copy of the update, with the update's span.
  const [update, cont] = guard.then.body;
  assert.deepEqual([update.kind, update.synthetic, update.span.col, update.span.length], ['Assign', true, 24, 6]);
  assert.equal(cont.kind, 'Continue');
  // The inner while's continue belongs to the inner while: no update before it.
  assert.deepEqual(inner.body.body.map((s) => s.kind), ['Continue']);
});

test('break needs no rewriting', () => {
  const { core } = lowered('for (let i = 0; i < 3; i += 1) { break; }');
  assert.deepEqual(core.body[0].body[1].body.body.map((s) => s.kind), ['Break', 'Assign']);
});
