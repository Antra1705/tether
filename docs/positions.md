# Source position conventions

Source position is a first-class artifact in Tether (PRD section 1). These
rules apply to every phase.

| Rule | Detail |
|------|--------|
| Span fields | `file`, `offset` (0-based), `length`, `line`, `col` (1-based start), `endLine`, `endCol` (1-based, just past the end) |
| Column unit | UTF-16 code units, the unit JavaScript strings and Source Map v3 consumers use. A character outside the Basic Multilingual Plane counts as two columns. |
| Tabs | A tab advances the column by **one** (FR-L5). This matches Source Map v3, whose columns are plain code-unit indices, and how Chrome DevTools resolves them. It answers the third open question in PRD section 13. |
| Line ends | `\n`, `\r\n` and a lone `\r` each end one line. |
| Base | Lines and columns are 1-based everywhere inside the compiler and in every diagnostic. |
| The one conversion | `toMapPosition()` in `src/span.js` is the only place a position becomes 0-based, for source-map fields (FR-L2). It is covered by a property test over random text (`test/span.test.js`). |

## Span invariant (FR-P2)

A leaf node's span is its token's span. An interior node's span is the union
of its children's spans and of the tokens it consumes directly. For example,
a `Let` statement's span runs from `let` through the `;`. `test/parser.test.js`
checks this over every node in every benchmark: children sit inside their
parent, in source order, without overlapping, and every leaf has the span of
a real token.

## Diagnostics (FR-S3)

```
examples/bad.tth:3:9: error: unterminated string literal
  3 | let s = "hello;
    |         ^
```

The caret line reuses the tabs from the source line, so the carets stay
aligned whatever tab width the terminal uses. A zero-length span, such as a
missing `;`, still gets one caret.

## Source maps (milestones 5–6)

The emitter records a mapping table while it writes (`src/emit.js`): each
entry pairs a generated position with an original span. It records the first
token of every statement and every identifier, declared or referenced
(FR-X4), and, inside expressions, the start of every expression and every
binary operator. Identifier entries also carry the original name. Where
several entries start at the same generated column (a statement, the call it
starts with, and the call's name), the innermost one is kept.

Expression mappings mean a position inside a long expression resolves to the
sub-expression it came from, not just to the start of the statement. For
example, in `return fib(n - 1) + fib(n - 2);` the `+` between the calls, each
`-`, and each literal has its own mapping. A built-in whose JavaScript starts
with its argument (`len(xs)` becomes `xs.length`) maps the property name back
to the built-in's name, so the statement still has a mapping to its first
token.

`src/sourcemap.js` encodes the table as Source Map v3:

| Field | Value |
|-------|-------|
| `version` | `3` |
| `file` | the generated file's name, e.g. `fib.js` |
| `sources` | the original file, relative to the map's directory, with `/` separators |
| `sourcesContent` | the original text, so a debugger needs no access to the `.tth` file (FR-X5) |
| `names` | each original identifier once, in order of first use |
| `mappings` | Base64 VLQ, `;` per generated line, `,` per segment (FR-X2); a group for every generated line, including the trailing lines with no mappings |

A segment holds the generated column, source index, original line and
original column, plus a name index when it maps an identifier. Each field is
a difference from the previous segment. The generated column restarts on each
line; the other fields carry on across the file (FR-X3). Every position in the
map is 0-based and comes from `toMapPosition()`.

Code created by lowering (a `while` made from a `for`, the `x + 1` made from
`x += 1`, the copy of a `for` loop's update placed before a `continue`) has
the span of the construct that caused it (FR-M2), so it maps back to that
construct.

`mappings` has a group for every line of the generated file, so it ends with
`;` (the `sourceMappingURL` comment and the empty last line have no
mappings). The format allows the trailing groups to be left out, but Node's
`SourceMap` decoder mishandles a string that ends in a segment: it gives that
last segment the name of the segment before it, even when the last segment
has no name field. The test suite found this once expression mappings put an
unnamed literal last (`console.log(fibIter(40))`). Writing every line is the
more literal reading of the format and avoids the problem in every decoder.

### Verification

The map is checked against Node's built-in `SourceMap` class (`node:module`),
a decoder that is independent of this project's encoder (NFR-4) and adds no
dependency (NFR-1). `test/sourcemap.test.js` checks, for every benchmark:

- every entry in the compiler's mapping table, looked up in the decoded map,
  gives back the same original position and name (AC-3);
- every segment has 4 or 5 fields and points at a position that exists in the
  source, and every name index is within `names`;
- every statement and every identifier in the source has a mapping, and so do
  every expression and every binary operator;
- `mappings` has a group for every generated line;
- `sourceMappingURL` and `sources` resolve on disk relative to the files;
- a runtime error, run with `node --enable-source-maps`, is reported at the
  original `.tth` line and column, both for runaway recursion and for an
  array index out of range.
