// Syntax analysis (FR-P1 – FR-P3).
//
// A hand-written recursive-descent parser. Binary operators are parsed by
// precedence climbing. The grammar is in docs/grammar.md, and the functions
// below follow it rule by rule.
//
// Error recovery is panic mode at statement granularity. A syntax error throws
// ParseError, which unwinds to the nearest statement loop (a block or the top
// level). That loop calls synchronize(), which skips to the next statement
// boundary, and parsing continues. After MAX_SYNTAX_ERRORS errors the parser
// gives up and returns what it has.

import { union, unionAll, spanAfter } from './span.js';

export const MAX_SYNTAX_ERRORS = 20;

// Higher binds tighter. All binary operators are left-associative.
export const BINARY_PRECEDENCE = new Map([
  ['||', 1],
  ['&&', 2],
  ['==', 3], ['!=', 3],
  ['<', 4], ['<=', 4], ['>', 4], ['>=', 4],
  ['+', 5], ['-', 5],
  ['*', 6], ['/', 6], ['%', 6],
]);

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const TYPE_NAMES = new Set(['int', 'bool', 'string']);
// Tokens at which synchronize() may stop: each one starts a statement.
const STATEMENT_START = new Set(['fn', 'let', 'if', 'while', 'for', 'break', 'continue', 'return', 'print', '{']);

class ParseError extends Error {}
class TooManyErrors extends Error {}

export function parse(tokens, diags, options = {}) {
  return new Parser(tokens, diags, options).parseProgram();
}

function describe(tok) {
  switch (tok.kind) {
    case 'EOF': return 'end of file';
    case 'String': return 'string literal';
    case 'Int': return `integer '${tok.lexeme}'`;
    case 'Ident': return `identifier '${tok.lexeme}'`;
    case 'Keyword': return `keyword '${tok.lexeme}'`;
    default: return `'${tok.lexeme}'`;
  }
}

class Parser {
  constructor(tokens, diags, { maxErrors = MAX_SYNTAX_ERRORS } = {}) {
    this.tokens = tokens;
    this.diags = diags;
    this.maxErrors = maxErrors;
    this.errorCount = 0;
    this.pos = 0;
  }

  // ---- token helpers ---------------------------------------------------

  get cur() {
    return this.tokens[this.pos];
  }

  get prev() {
    return this.tokens[this.pos - 1];
  }

  advance() {
    const t = this.cur;
    if (t.kind !== 'EOF') this.pos++;
    return t;
  }

  static isSym(tok, lexeme) {
    return tok !== undefined && (tok.kind === 'Keyword' || tok.kind === 'Punct') && tok.lexeme === lexeme;
  }

  at(lexeme) {
    return Parser.isSym(this.cur, lexeme);
  }

  eat(lexeme) {
    return this.at(lexeme) ? this.advance() : null;
  }

  expect(lexeme, context) {
    if (this.at(lexeme)) return this.advance();
    // A missing ';' is easiest to read when the caret sits just after the
    // previous token rather than on whatever comes next, possibly lines away.
    const where = lexeme === ';' && this.pos > 0 ? spanAfter(this.prev.span) : this.cur.span;
    this.fail(`expected '${lexeme}' ${context}, found ${describe(this.cur)}`, where);
  }

  // ---- errors and recovery ----------------------------------------------

  // Records an error without unwinding.
  report(message, span) {
    this.errorCount++;
    this.diags.error(message, span);
    if (this.errorCount >= this.maxErrors) throw new TooManyErrors();
  }

  // Records an error and unwinds to the nearest statement loop. If the
  // parser is failing because of a token the lexer already reported, the
  // error is a cascade, so it is not reported again.
  fail(message, span) {
    if (!this.cur.reported && !(this.prev && this.prev.reported)) this.report(message, span);
    throw new ParseError();
  }

  // Runs parseFn. If it fails, skips to the next statement boundary and
  // returns null. Always consumes at least one token on failure, so the
  // caller's loop is guaranteed to make progress.
  recovering(parseFn) {
    const start = this.pos;
    try {
      return parseFn();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.synchronize();
      if (this.pos === start) this.advance();
      return null;
    }
  }

  synchronize() {
    for (;;) {
      const t = this.cur;
      if (t.kind === 'EOF' || Parser.isSym(t, '}')) return;
      if ((t.kind === 'Keyword' || t.kind === 'Punct') && STATEMENT_START.has(t.lexeme)) return;
      this.advance();
      if (Parser.isSym(this.prev, ';')) return;
    }
  }

  // ---- declarations ---------------------------------------------------

  // program ::= { fnDecl | statement } EOF
  parseProgram() {
    const body = [];
    try {
      while (this.cur.kind !== 'EOF') {
        const item = this.recovering(() => (this.at('fn') ? this.parseFnDecl() : this.parseStatement()));
        if (item) body.push(item);
      }
    } catch (e) {
      if (!(e instanceof TooManyErrors)) throw e;
      this.diags.note(`too many syntax errors (${this.maxErrors}); stopping`);
    }
    const eof = this.tokens[this.tokens.length - 1];
    const span = body.length ? unionAll(body.map((n) => n.span)) : eof.span;
    return { kind: 'Program', span, body };
  }

