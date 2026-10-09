#!/usr/bin/env node
// Browser verification (milestone 7: AC-2 and AC-5).
//
//   npm run verify:browser
//
// Needs Node 22+ (for the built-in WebSocket) and Google Chrome or Chromium.
// Set CHROME_PATH if Chrome is not found automatically.
//
// What it does:
//   1. Compiles the benchmarks into out/ and serves the project on localhost.
//   2. Starts two headless Chrome instances. The first runs a compiled program
//      in debug/index.html. The second shows Chrome's own DevTools front end,
//      attached to the first.
//   3. AC-2: for each statement in BREAKPOINTS, it uses the DevTools user
//      interface as a person would: quick-open the .tth file, go to the line,
//      toggle a breakpoint. Then it reloads the program and checks where
//      Chrome stops. The paused position is translated back through the
//      published .js.map with Node's SourceMap class, and must be on the same
//      .tth line.
//   4. AC-5: it runs a program that overflows the stack and checks that the
//      uncaught exception's stack frames resolve to the .tth file and line,
//      and shows the DevTools console.
//   5. Writes screenshots to docs/screenshots/ and the results to
//      docs/browser-verification.md. Exits 1 if any check fails.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as tether } from '../src/cli.js';

// Statements to stop at: [program, 1-based .tth line]. Every one runs.
const ONLY = process.env.TETHER_ONLY;
const BREAKPOINTS = [
  ['fib', 4], ['fib', 5], ['fib', 7], ['fib', 11], ['fib', 14], ['fib', 15], ['fib', 18], ['fib', 22], ['fib', 24],
  ['primes', 7], ['primes', 12], ['primes', 20], ['primes', 25],
  ['collatz', 8], ['collatz', 10], ['collatz', 21],
  ['fizzbuzz', 5], ['fizzbuzz', 15], ['fizzbuzz', 17], ['fizzbuzz', 29],
];
const SCREENSHOT_EVERY = new Set(['fib:14', 'primes:12', 'collatz:10', 'fizzbuzz:15']);

const HTTP_PORT = Number(process.env.PORT) || 5197;
const TARGET_PORT = 9341;
const VIEWER_PORT = 9342;
const SHOTS = 'docs/screenshots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === 'darwin') {
    const apps = readdirSync('/Applications').filter((a) => /^(Google Chrome|Chromium).*\.app$/.test(a)).sort();
    for (const app of apps) {
      const exe = join('/Applications', app, 'Contents/MacOS', app.replace(/\.app$/, '').replace(/ \d+$/, ''));
      if (existsSync(exe)) return exe;
      const any = readdirSync(join('/Applications', app, 'Contents/MacOS'))[0];
      if (any) return join('/Applications', app, 'Contents/MacOS', any);
    }
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* next */ }
  }
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']) {
    if (existsSync(p)) return p;
  }
  return null;
}

