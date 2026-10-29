# Tether semantics

The static rules the checker enforces (`src/checker.js`, milestone 3) and the
way each construct runs once translated to JavaScript (`src/lower.js` and
`src/emit.js`, milestone 4). The grammar is in `grammar.md`.

## Types

There are three value types, `int`, `bool` and `string`, and an array type for
each of them: `int[]`, `bool[]` and `string[]`. Arrays are one-dimensional: an
array cannot contain arrays. A function with no `: type` returns nothing; a
call to it is a statement, never a value.

| Construct | Rule |
|-----------|------|
| `+` | `int + int` gives `int`; `string + string` gives `string` (concatenation) |
| `-` `*` `/` `%` | `int` operands, `int` result |
| `<` `<=` `>` `>=` | `int` operands, `bool` result |
| `==` `!=` | both operands of the same type, `bool` result |
| `&&` `\|\|` | `bool` operands, `bool` result |
| unary `-` / `!` | `int` / `bool` |
| `if`, `while`, `for` condition | must be `bool` |
| `let x: T = e` | `e` must have type `T` |
| `let x = e` | `x` takes the type of `e` |
| `x = e` | `e` must have the type of `x` |
| `x op= e` | same rule as `x = x op e` |
| `f(a, b)` | `f` must be a function; argument count and every argument type must match |
| `return e` | `e` must match the declared return type; a function with no return type may only use `return;` |
| `print(e)` | any value; not a call that returns nothing |
| `[a, b, c]` | every element has the same type `T`; the literal is a `T[]` |
| `[]` | needs its type from where it is used: `let xs: int[] = [];`, an argument, a `return`, or `xs = [];`. `let xs = [];` is an error |
| `xs[i]` | `xs` must be an array `T[]` and `i` an `int`; the result is a `T` |
| `xs[i] = e` | `e` must be a `T`. `xs[i] += e` is not allowed: write `xs[i] = xs[i] + e` |
| `len(x)` | `x` an array or a `string`; the result is an `int` |
| `push(xs, e)` | `xs` a `T[]` and `e` a `T`; returns nothing |
| `==` `!=` on arrays | not allowed: compare the elements |
| `break`, `continue` | only inside a `while` or `for` loop |

A function with a return type must return a value on every path. The check is
conservative: a `return` returns; a block returns if any statement in it
returns; an `if` returns only if it has an `else` and both branches return.
Loops never count, because they may run zero times.

## Names and scopes

```
global        every function, collected before anything is checked
├── main      top-level let bindings; nested blocks below
└── fn f      the parameters and outermost locals of f; nested blocks below
```

- Every identifier must resolve to a declaration.
- Declaring a name twice in the same scope is an error. A note points at the
  first declaration.
- A declaration in a nested block may shadow an outer one.
- Functions can be called before they are declared, and may be recursive or
  mutually recursive.
- A function body sees other functions, its parameters and its own locals.
  It does not see top-level variables: there are no closures (PRD section 11).
- In `let x = e`, the name `x` is declared after `e` is checked, so
  `{ let x = x + 1; }` reads the outer `x`.
- The variable declared in a `for` header is scoped to the loop.
- `len` and `push` are built-in functions in the global scope. Declaring a
  function or variable with either name at the top level is an error; a
  nested block may shadow them.

## Error reporting

Every error is reported, with its caret, in one run. An expression that is
already wrong gets an internal error type that is accepted wherever a type is
expected, so one mistake produces one message: `print(missing + 1);` reports
only the unknown variable.

## Translation to JavaScript

