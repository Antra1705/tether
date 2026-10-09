#!/usr/bin/env node
// Compiles the four benchmark programs into out/ (a PRD deliverable: each
// benchmark with its generated .js and .js.map), plus the runtime-error
// fixture that the debug harness (debug/index.html) uses for stack traces.
//
//   npm run build:examples
//   node out/fib.js
//   node --enable-source-maps out/fib.js

import { readdirSync } from 'node:fs';
import { main } from '../src/cli.js';

let failed = 0;
const inputs = readdirSync('examples').filter((n) => n.endsWith('.tth')).sort().map((f) => `examples/${f}`);
inputs.push('test/fixtures/stack-overflow.tth');
for (const file of inputs) {
  if (main(['build', file, '-o', 'out']) !== 0) failed++;
}
process.exitCode = failed ? 1 : 0;