// A minimal Chrome DevTools Protocol client.
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message}`));
        else resolve(m.result);
      } else {
        for (const f of this.listeners) f(m);
      }
    });
    this.ready = new Promise((r) => this.ws.addEventListener('open', r));
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(f) { this.listeners.add(f); }
  close() { this.ws.close(); }
}

async function pageTarget(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`Chrome did not start on port ${port}`);
}

async function waitFor(predicate, ms, what) {
  for (let t = 0; t < ms; t += 100) {
    const v = predicate();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Original position of a generated one, read from the published map by an
// independent decoder.
const maps = new Map();
function original(program, line, column) {
  if (!maps.has(program)) maps.set(program, new SourceMap(JSON.parse(readFileSync(`out/${program}.js.map`, 'utf8'))));
  const e = maps.get(program).findEntry(line, column);
  return { line: e.originalLine + 1, column: e.originalColumn + 1, source: e.originalSource, name: e.name };
}

async function run() {
  if (typeof WebSocket === 'undefined') {
    console.error('verify:browser needs Node 22 or later (for the built-in WebSocket).');
    return 2;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error('Chrome was not found. Set CHROME_PATH to the Chrome or Chromium executable.');
    return 2;
  }

  // 1. Build and serve.
  const quiet = { stdout: () => {}, stderr: () => {}, readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, s) => writeFileSync(p, s), mkdir: (d) => mkdirSync(d, { recursive: true }) };
  for (const f of ['examples/fib.tth', 'examples/primes.tth', 'examples/collatz.tth', 'examples/fizzbuzz.tth', 'test/fixtures/stack-overflow.tth']) {
    if (tether(['build', f, '-o', 'out'], quiet) !== 0) throw new Error(`could not compile ${f}`);
  }
  mkdirSync(SHOTS, { recursive: true });
  const children = [];
  const profiles = [];
  const server = spawn(process.execPath, ['scripts/serve.js'], { env: { ...process.env, PORT: String(HTTP_PORT) }, stdio: 'ignore' });
  children.push(server);

  const launch = (port, extra = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-chrome-'));
    profiles.push(dir);
    const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, ...extra, 'about:blank'], { stdio: 'ignore' });
    children.push(p);
  };
  launch(TARGET_PORT, ['--remote-allow-origins=*']);
  launch(VIEWER_PORT);

  const results = [];
  let stack = null;
  let version = '';
  try {
    await pageTarget(TARGET_PORT);
    version = (await (await fetch(`http://127.0.0.1:${TARGET_PORT}/json/version`)).json()).Browser;
    const viewerInfo = await pageTarget(VIEWER_PORT);
    const viewer = new Cdp(viewerInfo.webSocketDebuggerUrl);
    await viewer.ready;
    await viewer.send('Page.enable');
    await viewer.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 1.5, mobile: false });
    const harness = (p) => `http://localhost:${HTTP_PORT}/debug/?program=${p}`;

    // Every check runs in a new tab of the target Chrome, with a new DevTools
    // front end attached, so no breakpoint or setting carries over between
    // checks.
    const newTab = async () => {
      const info = await (await fetch(`http://127.0.0.1:${TARGET_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
      const cdp = new Cdp(info.webSocketDebuggerUrl);
      await cdp.ready;
      const tab = { info, cdp, scripts: new Map(), paused: null, exception: null };
      cdp.on((m) => {
        if (m.method === 'Debugger.scriptParsed') tab.scripts.set(m.params.scriptId, m.params);
        if (m.method === 'Debugger.paused') tab.paused = m.params;
        if (m.method === 'Debugger.resumed') tab.paused = null;
        if (m.method === 'Runtime.exceptionThrown') tab.exception = m.params.exceptionDetails;
      });
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Debugger.enable');
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      return tab;
    };
    const closeTab = async (tab) => {
      tab.cdp.close();
      await fetch(`http://127.0.0.1:${TARGET_PORT}/json/close/${tab.info.id}`).catch(() => {});
    };
    const resumeIfPaused = async (tab) => {
      if (tab.paused) {
        await tab.cdp.send('Debugger.resume').catch(() => {});
        await sleep(200);
      }
      tab.paused = null;
    };

    // The DevTools front end, served by the target Chrome itself.
    const front = `http://127.0.0.1:${TARGET_PORT}/devtools/inspector.html`;
    const openDevTools = async (tab, panel) => {
      // Fresh settings: no remembered breakpoints, no screencast. The storage
      // is cleared from a plain page on the same origin, because a DevTools
      // page would write its settings back when it unloads.
      await viewer.send('Page.navigate', { url: `http://127.0.0.1:${TARGET_PORT}/json/version` });
      await sleep(800);
      await viewer.send('Runtime.evaluate', {
        expression: `localStorage.clear(); for (const k of ['screencastEnabled', 'screencast-enabled']) localStorage.setItem(k, 'false'); 1`,
      });
      await viewer.send('Page.navigate', { url: `${front}?ws=127.0.0.1:${TARGET_PORT}/devtools/page/${tab.info.id}&panel=${panel}` });
      await sleep(4500);
    };
    const mod = process.platform === 'darwin' ? 4 : 2; // Meta on macOS, Ctrl elsewhere
    const key = async (k, code, vk, modifiers = 0) => {
      await viewer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
      await viewer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
      await sleep(250);
    };
    const typeText = async (t) => { await viewer.send('Input.insertText', { text: t }); await sleep(400); };
    const enter = () => key('Enter', 'Enter', 13);
    const shot = async (file) => {
      const { data } = await viewer.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(SHOTS, file), Buffer.from(data, 'base64'));
      return `screenshots/${file}`;
    };

    // 3. AC-2: breakpoints set in the DevTools UI on .tth lines.
    for (const [program, line] of BREAKPOINTS.filter(([p, l]) => !ONLY || ONLY === `${p}:${l}`)) {
      const text = readFileSync(`examples/${program}.tth`, 'utf8').split('\n')[line - 1].trim();
      const row = { program, line, text, ok: false };
      results.push(row);
      const tab = await newTab();
      try {
        await tab.cdp.send('Page.navigate', { url: harness(program) });
        await sleep(1200);
        await openDevTools(tab, 'sources');
        await resumeIfPaused(tab);
        // Quick open the .tth file, go to the line, toggle a breakpoint.
        await key('p', 'KeyP', 80, mod);
        await typeText(`${program}.tth`);
        await sleep(500);
        await enter();
        await sleep(1000);
        await key('g', 'KeyG', 71, 2);
        await typeText(String(line));
        await enter();
        await sleep(300);
        await key('b', 'KeyB', 66, mod);
        await sleep(800);
        if (process.env.TETHER_DEBUG) await shot(`debug-${program}-${line}.png`);
        await resumeIfPaused(tab);
        // Run the program again and see where it stops.
        await tab.cdp.send('Page.reload', { ignoreCache: true });
        // The breakpoint belongs to the DevTools front end's own session, so
        // this session sees a pause without a breakpoint id. Accept a pause
        // inside the program's script; resume any other (for example in an
        // evaluated snippet).
        const inProgram = (q) => q && tab.scripts.get(q.callFrames[0].location.scriptId)?.url.endsWith(`/out/${program}.js`);
        const p = await waitFor(() => {
          if (tab.paused && !inProgram(tab.paused)) {
            tab.cdp.send('Debugger.resume').catch(() => {});
            tab.paused = null;
          }
          return inProgram(tab.paused) && tab.paused;
        }, 10000, 'the breakpoint');
        const top = p.callFrames[0];
        const script = tab.scripts.get(top.location.scriptId);
        row.generated = `${top.location.lineNumber + 1}:${top.location.columnNumber + 1}`;
        row.script = script.url.replace(/^.*\/out\//, 'out/');
        row.sourceMapURL = script.sourceMapURL;
        row.fn = top.functionName || '(top level)';
        const o = original(program, top.location.lineNumber, top.location.columnNumber);
        row.original = `${o.source.replace(/^.*\//, '')}:${o.line}:${o.column}`;
        row.ok = o.line === line && o.source.endsWith(`${program}.tth`) && script.sourceMapURL === `${program}.js.map`;
        await sleep(1500);
        if (SCREENSHOT_EVERY.has(`${program}:${line}`)) row.shot = await shot(`m7-breakpoint-${program}-${line}.png`);
      } catch (e) {
        row.error = e.message;
      } finally {
        await resumeIfPaused(tab);
        await closeTab(tab);
      }
      console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${program}.tth:${line}  ${text}${row.original ? `  -> paused at ${row.script}:${row.generated}, maps to ${row.original}` : ''}${row.error ? `  (${row.error})` : ''}`);
    }

    // 4. AC-5: an uncaught runtime exception, shown in the DevTools console.
    const tab = await newTab();
    await tab.cdp.send('Page.navigate', { url: harness('fib') });
    await sleep(800);
    await openDevTools(tab, 'console');
    tab.exception = null;
    await tab.cdp.send('Page.navigate', { url: harness('stack-overflow') });
    const ex = await waitFor(() => tab.exception, 10000, 'the uncaught exception');
    await sleep(2500);
    const frames = (ex.stackTrace?.callFrames ?? []).slice(0, 3).map((f) => {
      const o = original('stack-overflow', f.lineNumber, f.columnNumber);
      return {
        fn: f.functionName,
        generated: `${f.url.replace(/^.*\/out\//, 'out/')}:${f.lineNumber + 1}:${f.columnNumber + 1}`,
        original: `${o.source.replace(/^.*\/test\//, 'test/')}:${o.line}:${o.column}`,
        // Every frame is inside down(), lines 5-7. The innermost frame can be the
        // function's own line, because V8 throws the overflow on entry.
        ok: o.source.endsWith('stack-overflow.tth') && o.line >= 5 && o.line <= 7,
      };
    });
    stack = {
      message: ex.exception?.description?.split('\n')[0] ?? ex.text,
      frames,
      ok: frames.length > 0 && frames.every((f) => f.ok),
      shot: await shot('m7-stack-trace-console.png'),
    };
    console.log(`${stack.ok ? 'ok  ' : 'FAIL'} stack trace: ${stack.message}`);
    for (const f of frames) console.log(`       at ${f.fn} (${f.original})   [generated ${f.generated}]`);
    await closeTab(tab);
    viewer.close();
  } finally {
    for (const c of children) c.kill();
    await sleep(500);
    for (const d of profiles) rmSync(d, { recursive: true, force: true });
  }

  writeReport(results, stack, version);
  const passed = results.filter((r) => r.ok).length;
  const ok = passed === results.length && passed >= 10 && stack?.ok;
  console.log(`\n${passed}/${results.length} breakpoints and ${stack?.ok ? 'the' : 'NOT the'} stack trace verified. Report: docs/browser-verification.md`);
  return ok ? 0 : 1;
}

