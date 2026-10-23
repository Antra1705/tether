# Review Demo — Commands (100% implementation)

Copy and paste each block into the terminal, in order.

---

## Before the review (do this first)

**Terminal tab 1:**

```sh
cd ~/tether
node --version
npm test
```

Node must be 18 or higher, and the tests must say `pass 170`.

Also build the programs once, for the Chrome step:

```sh
npm run build:examples
```

**Terminal tab 2** (leave it running):

```sh
cd ~/tether
npm run playground
```

Then open this in the browser and keep the tab ready:

```
http://localhost:5173/playground/#fib
```

---

## During the review (Terminal tab 1)

### Step 1: All tests pass

```sh
clear
npm test
```

Expect: `tests 170`, `pass 170`.
Say: "170 automated tests, one set per phase, all passing. All eight milestones are done."

---

### Step 2: Compile a program and run it

```sh
clear
cat examples/fib.tth
```

```sh
clear
node bin/tether.js build examples/fib.tth
cat out/fib.js
node out/fib.js
```

Expect: `wrote out/fib.js and out/fib.js.map`, readable JavaScript ending in a `sourceMappingURL` line, then the Fibonacci numbers ending in `102334155`.
Say: "Tether now compiles to JavaScript that runs unmodified on Node, plus a source map file."

---

### Step 3: Type checking (milestone 3)

```sh
clear
cat test/fixtures/semantic-errors.tth
```

```sh
clear
node bin/tether.js build test/fixtures/semantic-errors.tth
echo "exit code: $?"
```

Expect: 8 errors with carets, notes such as `previous declaration of 'x' is here`, `8 errors; no output written`, `exit code: 1`.
Say: "The checker has a scoped symbol table. It reports every type and scope error in one run, with no follow-on errors, and no JavaScript is written when there are errors."

---

### Step 4: Lowering (milestone 4)

```sh
clear
node bin/tether.js build examples/fib.tth --dump-core | sed -n 30,62p
```

Expect: `Block … [lowered]` and `While … [lowered]` where the `for` loop was, and `Assign = … [lowered]` for `i += 1`.
Say: "Lowering turns `for` into `while`, `+=` into `=` and `+`, and `&&`/`||` into conditionals. Every new node keeps the span of the code that caused it, so it still maps back to the right line."

---

### Step 5: Reserved words are renamed

```sh
clear
node bin/tether.js build examples/fizzbuzz.tth
grep -n 'var' out/fizzbuzz.js
```

Expect: `let var$ = "";`.
Say: "`var` is a reserved word in JavaScript, so it becomes `var$`. Tether identifiers cannot contain `$`, so this can never clash, and the source map still records the original name `var`."

---

### Step 6: The mapping table and the source map (milestones 5–6)

```sh
clear
node bin/tether.js build examples/fib.tth --dump-mappings | head -12
```

```sh
clear
head -c 400 out/fib.js.map; echo
```

Expect: a table of `generated  original  name`, then JSON with `"version":3`, `sources`, `sourcesContent`, `names` and `"mappings":";AAEA,SAAGA,IAAIC;EACL,IAAIA;...`.
Say: "Each segment is Base64 VLQ and delta-encoded. `AAEA,SAAGA,IAAIC` is exactly the example worked out by hand in the review report."

---

### Step 7: The point of the project — a runtime error in terms of the original source

```sh
clear
cat test/fixtures/stack-overflow.tth
node bin/tether.js build test/fixtures/stack-overflow.tth
node out/stack-overflow.js 2>&1 | grep -m2 "at down"
node --enable-source-maps out/stack-overflow.js 2>&1 | head -6
```

Expect: without the map, `at down (…/out/stack-overflow.js:3:3)` and `…:3:10`. With the map, `at down (…/test/fixtures/stack-overflow.tth:6:3)` and `…:6:10`, and the original source line printed.
Say: "Without the source map the error points into generated JavaScript. With it, Node reports line 6, column 10 of my `.tth` file: the exact recursive call."

---

### Step 8: Optimisation and fidelity (milestone 8)

```sh
clear
node bin/tether.js build test/fixtures/optimisable.tth -O1
cat out/optimisable.js
node bin/tether.js build test/fixtures/optimisable.tth --map-report
```

Expect: `let secondsPerDay = 86400;`, no `if (1 > 2)`, no `while (false)`, then a table where `-O0` keeps 14 of 14 statement mappings and `-O1` keeps 7 of 14 (50.0%).
Say: "-O1 folds constants and removes dead code. Removed code loses its mappings, so I measure how much: the benchmarks keep 100%, because they have no dead code; this test program drops to 50%. The figures are in docs/fidelity.md."

---

### Step 9: Breakpoints in Chrome DevTools (milestone 7)

In the browser (the playground server from tab 2 is running):

1. Open `http://localhost:5173/debug/?program=fib`.
2. Open DevTools (⌥⌘I), choose **Sources**, open `examples/fib.tth` in the file tree.
3. Click line number **14** (`let next = a + b;`), then reload the page.
4. Chrome stops on line 14 of the **.tth** file. Point at **Call Stack** (`fibIter fib.tth:14`) and **Scope** (`a`, `b`, `n`).
5. Open `http://localhost:5173/debug/?program=stack-overflow` with the **Console** open: the `RangeError` stack trace links to `stack-overflow.tth:6`.

Say: "The debugger knows nothing about Tether, yet breakpoints and stack traces work in my source. The script `npm run verify:browser` checks 20 breakpoints like this automatically through the DevTools interface; the results and screenshots are in docs/browser-verification.md."

If the live step fails, open `docs/browser-verification.md` and show the screenshots.

---

### Step 10: Playground (switch to the browser)

1. Open `http://localhost:5173/playground/#fib`. All six phases in the strip show a green marker. Clicking a phase opens its output.
2. The **JavaScript** tab: hover an underlined segment. The Tether code it came from lights up.
3. Click in the source on `fib` in line 7. The matching JavaScript is highlighted.
4. **Run** tab → **Run program**. The output appears.
5. Pick **semantic-errors.tth** from the dropdown. The **Check types** phase turns red with 8 errors, and the later phases wait.
6. Pick **optimisable.tth** and tick **-O1**. The phase strip shows `8 folded, 7 removed` and the JavaScript shrinks.
7. In any program, change `let a = 0;` to `let a = true;`. A type error appears live.

---

## If the teacher asks you to write code live

```sh
cat > demo.tth << 'EOF'
fn square(n: int): int {
  return n * n;
}
let x = 5;
print(square(x));
print("done");
EOF
node bin/tether.js build demo.tth
node out/demo.js
```

Expect: `25` and `done`.

Introduce a type error and compile again:

```sh
sed -i '' 's/square(x)/square("five")/' demo.tth
node bin/tether.js build demo.tth
```

Expect: `argument 1 of 'square' must be 'int', found 'string'`, with the caret under `"five"`.

Clean up afterwards:

```sh
rm demo.tth out/demo.js out/demo.js.map
```

---

## Closing line

> "All eight milestones are done. Tether type-checks, compiles to JavaScript with a source map that an independent decoder agrees with 100%, breakpoints and stack traces work in Chrome DevTools on the original source, and -O1 is measured for how much debuggability it costs."

---

## Emergency fixes

| Problem | Fix |
|---|---|
| Playground says port is busy | `PORT=8080 npm run playground`, then open `http://localhost:8080/playground/#fib` |
| Playground page is blank | Use the `localhost` link, not the HTML file directly |
| `out/` is missing, or the debug page says "Could not load" | `npm run build:examples` |
| Short on time | Do Steps 2, 3, 7 and 9 |
