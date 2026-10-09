# Tether grammar (Appendix A)

**Status: frozen** at the start of implementation (milestone 1). Any change
requires a revision of the PRD (section 4). The parser in `src/parser.js`
follows these rules one function per rule.

Notation: `::=` defines, `|` separates alternatives, `[ x ]` means optional,
`{ x }` means zero or more, and quoted text is a literal token.

## Syntax

```bnf
program      ::= { fnDecl | statement } EOF

fnDecl       ::= "fn" IDENT "(" [ param { "," param } ] ")" [ ":" type ] block
param        ::= IDENT ":" type
type         ::= "int" | "bool" | "string"

block        ::= "{" { statement } "}"

statement    ::= letDecl ";"
               | ifStmt
               | whileStmt
               | forStmt
               | returnStmt
               | printStmt
               | block
               | simpleStmt ";"

letDecl      ::= "let" IDENT [ ":" type ] "=" expr
simpleStmt   ::= IDENT assignOp expr
               | expr
assignOp     ::= "=" | "+=" | "-=" | "*=" | "/=" | "%="

ifStmt       ::= "if" "(" expr ")" block [ "else" ( ifStmt | block ) ]
whileStmt    ::= "while" "(" expr ")" block
forStmt      ::= "for" "(" [ letDecl | simpleStmt ] ";" [ expr ] ";" [ simpleStmt ] ")" block
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
               | primary
primary      ::= INT | STRING | "true" | "false"
               | IDENT [ "(" [ expr { "," expr } ] ")" ]
               | "(" expr ")"
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

## Context rules enforced by the parser

- `fn` declarations may only appear at the top level. A nested `fn` is
  parsed (so recovery is clean) and then rejected.
- Assignment is a statement, not an expression: `if (x = 1)` is a syntax error.
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

Keywords: `fn let if else while for return print int bool string true false`.

Punctuators, longest match first:
`&& || == != <= >= += -= *= /= %= + - * / % ! = < > ( ) { } , ; :`
