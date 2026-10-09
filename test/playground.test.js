// The playground runs the compiler modules in a browser, so nothing it loads
// may depend on Node built-ins. This test follows the imports from the
// modules the playground uses and fails if any of them reaches 'node:*'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const html = readFileSync('playground/index.html', 'utf8');

test('playground imports only browser-safe compiler modules', () => {
  const entry = [...html.matchAll(/from '\.\.\/(src\/[\w./-]+)'/g)].map((m) => m[1]);
  assert.ok(entry.length >= 5, 'found the playground imports');
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(!spec.startsWith('node:'), `${file} imports ${spec}, which browsers cannot load`);
      visit(normalize(join(dirname(file), spec)));
    }
  };
  entry.forEach(visit);
});

test('every example the playground offers exists', () => {
  for (const [, path] of html.matchAll(/path: '([^']+)'/g)) {
    assert.ok(readFileSync(path, 'utf8').length > 0, path);
  }
});
