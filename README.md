# Tether

A source-mapped transpiler for a small statically typed language. It compiles
to ECMAScript 2015 and emits a Source Map v3 file, so that an ordinary
JavaScript debugger can show breakpoints and stack traces in the original
source. See `docs/Tether-PRD.pdf` for the full requirements.

Requires Node 18 or later. No dependencies (NFR-1).

## Status: all 8 milestones complete

| Week | Milestone | Exit criterion and evidence |
|-----:|-----------|-----------------------------|
| 1 | Grammar frozen in BNF; scanner with spans | `--dump-tokens` prints a span for every token |
| 2 | Recursive-descent parser and AST | `--dump-ast` prints spans; all four benchmarks parse |
| 3 | Symbol table, type checking, caret diagnostics | **AC-4:** `semantic-errors.tth` reports eight errors in one run |
| 4 | Lowering; JavaScript emitter | **AC-1:** all four benchmarks print exactly their expected output |
| 5 | Base64 VLQ encoder and mapping table | Encoder passes the test vectors; `--dump-mappings` |
| 6 | Source map and reference-decoder validation | **AC-3:** 100% of mappings round-trip through Node's independent decoder |
| 7 | Browser verification | **AC-2:** 20 of 20 breakpoints set in Chrome DevTools on `.tth` lines halt there. **AC-5:** the browser stack trace names `stack-overflow.tth:6`. See `docs/browser-verification.md` |
| 8 | `-O1` and fidelity measurement | **AC-6:** retention at -O0 and -O1 recorded in `docs/fidelity.md` |

Every requirement in the PRD is implemented: FR-L1–L5, FR-P1–P4, FR-S1–S4,
FR-M1–M3, FR-G1–G4, FR-X1–X5, FR-C1–C3, FR-O1–O3, and NFR-1 to NFR-6.

## Since the final review

| Change | Where |
|--------|-------|
| Mappings inside expressions: every expression and every binary operator, not only statements and identifiers (PRD open question 1) | `src/emit.js`, `docs/positions.md` |
| `break` and `continue`; a `continue` in a `for` loop runs the update first | `src/lower.js`, `docs/semantics.md` |
| Arrays: `int[]`, `[1, 2]`, `xs[i]`, `xs[i] = v`, `len`, `push`, with bounds checks whose errors map to the `.tth` line | `docs/grammar.md` (revision 2), `docs/semantics.md` |
| `-O1` constant propagation | `src/optimize.js`, `docs/fidelity.md` |
| The source map writes a group for every generated line: Node's decoder misreads a string that ends in a segment (found by the tests) | `src/sourcemap.js`, `docs/positions.md` |
| Continuous integration on Node 18, 20 and 22 | `.github/workflows/test.yml` |
| Playground: a Source map tab, shareable links, and downloads of the `.js` and `.js.map` | `playground/index.html` |
| Playground: the tether line from output back to source, motion that marks phase changes (off under reduced motion), and runtime errors in **Run** mapped to the `.tth` line | `playground/index.html` |
| Playground fixes: a program that prints forever no longer freezes the page (output stops at 1000 lines), a new run stops the previous one, and programs run in strict mode as in Node | `playground/index.html` |
| `npm test` runs only the `*.test.js` files (it used to count a helper file as a test as well) | `package.json` |

`test/fixtures/sieve.tth` uses all of the new language features.

## Usage

```sh
node bin/tether.js build examples/fib.tth          # writes out/fib.js and out/fib.js.map
node out/fib.js                                     # run it
node --enable-source-maps out/fib.js                # runtime errors point at fib.tth

node bin/tether.js build examples/fib.tth -o dist   # choose the output directory
node bin/tether.js build examples/fib.tth --no-map  # JavaScript only
node bin/tether.js build examples/fib.tth -O1       # constant folding, propagation and dead-code removal

npm run build:examples                              # all benchmarks into out/
```

These flags print instead of writing files:

```sh
node bin/tether.js build examples/fib.tth --dump-tokens     # tokens with spans
node bin/tether.js build examples/fib.tth --dump-ast        # syntax tree with spans
node bin/tether.js build examples/fib.tth --dump-core       # lowered tree; [lowered] / [folded] mark new nodes
node bin/tether.js build examples/fib.tth --dump-mappings   # mapping table, before VLQ encoding
node bin/tether.js build examples/fib.tth --map-report      # statements that keep a mapping at -O0 and -O1
```

Fixtures:

```sh
node bin/tether.js build test/fixtures/syntax-errors.tth     # 7 syntax errors, exit 1
node bin/tether.js build test/fixtures/semantic-errors.tth   # 8 type and scope errors, exit 1
node bin/tether.js build test/fixtures/optimisable.tth -O1   # what -O1 folds and removes
node bin/tether.js build test/fixtures/stack-overflow.tth && node --enable-source-maps out/stack-overflow.js
```

Exit codes: 0 success, 1 compile error, 2 internal or usage error.

## Debugging in Chrome

```sh
npm run build:examples
npm run playground        # serves the project on http://localhost:5173
```

Open `http://localhost:5173/debug/?program=fib`, open DevTools → Sources, and
open `examples/fib.tth` (it comes from the source map). Click a line number to
set a breakpoint and reload. `?program=stack-overflow` shows a source-mapped
stack trace in the Console.

`npm run verify:browser` does all of this automatically in headless Chrome
(Node 22+), using the DevTools user interface itself, and writes
`docs/browser-verification.md` with screenshots.

## Playground (for demos)

```sh
npm run playground        # then open http://localhost:5173/
```

A web page that runs the compiler's own `src/` modules in the browser:

- Edit Tether code and watch every phase update as you type: tokens, syntax
  tree, type errors, the lowered core tree and the generated JavaScript.
- Under **JavaScript**, each underlined segment is one source-map entry. Hover
  it to highlight the Tether code it maps to, and a line (the tether) is drawn
  from it back to that code; move the cursor in the source to find the
  matching JavaScript.
- **Source map** shows the `.js.map` exactly as Tether writes it, then every
  Base64 VLQ segment decoded; hover a segment to see the code it points at.
- **Run** executes the generated JavaScript in a worker, in strict mode as Node
  does, and stops it after 2 seconds or 1000 lines of output. A runtime error,
  such as an array index out of range, names the `.tth` line and column it
  came from, found through the mapping table; hover it to see that code.
- The **-O1** switch turns on the optimiser; the phase strip shows how many
  expressions were folded, constants propagated and statements removed.
- **Share** puts the program itself in the link (in the URL fragment, which
  never reaches the server), so the link opens exactly what you wrote.
- The JavaScript and Source map tabs can download the `.js` and `.js.map`.

Open a specific program with a link such as
`http://localhost:5173/playground/#semantic-errors`, `#optimisable` or `#sieve`.

## Layout

```
bin/tether.js              CLI entry point
playground/                browser playground (index.html)
debug/index.html           page that runs a compiled program for Chrome DevTools
scripts/serve.js           local static server
scripts/build-examples.js  compiles the benchmarks into out/
scripts/verify-browser.js  milestone 7: breakpoints and stack traces in Chrome DevTools
scripts/map-report.js      milestone 8: mapping retention at -O0 and -O1
.github/workflows/test.yml continuous integration: npm test on Node 18, 20 and 22
src/span.js                spans; toMapPosition(), the only 1-based → 0-based conversion
src/source.js              source text and line table
src/lexer.js               scanner
src/parser.js              recursive descent and precedence climbing, panic-mode recovery
src/ast.js                 node schema (CHILD_FIELDS) and tree walking
src/checker.js             scopes, symbol table, type checking, return paths, JavaScript names
src/lower.js               for → while (and continue), compound assignment, && / || → conditionals
src/optimize.js            -O1: constant folding and propagation, dead-code removal, mapping retention
src/emit.js                JavaScript emitter with a single write path; records the mapping table;
                           checked array indexing
src/vlq.js                 Base64 VLQ encoding and decoding
src/sourcemap.js           Source Map v3: delta encoding, names, JSON
src/diagnostics.js         diagnostic collection and caret rendering, with notes
src/dump.js                dump and report formats
src/compiler.js            pipeline wiring
src/cli.js                 argument parsing, output files and exit codes
docs/grammar.md            the grammar (Appendix A), revision 2
docs/semantics.md          type rules, scopes, translation to JavaScript, -O1
docs/positions.md          position conventions, spans, and the source map format
docs/browser-verification.md   AC-2 and AC-5 results, with DevTools screenshots
docs/fidelity.md           AC-6 mapping retention figures
examples/                  the four benchmark programs
test/                      unit tests per phase, golden-file CLI tests, expected program output
test/fixtures/sieve.tth    arrays, break and continue, and a constant -O1 propagates
```

## Tests

```sh
npm test                     # 209 tests
npm run test:update-golden   # regenerate test/golden after a deliberate format change
npm run verify:browser       # browser checks (needs Chrome and Node 22+)
npm run map-report           # regenerate docs/fidelity.md
```

The source map is verified against Node's built-in `SourceMap` decoder
(`node:module`), which is independent of this project's encoder. The tests
run on every push, on Node 18, 20 and 22 (`.github/workflows/test.yml`).