function writeReport(results, stack, version) {
  const date = new Date().toISOString().slice(0, 10);
  const passed = results.filter((r) => r.ok).length;
  const programs = [...new Set(results.map((r) => r.program))].length;
  let md = `# Browser verification (milestone 7)

Generated by \`npm run verify:browser\` on ${date}, with ${version} and Node ${process.versions.node}.
Do not edit by hand; run the script again instead.

## Method

Each compiled benchmark runs in \`debug/index.html\`, an ordinary web page that
loads \`out/<name>.js\`. Chrome reads the \`sourceMappingURL\` comment, loads
\`out/<name>.js.map\` and lists the original \`.tth\` file in DevTools.

For every statement below, the script drives Chrome's own DevTools user
interface as a person would: quick-open the \`.tth\` file, go to the line, and
toggle a breakpoint. DevTools uses the source map to place the breakpoint in
the generated JavaScript. The page is then reloaded and the script records
where Chrome stops. That position is translated back with Node's built-in
\`SourceMap\` class (independent of Tether's encoder) and must be on the same
\`.tth\` line.

## AC-2: breakpoints on original source lines

**${passed} of ${results.length} breakpoints** (in ${programs} programs) halted at the statement
on which they were set. AC-2 needs at least ten.

| .tth line | Statement | Chrome paused in | at | maps back to | |
|-----------|-----------|------------------|----|--------------|---|
`;
  for (const r of results) {
    md += `| \`${r.program}.tth:${r.line}\` | \`${r.text.replace(/\|/g, '\\|')}\` | ${r.fn ?? '—'} | ${r.script ? `\`${r.script}:${r.generated}\`` : '—'} | ${r.original ? `\`${r.original}\`` : '—'} | ${r.ok ? 'pass' : `**fail**${r.error ? `: ${r.error}` : ''}`} |\n`;
  }
  md += `
"at" is the generated position (1-based line:column) where V8 stopped. V8 may
move a breakpoint to the nearest place it can stop, for example from the start
of \`let next = a + b;\` to the start of \`a + b\`; the mapped position is still
inside the same statement.

`;
  for (const r of results.filter((x) => x.shot)) {
    md += `### ${r.program}.tth line ${r.line}: \`${r.text}\`\n\n![DevTools paused on ${r.program}.tth line ${r.line}](${r.shot})\n\n`;
  }
  if (stack) {
    md += `## AC-5: a runtime exception's stack trace names the original file and line

\`test/fixtures/stack-overflow.tth\` recurses until the stack overflows. Chrome
reports the uncaught exception; its stack frames, translated through the map:

| Function | Generated position | Original position | |
|----------|--------------------|-------------------|---|
`;
    for (const f of stack.frames) md += `| \`${f.fn}\` | \`${f.generated}\` | \`${f.original}\` | ${f.ok ? 'pass' : '**fail**'} |\n`;
    md += `
Exception: \`${stack.message}\`. The DevTools console shows the same frames,
linked to \`stack-overflow.tth\`:

![DevTools console with the source-mapped stack trace](${stack.shot})

Node shows the same thing on the command line:
\`node --enable-source-maps out/stack-overflow.js\` reports
\`at down (…/test/fixtures/stack-overflow.tth:6:10)\`.
`;
  }
  md += `
## Doing it by hand

\`\`\`sh
npm run build:examples
npm run playground          # serves the project on http://localhost:5173
\`\`\`

1. Open \`http://localhost:5173/debug/?program=fib\` in Chrome.
2. Open DevTools (⌥⌘I or F12), choose **Sources**, and open
   \`localhost:5173 → examples → fib.tth\`.
3. Click line number 14 to set a breakpoint, then reload the page. Chrome stops
   on \`let next = a + b;\`, with \`fibIter\` in the call stack and \`a\`, \`b\` and
   \`n\` under Scope.
4. Open \`http://localhost:5173/debug/?program=stack-overflow\` with the
   **Console** open. The \`RangeError\` stack trace links to
   \`stack-overflow.tth:6\`.
`;
  writeFileSync('docs/browser-verification.md', md);
}

run().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
