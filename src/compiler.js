// The compilation pipeline. Each phase is a separate module that can be
// tested on its own (NFR-6). This file only wires them together.

import { SourceFile } from './source.js';
import { Diagnostics } from './diagnostics.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { lower } from './lower.js';
import { optimize } from './optimize.js';
import { emit } from './emit.js';
import { buildSourceMap } from './sourcemap.js';

// Lexing and parsing. The parser runs even when the lexer reported errors,
// so a single run reports as much as possible.
export function frontEnd(name, text) {
  const source = new SourceFile(name, text);
  const diags = new Diagnostics();
  const tokens = lex(source, diags);
  const ast = parse(tokens, diags);
  return { source, diags, tokens, ast };
}

// The whole pipeline. Each stage runs only if the stages before it raised no
// error (FR-S4), so `core`, `code` and `map` are null after any error.
//
// options:
//   jsFile      name of the generated file, written into the map's `file`
//   mapFile     value for the sourceMappingURL comment, or null for no map
//   sourcePath  path of the original file relative to the map file
//   optimise    true for -O1: constant folding and dead-code removal
export function compile(name, text, { jsFile = 'out.js', mapFile = `${jsFile}.map`, sourcePath = name, optimise = false } = {}) {
  const r = frontEnd(name, text);
  Object.assign(r, { core: null, code: null, table: null, map: null, optimisation: null });
  if (r.diags.hasErrors()) return r;
  check(r.ast, r.diags);
  if (r.diags.hasErrors()) return r;
  r.core = lower(r.ast);
  if (optimise) {
    const { program, stats } = optimize(r.core);
    r.core = program;
    r.optimisation = stats;
  }
  const { code, mappings } = emit(r.core, { mapUrl: mapFile });
  r.code = code;
  r.table = mappings;
  if (mapFile !== null) {
    r.map = buildSourceMap({ file: jsFile, source: sourcePath, sourceContent: text, table: mappings, lineCount: code.split('\n').length });
  }
  return r;
}