  // fnDecl ::= "fn" IDENT "(" [ param { "," param } ] ")" [ ":" type ] block
  parseFnDecl() {
    const kw = this.advance();
    const name = this.parseIdent("function name after 'fn'");
    this.expect('(', `after function name '${name.name}'`);
    const params = [];
    if (!this.at(')')) {
      do params.push(this.parseParam());
      while (this.eat(','));
    }
    this.expect(')', 'after parameter list');
    const returnType = this.eat(':') ? this.parseType('return type') : null;
    const body = this.parseBlock();
    return { kind: 'FnDecl', span: union(kw.span, body.span), name, params, returnType, body };
  }

  // param ::= IDENT ":" type
  parseParam() {
    const name = this.parseIdent('parameter name');
    this.expect(':', `after parameter '${name.name}'`);
    const type = this.parseType('parameter type');
    return { kind: 'Param', span: union(name.span, type.span), name, type };
  }

  // type ::= ( "int" | "bool" | "string" ) [ "[" "]" ]
  parseType(what) {
    const t = this.cur;
    if (t.kind === 'Keyword' && TYPE_NAMES.has(t.lexeme)) {
      this.advance();
      if (!this.at('[')) return { kind: 'TypeRef', span: t.span, name: t.lexeme };
      this.advance();
      const close = this.expect(']', `to finish the array type '${t.lexeme}[]'`);
      return { kind: 'TypeRef', span: union(t.span, close.span), name: `${t.lexeme}[]` };
    }
    this.fail(`expected ${what} ('int', 'bool' or 'string', or an array of one), found ${describe(t)}`, t.span);
  }

  parseIdent(what) {
    const t = this.cur;
    if (t.kind === 'Ident') {
      this.advance();
      return { kind: 'Ident', span: t.span, name: t.lexeme };
    }
    this.fail(`expected ${what}, found ${describe(t)}`, t.span);
  }

  // ---- statements -------------------------------------------------------

  // block ::= "{" { statement } "}"
  parseBlock() {
    const open = this.expect('{', 'to start a block');
    const body = [];
    while (!this.at('}') && this.cur.kind !== 'EOF') {
      const stmt = this.recovering(() => this.parseStatement());
      if (stmt) body.push(stmt);
    }
    const close = this.expect('}', 'to close the block');
    return { kind: 'Block', span: union(open.span, close.span), body };
  }

  parseStatement() {
    const t = this.cur;
    if (t.kind === 'Keyword' || t.kind === 'Punct') {
      switch (t.lexeme) {
        case 'let': {
          const stmt = this.parseLet();
          const semi = this.expect(';', 'after variable declaration');
          return { ...stmt, span: union(stmt.span, semi.span) };
        }
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'break': return this.parseJump('Break');
        case 'continue': return this.parseJump('Continue');
        case 'return': return this.parseReturn();
        case 'print': return this.parsePrint();
        case '{': return this.parseBlock();
        case 'fn': {
          // Parse it so recovery is clean, then reject it: nested functions
          // would be closures, which are out of scope.
          const fn = this.parseFnDecl();
          this.report('functions can only be declared at the top level', fn.name.span);
          return null;
        }
      }
    }
    const stmt = this.parseSimple();
    const semi = this.expect(';', 'after statement');
    return { ...stmt, span: union(stmt.span, semi.span) };
  }

  // letDecl ::= "let" IDENT [ ":" type ] "=" expr
  parseLet() {
    const kw = this.advance();
    const name = this.parseIdent("variable name after 'let'");
    const type = this.eat(':') ? this.parseType('type annotation') : null;
    this.expect('=', `in declaration of '${name.name}'`);
    const init = this.parseExpr();
    return { kind: 'Let', span: union(kw.span, init.span), name, type, init };
  }

  // simpleStmt ::= target assignOp expr | expr
  // target     ::= IDENT | postfix "[" expr "]"
  //
  // The left side is parsed as an expression and then checked, so that an
  // array element (`xs[i] = v`) can be assigned as well as a variable.
  parseSimple() {
    const expr = this.parseExpr();
    if (this.cur.kind === 'Punct' && ASSIGN_OPS.has(this.cur.lexeme)) {
      if (expr.kind !== 'Ident' && expr.kind !== 'Index') {
        this.fail('only a variable or an array element can be assigned to', expr.span);
      }
      const opTok = this.advance();
      const value = this.parseExpr();
      return { kind: 'Assign', span: union(expr.span, value.span), op: opTok.lexeme, opSpan: opTok.span, target: expr, value };
    }
    return { kind: 'ExprStmt', span: expr.span, expr };
  }

  // ifStmt ::= "if" "(" expr ")" block [ "else" ( ifStmt | block ) ]
  parseIf() {
    const kw = this.advance();
    this.expect('(', "after 'if'");
    const cond = this.parseExpr();
    this.expect(')', 'after if condition');
    const then = this.parseBlock();
    let otherwise = null;
    if (this.eat('else')) otherwise = this.at('if') ? this.parseIf() : this.parseBlock();
    return { kind: 'If', span: union(kw.span, (otherwise ?? then).span), cond, then, else: otherwise };
  }

