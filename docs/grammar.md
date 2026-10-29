# Tether grammar (Appendix A)

**Status: revision 2.** Revision 1 was frozen at the start of implementation
(milestone 1) and held through all eight milestones. Revision 2 is an
extension after the final review; every revision 1 program means the same as
before. It adds:

- `break` and `continue` (`breakStmt`, `continueStmt`);
- one-dimensional arrays: array types (`int[]`), array literals (`[1, 2]`),
  indexing (`postfix`) and assignment to an array element (`target`);
- `len` and `push`, which are built-in functions, not grammar: a call to them
  is an ordinary `primary`.

The parser in `src/parser.js` follows these rules one function per rule.

Notation: `::=` defines, `|` separates alternatives, `[ x ]` means optional,
`{ x }` means zero or more, and quoted text is a literal token.

## Syntax

```bnf
program      ::= { fnDecl | statement } EOF

fnDecl       ::= "fn" IDENT "(" [ param { "," param } ] ")" [ ":" type ] block
param        ::= IDENT ":" type
type         ::= ( "int" | "bool" | "string" ) [ "[" "]" ]

block        ::= "{" { statement } "}"

statement    ::= letDecl ";"
               | ifStmt
               | whileStmt
               | forStmt
               | breakStmt
               | continueStmt
               | returnStmt
               | printStmt
               | block
               | simpleStmt ";"

letDecl      ::= "let" IDENT [ ":" type ] "=" expr
simpleStmt   ::= target assignOp expr
               | expr
target       ::= IDENT | postfix "[" expr "]"
assignOp     ::= "=" | "+=" | "-=" | "*=" | "/=" | "%="

ifStmt       ::= "if" "(" expr ")" block [ "else" ( ifStmt | block ) ]
whileStmt    ::= "while" "(" expr ")" block
forStmt      ::= "for" "(" [ letDecl | simpleStmt ] ";" [ expr ] ";" [ simpleStmt ] ")" block
breakStmt    ::= "break" ";"
continueStmt ::= "continue" ";"
returnStmt   ::= "return" [ expr ] ";"
printStmt    ::= "print" "(" expr ")" ";"

expr         ::= orExpr
orExpr       ::= andExpr { "||" andExpr }
andExpr      ::= eqExpr  { "&&" eqExpr }
eqExpr       ::= relExpr { ( "==" | "!=" ) relExpr }
relExpr      ::= addExpr { ( "<" | "<=" | ">" | ">=" ) addExpr }
addExpr      ::= mulExpr { ( "+" | "-" ) mulExpr }
mulExpr      ::= unary   { ( "*" | "/" | "%" ) unary }
unary        ::= ( "-" | "!" ) unary
               | postfix
postfix      ::= primary { "[" expr "]" }
primary      ::= INT | STRING | "true" | "false"
               | IDENT [ "(" [ expr { "," expr } ] ")" ]
               | "(" expr ")"
               | "[" [ expr { "," expr } ] "]"
```

The expression rules above are the textbook stratified form. The parser
implements them by precedence climbing (FR-P1) over this table, in which
every operator is left-associative:

| Precedence | Operators              |
|-----------:|------------------------|
| 1          | `\|\|`                 |
| 2          | `&&`                   |
| 3          | `==` `!=`              |
| 4          | `<` `<=` `>` `>=`      |
| 5          | `+` `-`                |
| 6          | `*` `/` `%`            |
| (unary)    | prefix `-` `!`         |
| (postfix)  | indexing `a[i]`, binds tightest |

## Context rules enforced by the parser

- `fn` declarations may only appear at the top level. A nested `fn` is
  parsed (so recovery is clean) and then rejected.
- Assignment is a statement, not an expression: `if (x = 1)` is a syntax error.
- The left side of an assignment is parsed as an expression and must turn out
  to be a variable or an array element: `f(x) = 3;` is a syntax error.
- Whether `break` and `continue` are inside a loop is checked by semantic
  analysis, not by the grammar.
- Only a named function can be called. There are no first-class functions.

Rules about names and types (scoping, operand types, return paths) belong to
semantic analysis (milestone 3) and are not part of the grammar.

## Lexical structure

```bnf
INT          ::= digit { digit }                 (* must be ≤ 2^53 − 1 *)
STRING       ::= '"' { char | escape } '"'       (* may not span lines *)
escape       ::= '\n' | '\t' | '\"' | '\\'
IDENT        ::= ( letter | "_" ) { letter | digit | "_" }    (* not a keyword *)
comment      ::= "//" { any character except a line end }
whitespace   ::= " " | TAB | LF | CR
```

Keywords: `fn let if else while for break continue return print int bool string true false`.

Punctuators, longest match first:
`&& || == != <= >= += -= *= /= %= + - * / % ! = < > ( ) { } [ ] , ; :`