| Tether | JavaScript (ES2015) |
|--------|---------------------|
| `fn f(a: int): int { … }` | `function f(a) { … }` |
| `let x = e;` | `let x = e;` |
| `for (init; c; u) B` | `{ init; while (c) { B…; u; } }` |
| `continue` belonging to that `for` | `u; continue;`: a JavaScript `continue` in a `while` jumps straight to the condition, so the update is run first. The copy of `u` keeps `u`'s span |
| `break` | `break;` (it leaves the `while`, as it left the `for`) |
| `x op= e` | `x = x op e;` |
| `a && b` / `a \|\| b` | `a ? b : false` / `a ? true : b` (short-circuit is kept) |
| `a / b` | `Math.trunc(a / b)`: integer division truncates toward zero |
| `a % b` | `a % b` (JavaScript also truncates toward zero) |
| `==` / `!=` | `===` / `!==` (operands always have the same type) |
| `print(e)` | `console.log(e)`; an array prints as `[1, 2, 3]` |
| `[a, b]` | `[a, b]` |
| `xs[i]` / `xs[i] = e` | `$get(xs, i)` / `$set(xs, i, e)`: checked against the length |
| `len(x)` / `push(xs, e)` | `x.length` / `xs.push(e)` |
| string literal | JSON-style literal, with U+2028 and U+2029 escaped |

The file starts with `"use strict";` and ends with
`//# sourceMappingURL=<name>.js.map` (unless `--no-map` is given). No runtime
library is needed (NFR-5), with one exception: a program that indexes an array
gets three one-line helper functions after `"use strict";`, `$get`, `$set`
and `$outOfRange`, which check every index. A program that does not index an
array gets none of them.

### Renaming (FR-G3)

The JavaScript name of each declaration is chosen by the checker:

- A name reserved or predefined in JavaScript (`var`, `class`, `new`,
  `undefined`, `console`, `Math`, …) gets a `$` suffix: `var` becomes `var$`.
- A declaration that shadows a visible binding gets `$1`, `$2`, …: the inner
  `x` in `{ let x = x + 1; }` becomes `x$1`. This also keeps JavaScript's
  temporal dead zone from changing the meaning of the program.

`$` cannot appear in a Tether identifier, so a new name can never collide
with one the programmer wrote. The original name is kept in the source map's
`names` array, so a debugger shows `var`, not `var$`.

### Runtime limits

Integers are JavaScript numbers. Literals above 2^53 − 1 are rejected at
compile time, but arithmetic is not checked for overflow, and dividing by
zero gives `Infinity` (`NaN` for `0 / 0` or `x % 0`) rather than an error. A runaway recursion ends with
JavaScript's `RangeError`, which the source map reports at the original
`.tth` line.

An array index outside `0` to `len(xs) - 1` throws a `RangeError` such as
`index 7 is out of range for an array of length 6`, instead of JavaScript's
silent `undefined`. The helper removes itself from the stack trace (with
`Error.captureStackTrace`, where the engine has it), so the first frame is the
indexing expression, and with the source map it names the `.tth` line and
column. Arrays are passed to functions by reference, as in Java.

## Optimisation (-O1)

`-O1` runs `src/optimize.js` on the lowered tree, before emission (FR-O1).

| Optimisation | Example |
|--------------|---------|
| Integer arithmetic on literals | `24 * 60 * 60` → `86400`, `10 / 3` → `3` |
| Comparisons and equality on literals | `1 < 2` → `true`, `"a" == "b"` → `false` |
| `!` and unary `-` on literals | `!true` → `false`, `-(2 + 3)` → `-5` |
| String concatenation of literals | `"te" + "th"` → `"teth"` |
| A conditional with a constant test (from `&&` and `\|\|`) | `true && x` → `x` |
| `if` with a constant condition | `if (false) A else B` → `B` |
| `while (false) { … }` | removed |
| Statements after one that always returns, breaks or continues | removed |
| A variable initialised with a constant and never assigned | each read is replaced by the constant: `let n = 10; print(n * 2);` → `print(20)` |

Folding is skipped whenever it could change what the program prints: division
or remainder by zero, a result that is not a safe integer, and negative zero.

Constant propagation works on the checker's symbols, not on names, so a
shadowing declaration cannot be confused with the variable it shadows. A
variable that is assigned anywhere, even once, is not a constant, and arrays
are never propagated (their elements can change). The `let` that declares a
constant is kept, so it keeps its mapping and a debugger can still show the
variable.

A folded expression takes the span of the whole expression it replaces
(FR-O2); a propagated constant takes the span of the identifier it replaces. Removed statements lose their mappings; `--map-report` and
`npm run map-report` measure how many source statements keep one (FR-O3).
The results are in `fidelity.md`.