  // whileStmt ::= "while" "(" expr ")" block
  parseWhile() {
    const kw = this.advance();
    this.expect('(', "after 'while'");
    const cond = this.parseExpr();
    this.expect(')', 'after while condition');
    const body = this.parseBlock();
    return { kind: 'While', span: union(kw.span, body.span), cond, body };
  }

  // forStmt ::= "for" "(" [ letDecl | simpleStmt ] ";" [ expr ] ";" [ simpleStmt ] ")" block
  parseFor() {
    const kw = this.advance();
    this.expect('(', "after 'for'");
    const init = this.at(';') ? null : this.at('let') ? this.parseLet() : this.parseSimple();
    this.expect(';', 'after for-loop initialiser');
    const cond = this.at(';') ? null : this.parseExpr();
    this.expect(';', 'after for-loop condition');
    const update = this.at(')') ? null : this.parseSimple();
    this.expect(')', 'after for-loop header');
    const body = this.parseBlock();
    return { kind: 'For', span: union(kw.span, body.span), init, cond, update, body };
  }

  // breakStmt ::= "break" ";"
  // continueStmt ::= "continue" ";"
  parseJump(kind) {
    const kw = this.advance();
    const semi = this.expect(';', `after '${kw.lexeme}'`);
    return { kind, span: union(kw.span, semi.span) };
  }

  // returnStmt ::= "return" [ expr ] ";"
  parseReturn() {
    const kw = this.advance();
    const value = this.at(';') ? null : this.parseExpr();
    const semi = this.expect(';', 'after return statement');
    return { kind: 'Return', span: union(kw.span, semi.span), value };
  }

  // printStmt ::= "print" "(" expr ")" ";"
  parsePrint() {
    const kw = this.advance();
    this.expect('(', "after 'print'");
    const value = this.parseExpr();
    this.expect(')', 'after print argument');
    const semi = this.expect(';', 'after print statement');
    return { kind: 'Print', span: union(kw.span, semi.span), value };
  }

  // ---- expressions --------------------------------------------------------

  // Precedence climbing. Parses a binary expression whose operators all bind
  // at least as tightly as minPrec.
  parseExpr(minPrec = 1) {
    let left = this.parseUnary();
    for (;;) {
      const t = this.cur;
      const prec = t.kind === 'Punct' ? BINARY_PRECEDENCE.get(t.lexeme) : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.advance();
      const right = this.parseExpr(prec + 1); // +1: left-associative
      left = { kind: 'Binary', span: union(left.span, right.span), op: t.lexeme, opSpan: t.span, left, right };
    }
  }

  // unary ::= ( "-" | "!" ) unary | postfix
  parseUnary() {
    if (this.at('-') || this.at('!')) {
      const op = this.advance();
      const operand = this.parseUnary();
      return { kind: 'Unary', span: union(op.span, operand.span), op: op.lexeme, operand };
    }
    return this.parsePostfix();
  }

  // postfix ::= primary { "[" expr "]" }
  parsePostfix() {
    let e = this.parsePrimary();
    while (this.at('[')) {
      this.advance();
      const index = this.parseExpr();
      const close = this.expect(']', 'to close the index');
      e = { kind: 'Index', span: union(e.span, close.span), object: e, index };
    }
    return e;
  }

  // primary ::= INT | STRING | BOOL | IDENT [ "(" [ expr { "," expr } ] ")" ]
  //           | "(" expr ")" | "[" [ expr { "," expr } ] "]"
  parsePrimary() {
    const t = this.cur;
    switch (t.kind) {
      case 'Int':
        this.advance();
        return { kind: 'IntLit', span: t.span, value: t.value };
      case 'String':
        this.advance();
        return { kind: 'StringLit', span: t.span, value: t.value };
      case 'Bool':
        this.advance();
        return { kind: 'BoolLit', span: t.span, value: t.value };
      case 'Ident': {
        const id = this.parseIdent('identifier');
        if (!this.at('(')) return id;
        this.advance();
        const args = [];
        if (!this.at(')')) {
          do args.push(this.parseExpr());
          while (this.eat(','));
        }
        const close = this.expect(')', `to close the call to '${id.name}'`);
        return { kind: 'Call', span: union(id.span, close.span), callee: id, args };
      }
    }
    if (this.at('(')) {
      const open = this.advance();
      const expr = this.parseExpr();
      const close = this.expect(')', 'to close the parenthesised expression');
      return { kind: 'Paren', span: union(open.span, close.span), expr };
    }
    if (this.at('[')) {
      const open = this.advance();
      const elements = [];
      if (!this.at(']')) {
        do elements.push(this.parseExpr());
        while (this.eat(','));
      }
      const close = this.expect(']', 'to close the array');
      return { kind: 'ArrayLit', span: union(open.span, close.span), elements };
    }
    this.fail(`expected an expression, found ${describe(t)}`, t.span);
  }
}
