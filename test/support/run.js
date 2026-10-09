// Helpers shared by the test files. Contains no tests itself.

import vm from 'node:vm';
import { compile } from '../../src/compiler.js';

// Compiles Tether source text. Returns the compile() result plus the
// rendered diagnostic messages as plain strings.
export function compileText(text, name = 't.tth') {
  const r = compile(name, text, { jsFile: 't.js', sourcePath: name });
  r.errors = r.diags.items.filter((d) => d.severity === 'error').map((d) => d.message);
  return r;
}

// Runs generated JavaScript in a fresh context and returns what it printed,
// one string per console.log call.
export function runJs(code) {
  const lines = [];
  const context = vm.createContext({ console: { log: (...a) => lines.push(a.map(String).join(' ')) }, Math });
  vm.runInContext(code, context, { timeout: 5000 });
  return lines;
}

// Compiles and runs; fails loudly if the program does not compile.
export function run(text) {
  const r = compileText(text);
  if (r.errors.length) throw new Error(`did not compile:\n${r.errors.join('\n')}`);
  return runJs(r.code);
}
