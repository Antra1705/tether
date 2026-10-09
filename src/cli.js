// Command-line interface (FR-C1 – FR-C3).
//
//   tether build <file> [-o <dir>] [-O1] [--no-map]
//                [--dump-tokens] [--dump-ast] [--dump-core] [--dump-mappings]
//                [--map-report]
//
// `build` writes <dir>/<name>.js and <dir>/<name>.js.map (default dir: out).
// The dump flags and --map-report print instead of writing files.
//
// Exit codes (FR-C2): 0 success, 1 compile error, 2 internal error.
// A usage error also exits 2.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { compile } from './compiler.js';
import { renderAll } from './diagnostics.js';
import { dumpTokens, dumpAst, dumpMappings, dumpMapReport } from './dump.js';
import { mappingRetention } from './optimize.js';
import { serializeSourceMap } from './sourcemap.js';

export const EXIT_OK = 0;
export const EXIT_COMPILE_ERROR = 1;
export const EXIT_INTERNAL_ERROR = 2;

const USAGE = `usage: tether build <file> [-o <dir>] [-O1] [--no-map]
                    [--dump-tokens] [--dump-ast] [--dump-core] [--dump-mappings]
                    [--map-report]
`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'build') return { error: command ? `unknown command '${command}'` : 'missing command' };
  const opts = {
    file: null, outDir: 'out', optimise: false, map: true,
    dumpTokens: false, dumpAst: false, dumpCore: false, dumpMappings: false, mapReport: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '-o':
        if (i + 1 >= rest.length) return { error: "'-o' needs a directory" };
        opts.outDir = rest[++i];
        break;
      case '-O1': opts.optimise = true; break;
      case '--no-map': opts.map = false; break;
      case '--dump-tokens': opts.dumpTokens = true; break;
      case '--dump-ast': opts.dumpAst = true; break;
      case '--dump-core': opts.dumpCore = true; break;
      case '--dump-mappings': opts.dumpMappings = true; break;
      case '--map-report': opts.mapReport = true; break;
      default:
        if (a.startsWith('-')) return { error: `unknown option '${a}'` };
        if (opts.file) return { error: `unexpected extra argument '${a}'` };
        opts.file = a;
    }
  }
  if (!opts.file) return { error: 'missing input file' };
  return { opts };
}

// Runs the CLI and returns the exit code. `io` is injectable for tests.
export function main(argv, io = defaultIo()) {
  try {
    return run(argv, io);
  } catch (e) {
    io.stderr(`tether: internal compiler error: ${e && e.stack ? e.stack : e}\n`);
    return EXIT_INTERNAL_ERROR;
  }
}

// Output file names for an input path.
export function outputPaths(file, outDir) {
  const name = basename(file).replace(/\.tth$/, '');
  const jsFile = `${name}.js`;
  return {
    jsFile,
    mapFile: `${jsFile}.map`,
    jsPath: join(outDir, jsFile),
    mapPath: join(outDir, `${jsFile}.map`),
    // The map lives in outDir, so `sources` is relative to outDir. Always
    // '/' separators, so the map is the same on every platform.
    sourcePath: relative(outDir, file).split(sep).join('/'),
  };
}

function run(argv, io) {
  const { opts, error } = parseArgs(argv);
  if (error) {
    io.stderr(`tether: ${error}\n${USAGE}`);
    return EXIT_INTERNAL_ERROR;
  }

  let text;
  try {
    text = io.readFile(opts.file);
  } catch (e) {
    io.stderr(`tether: error: cannot read '${opts.file}': ${e.code ?? e.message}\n`);
    return EXIT_COMPILE_ERROR;
  }

  const paths = outputPaths(opts.file, opts.outDir);
  const r = compile(opts.file, text, {
    jsFile: paths.jsFile,
    mapFile: opts.map ? paths.mapFile : null,
    sourcePath: paths.sourcePath,
    optimise: opts.optimise,
  });

  if (opts.dumpTokens) io.stdout(dumpTokens(r.tokens));
  if (opts.dumpAst) io.stdout(dumpAst(r.ast));

  if (r.diags.items.length) io.stderr(renderAll(r.diags, r.source));
  if (r.diags.hasErrors()) {
    const n = r.diags.errorCount;
    io.stderr(`${n} error${n === 1 ? '' : 's'}; no output written\n`);
    return EXIT_COMPILE_ERROR; // FR-S4
  }

  if (opts.dumpCore) io.stdout(dumpAst(r.core, { showJsNames: true }));
  if (opts.dumpMappings) io.stdout(dumpMappings(r.table));
  if (opts.mapReport) io.stdout(mapReport(opts.file, text, paths));
  if (opts.dumpTokens || opts.dumpAst || opts.dumpCore || opts.dumpMappings || opts.mapReport) return EXIT_OK;

  try {
    io.mkdir(opts.outDir);
    io.writeFile(paths.jsPath, r.code);
    if (r.map) io.writeFile(paths.mapPath, serializeSourceMap(r.map));
  } catch (e) {
    io.stderr(`tether: error: cannot write to '${opts.outDir}': ${e.code ?? e.message}\n`);
    return EXIT_COMPILE_ERROR;
  }
  io.stderr(`tether: wrote ${paths.jsPath}${r.map ? ` and ${paths.mapPath}` : ''}\n`);
  return EXIT_OK;
}

// Compiles at -O0 and -O1 and reports how many source statements keep a
// mapping at each level (FR-O3).
function mapReport(file, text, paths) {
  const rows = [false, true].map((optimise) => {
    const r = compile(file, text, { jsFile: paths.jsFile, sourcePath: paths.sourcePath, optimise });
    return {
      level: optimise ? '-O1' : '-O0',
      ...mappingRetention(r.ast, r.table),
      folded: r.optimisation?.folded ?? 0,
      removed: r.optimisation?.removed ?? 0,
    };
  });
  return dumpMapReport(file, rows);
}

function defaultIo() {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, s) => writeFileSync(p, s),
    mkdir: (d) => mkdirSync(d, { recursive: true }),
  };
}
