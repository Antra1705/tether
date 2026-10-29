// Semantic analysis (FR-S1, FR-S2).
//
// check() resolves every identifier to a symbol and gives every expression a
// type. It annotates the AST in place: identifiers get `symbol`, expressions
// get `type`. Spans are never changed. The rules are written down in
// docs/semantics.md.
//
// Scopes form a tree:
//
//   global        every function (collected first, so order does not matter)
//   ├── main      top-level let bindings, then nested blocks
//   └── fn f      parameters and the outermost locals of f, then nested blocks
//
// Function bodies cannot see top-level variables: a function only sees other
// functions, its parameters and its own locals. That keeps every function
// free of captured state, which matches the "no closures" scope of the
// language.
//
// To avoid cascades, an expression that already has an error gets the type
// ERROR, which is accepted wherever a type is expected.
//
// Types are strings: 'int', 'bool', 'string', and for arrays the element type
// followed by '[]', such as 'int[]'. Arrays are one-dimensional. An array
// literal takes its element type from its elements, or, when it is empty,
// from where it is used (`let xs: int[] = [];`), which is why checkExpr takes
// an optional expected type. The built-in functions len and push live in the
// global scope and cannot be redeclared there.
//
// Each symbol also gets the JavaScript name the emitter will use (FR-G3):
//   * a name that is reserved in JavaScript gets a '$' suffix: var -> var$
//   * a declaration that shadows a visible binding gets '$<n>': x -> x$1
// '$' cannot appear in a Tether identifier, so neither can collide with a
// name the programmer wrote. Renaming shadowing declarations also keeps
// JavaScript's temporal dead zone out of the picture: in Tether,
// `let x = x + 1;` in an inner block reads the outer x.

import { makeSpan } from './span.js';

export const INT = 'int';
export const BOOL = 'bool';
export const STRING = 'string';
export const VOID = 'void';
export const ERROR = '<error>';

export const isArray = (t) => t.endsWith('[]');
const elementOf = (t) => t.slice(0, -2);
const BUILTINS = ['len', 'push'];

// Reserved or predefined in strict-mode ES2015 and later, plus the globals the
// emitted code relies on (console, Math, and Error and RangeError in the
// checked-indexing helpers).
export const JS_RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'globalThis', 'console', 'Math',
  'Error', 'RangeError',
]);

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.names = new Map();
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) {
      const sym = s.names.get(name);
      if (sym) return sym;
    }
    return null;
  }
}

const quote = (t) => `'${t}'`;

// A span covering the first `length` code units of `span`, on its first line.
function prefix(span, length) {
  return makeSpan(span.file, span.offset, length, span.line, span.col, span.line, span.col + length);
}

export function check(program, diags) {
  return new Checker(diags).checkProgram(program);
}

class Checker {
  constructor(diags) {
    this.diags = diags;
    this.global = new Scope(null);
    this.main = new Scope(this.global); // top-level statements
    this.fn = null; // symbol of the function being checked, or null at top level
    this.loops = 0; // how many loops enclose the statement being checked
    this.shadowCount = new Map();
  }

  error(message, span, notes) {
    this.diags.error(message, span, notes);
  }

  // ---- declarations --------------------------------------------------------

  // Declares `sym` in `scope`, reporting a redeclaration in the same scope.
  declare(scope, sym) {
    const prev = scope.names.get(sym.name);
    // The top level is the global scope plus the scope of top-level statements.
    const topLevel = scope === this.global || scope === this.main;
    // The declaration is still recorded after this error, so later uses of the
    // name resolve to it and the one mistake gives one message.
    const reusesBuiltin = topLevel && this.global.names.get(sym.name)?.kind === 'builtin';
    if (reusesBuiltin) {
      this.error(`${quote(sym.name)} is a built-in function and cannot be redeclared here`, sym.declSpan);
    } else if (prev) {
      this.error(`${quote(sym.name)} is already declared in this scope`, sym.declSpan,
        [{ message: `previous declaration of ${quote(sym.name)} is here`, span: prev.declSpan }]);
      return false;
    }
    let js = JS_RESERVED.has(sym.name) ? `${sym.name}$` : sym.name;
    const outer = scope.parent && scope.parent.lookup(sym.name);
    if (outer && outer.kind !== 'builtin') {
      const n = (this.shadowCount.get(js) ?? 0) + 1;
      this.shadowCount.set(js, n);
      js = `${js}${sym.name === js ? '$' : ''}${n}`;
    }
    sym.jsName = js;
    scope.names.set(sym.name, sym);
    return !reusesBuiltin;
  }

  checkProgram(program) {
    for (const name of BUILTINS) this.global.names.set(name, { kind: 'builtin', name });
    // Pass 1: every function signature, so calls may precede declarations.
    for (const item of program.body) {
      if (item.kind !== 'FnDecl') continue;
      const sym = {
        kind: 'fn',
        name: item.name.name,
        declSpan: item.name.span,
        params: item.params.map((p) => p.type.name),
        returnType: item.returnType ? item.returnType.name : VOID,
      };
      item.symbol = sym;
      item.name.symbol = sym;
      if (!this.declare(this.global, sym)) item.duplicate = true;
    }
    // Pass 2: bodies and top-level statements, in source order.
    for (const item of program.body) {
      if (item.kind === 'FnDecl') this.checkFn(item);
      else this.checkStmt(item, this.main);
    }
  }

  checkFn(fn) {
    const sym = fn.symbol;
    const scope = new Scope(this.global);
    for (const p of fn.params) {
      const ps = { kind: 'param', name: p.name.name, declSpan: p.name.span, type: p.type.name };
      p.name.symbol = ps;
      this.declare(scope, ps);
    }
    const outer = this.fn;
    this.fn = sym;
    // Parameters and the outermost locals share a scope, as in JavaScript.
    for (const stmt of fn.body.body) this.checkStmt(stmt, scope);
    this.fn = outer;
    if (sym.returnType !== VOID && !fn.duplicate && !returns(fn.body)) {
      this.error(`function ${quote(sym.name)} does not return a value on every path`, fn.name.span,
        [{ message: `its return type is ${quote(sym.returnType)}`, span: fn.returnType.span }]);
    }
  }

  // ---- statements ----------------------------------------------------------

  checkBlock(block, parent) {
    const scope = new Scope(parent);
    for (const stmt of block.body) this.checkStmt(stmt, scope);
  }

  checkLoopBody(block, scope) {
    this.loops++;
    this.checkBlock(block, scope);
    this.loops--;
  }

  checkCondition(expr, scope, what) {
    const t = this.checkExpr(expr, scope);
    if (t !== BOOL && t !== ERROR) {
      this.error(`${what} condition must be ${quote(BOOL)}, found ${quote(t)}`, expr.span);
    }
  }

  checkStmt(stmt, scope) {
    switch (stmt.kind) {
      case 'Let': return this.checkLet(stmt, scope);
      case 'Assign': return this.checkAssign(stmt, scope);
      case 'ExprStmt': this.checkExpr(stmt.expr, scope); return;
      case 'Block': return this.checkBlock(stmt, scope);
      case 'If':
        this.checkCondition(stmt.cond, scope, "'if'");
        this.checkBlock(stmt.then, scope);
        if (stmt.else) {
          if (stmt.else.kind === 'If') this.checkStmt(stmt.else, scope);
          else this.checkBlock(stmt.else, scope);
        }
        return;
      case 'While':
        this.checkCondition(stmt.cond, scope, "'while'");
        this.checkLoopBody(stmt.body, scope);
        return;
      case 'For': {
        const header = new Scope(scope);
        if (stmt.init) this.checkStmt(stmt.init, header);
        if (stmt.cond) this.checkCondition(stmt.cond, header, "'for'");
        if (stmt.update) this.checkStmt(stmt.update, header);
        this.checkLoopBody(stmt.body, header);
        return;
      }
      case 'Break':
      case 'Continue':
        if (!this.loops) {
          const word = stmt.kind.toLowerCase();
          this.error(`'${word}' outside a loop`, prefix(stmt.span, word.length));
        }
        return;
      case 'Return': return this.checkReturn(stmt, scope);
      case 'Print': {
        const t = this.checkExpr(stmt.value, scope);
        if (t === VOID) this.error('print needs a value, but this call returns nothing', stmt.value.span);
        return;
      }
      default:
        throw new Error(`checker: unexpected statement kind '${stmt.kind}'`);
    }
  }

  checkLet(stmt, scope) {
    const declared = stmt.type ? stmt.type.name : null;
    const init = this.checkExpr(stmt.init, scope, declared);
    if (init === VOID) {
      this.error(`cannot initialise ${quote(stmt.name.name)} with a call that returns nothing`, stmt.init.span);
    } else if (declared && init !== ERROR && init !== declared) {
      this.error(`${quote(stmt.name.name)} is declared ${quote(declared)}, but is initialised with ${quote(init)}`, stmt.init.span);
    }
    const type = declared ?? (init === VOID ? ERROR : init);
    // Declared after the initialiser is checked: `let x = x + 1;` reads the outer x.
    const sym = { kind: 'var', name: stmt.name.name, declSpan: stmt.name.span, type };
    stmt.name.symbol = sym;
    this.declare(scope, sym);
  }

  checkAssign(stmt, scope) {
    if (stmt.target.kind === 'Index') return this.checkElementAssign(stmt, scope);
    // The variable's type, if it has one, tells an empty array literal its type.
    const known = scope.lookup(stmt.target.name);
    const expected = known && known.type && stmt.op === '=' ? known.type : null;
    const value = this.checkExpr(stmt.value, scope, expected);
    const target = this.resolveVar(stmt.target, scope, 'assign to');
    if (target === ERROR || value === ERROR) return;
    if (stmt.op === '=') {
      if (value !== target) {
        this.error(`cannot assign ${quote(value)} to ${quote(stmt.target.name)}, which is ${quote(target)}`, stmt.value.span);
      }
      return;
    }
    const op = stmt.op[0];
    const result = binaryResult(op, target, value);
    if (result === null || result !== target) {
      this.error(`operator ${quote(stmt.op)} cannot be applied to ${quote(target)} and ${quote(value)}`, stmt.span);
    }
  }

  // xs[i] = v
  checkElementAssign(stmt, scope) {
    const element = this.checkExpr(stmt.target, scope);
    if (stmt.op !== '=') {
      this.checkExpr(stmt.value, scope);
      this.error(`compound assignment to an array element is not supported; write it out, as in xs[i] = xs[i] ${stmt.op[0]} …`, stmt.opSpan);
      return;
    }
    const value = this.checkExpr(stmt.value, scope, element === ERROR ? null : element);
    if (element !== ERROR && value !== ERROR && value !== element) {
      this.error(`cannot store ${quote(value)} in an array of ${quote(element)}`, stmt.value.span);
    }
  }

  checkReturn(stmt, scope) {
    const kw = prefix(stmt.span, 'return'.length);
    if (!this.fn) {
      if (stmt.value) this.checkExpr(stmt.value, scope);
      this.error("'return' outside a function", kw);
      return;
    }
    const want = this.fn.returnType;
    if (!stmt.value) {
      if (want !== VOID) this.error(`${quote(this.fn.name)} must return a value of type ${quote(want)}`, kw);
      return;
    }
    const got = this.checkExpr(stmt.value, scope, want === VOID ? null : want);
    if (want === VOID) {
      this.error(`${quote(this.fn.name)} has no return type, so it cannot return a value`, stmt.value.span);
    } else if (got !== ERROR && got !== want) {
      this.error(`${quote(this.fn.name)} returns ${quote(want)}, but this value is ${quote(got)}`, stmt.value.span);
    }
  }

  // Resolves an identifier that must name a variable or parameter.
  resolveVar(ident, scope, verb) {
    const sym = scope.lookup(ident.name);
    if (!sym) {
      this.error(`unknown variable ${quote(ident.name)}`, ident.span);
      return ERROR;
    }
    if (sym.kind === 'fn' || sym.kind === 'builtin') {
      this.error(`cannot ${verb} ${quote(ident.name)}: it is a function`, ident.span,
        sym.declSpan ? [{ message: `${quote(ident.name)} is declared here`, span: sym.declSpan }] : undefined);
      return ERROR;
    }
    ident.symbol = sym;
    return sym.type;
  }

  // ---- expressions ------------------------------------------------------------

  // expected: the type the context needs, if any. Only an array literal uses
  // it, to type an empty array; every other mismatch is reported by the caller.
  checkExpr(e, scope, expected = null) {
    e.type = this.typeOf(e, scope, expected);
    return e.type;
  }

  typeOf(e, scope, expected) {
    switch (e.kind) {
      case 'IntLit': return INT;
      case 'StringLit': return STRING;
      case 'BoolLit': return BOOL;
      case 'Paren': return this.checkExpr(e.expr, scope);
      case 'Ident': {
        const sym = scope.lookup(e.name);
        if (!sym) {
          this.error(`unknown variable ${quote(e.name)}`, e.span);
          return ERROR;
        }
        if (sym.kind === 'fn' || sym.kind === 'builtin') {
          this.error(`function ${quote(e.name)} cannot be used as a value; did you mean to call it?`, e.span);
          return ERROR;
        }
        e.symbol = sym;
        return sym.type;
      }
      case 'Unary': {
        const t = this.checkExpr(e.operand, scope);
        const want = e.op === '-' ? INT : BOOL;
        if (t === ERROR) return want;
        if (t !== want) {
          this.error(`operator ${quote(e.op)} needs ${want === INT ? 'an' : 'a'} ${quote(want)} operand, found ${quote(t)}`, e.operand.span);
        }
        return want;
      }
      case 'Binary': return this.checkBinary(e, scope);
      case 'Call': return this.checkCall(e, scope);
      case 'ArrayLit': return this.checkArray(e, scope, expected);
      case 'Index': {
        const object = this.checkExpr(e.object, scope);
        const index = this.checkExpr(e.index, scope);
        if (index !== INT && index !== ERROR) {
          this.error(`an array index must be ${quote(INT)}, found ${quote(index)}`, e.index.span);
        }
        if (object === ERROR) return ERROR;
        if (!isArray(object)) {
          this.error(`only an array can be indexed; this is ${quote(object)}`, e.object.span);
          return ERROR;
        }
        return elementOf(object);
      }
      default:
        throw new Error(`checker: unexpected expression kind '${e.kind}'`);
    }
  }

  checkArray(e, scope, expected) {
    const want = expected && isArray(expected) ? elementOf(expected) : null;
    const types = e.elements.map((el) => this.checkExpr(el, scope, want));
    if (!e.elements.length) {
      if (want) return expected;
      if (expected && expected !== ERROR) this.error(`an empty array cannot be used as ${quote(expected)}`, e.span);
      else this.error(`cannot tell the element type of an empty array; give the variable a type, such as ${quote('int[]')}`, e.span);
      return ERROR;
    }
    const element = want ?? types.find((t) => t !== ERROR && t !== VOID && !isArray(t));
    e.elements.forEach((el, i) => {
      const t = types[i];
      if (t === ERROR) return;
      if (t === VOID) this.error('an array element needs a value, but this call returns nothing', el.span);
      else if (isArray(t)) this.error('an array cannot contain arrays', el.span);
      else if (element && t !== element) this.error(`array elements must all be ${quote(element)}; this one is ${quote(t)}`, el.span);
    });
    return element ? `${element}[]` : ERROR;
  }

  checkBinary(e, scope) {
    const l = this.checkExpr(e.left, scope);
    const r = this.checkExpr(e.right, scope);
    const natural = { '<': BOOL, '<=': BOOL, '>': BOOL, '>=': BOOL, '==': BOOL, '!=': BOOL, '&&': BOOL, '||': BOOL };
    if (l === ERROR || r === ERROR) return natural[e.op] ?? (e.op === '+' ? ERROR : INT);
    const result = binaryResult(e.op, l, r);
    if (result !== null) return result;
    // Point at the operand that is wrong when the other one is fine.
    const want = operandType(e.op);
    if (want && l === want && r !== want) {
      this.error(`operator ${quote(e.op)} needs ${quote(want)} operands; this one is ${quote(r)}`, e.right.span);
    } else if (want && r === want && l !== want) {
      this.error(`operator ${quote(e.op)} needs ${quote(want)} operands; this one is ${quote(l)}`, e.left.span);
    } else if ((e.op === '==' || e.op === '!=') && l === r && isArray(l)) {
      this.error(`arrays cannot be compared with ${quote(e.op)}; compare their elements instead`, e.span);
    } else if (e.op === '==' || e.op === '!=') {
      this.error(`cannot compare ${quote(l)} with ${quote(r)}`, e.span);
    } else {
      this.error(`operator ${quote(e.op)} cannot be applied to ${quote(l)} and ${quote(r)}`, e.span);
    }
    return natural[e.op] ?? (want ?? ERROR);
  }

  checkCall(e, scope) {
    const name = e.callee.name;
    const sym = scope.lookup(name);
    // Parameter types tell empty array arguments their type.
    const argTypes = e.args.map((a, i) => this.checkExpr(a, scope, sym?.kind === 'fn' ? sym.params[i] ?? null : null));
    if (sym?.kind === 'builtin') {
      e.callee.symbol = sym;
      return this.checkBuiltin(e, name, argTypes);
    }
    if (!sym) {
      this.error(`unknown function ${quote(name)}`, e.callee.span);
      return ERROR;
    }
    if (sym.kind !== 'fn') {
      this.error(`${quote(name)} is not a function`, e.callee.span,
        [{ message: `${quote(name)} is declared here`, span: sym.declSpan }]);
      return ERROR;
    }
    e.callee.symbol = sym;
    if (argTypes.length !== sym.params.length) {
      const n = sym.params.length;
      this.error(`${quote(name)} expects ${n} argument${n === 1 ? '' : 's'}, but got ${argTypes.length}`, e.span,
        [{ message: `${quote(name)} is declared here`, span: sym.declSpan }]);
    }
    const count = Math.min(argTypes.length, sym.params.length);
    for (let i = 0; i < count; i++) {
      const got = argTypes[i];
      const want = sym.params[i];
      if (got !== ERROR && got !== want) {
        this.error(`argument ${i + 1} of ${quote(name)} must be ${quote(want)}, found ${quote(got)}`, e.args[i].span);
      }
    }
    return sym.returnType;
  }

  // len(x): the length of an array or a string. push(xs, v): appends v to xs.
  checkBuiltin(e, name, argTypes) {
    const arity = name === 'len' ? 1 : 2;
    if (argTypes.length !== arity) {
      this.error(`${quote(name)} expects ${arity} argument${arity === 1 ? '' : 's'}, but got ${argTypes.length}`, e.span);
      return name === 'len' ? INT : VOID;
    }
    const [a, b] = argTypes;
    if (name === 'len') {
      if (a !== ERROR && a !== STRING && !isArray(a)) {
        this.error(`${quote('len')} needs an array or a string, found ${quote(a)}`, e.args[0].span);
      }
      return INT;
    }
    if (a !== ERROR && !isArray(a)) {
      this.error(`the first argument of ${quote('push')} must be an array, found ${quote(a)}`, e.args[0].span);
    } else if (a !== ERROR && b !== ERROR && b !== elementOf(a)) {
      this.error(`cannot push ${quote(b)} onto an array of ${quote(elementOf(a))}`, e.args[1].span);
    }
    return VOID;
  }
}


// The type both operands must have for operators that take only one type.
function operandType(op) {
  if (['-', '*', '/', '%', '<', '<=', '>', '>='].includes(op)) return INT;
  if (op === '&&' || op === '||') return BOOL;
  return null;
}

// The result type of a binary operator, or null when the operand types are
// not allowed. Also used for compound assignment.
function binaryResult(op, l, r) {
  if (l === VOID || r === VOID || isArray(l) || isArray(r)) return null;
  switch (op) {
    case '+':
      if (l === INT && r === INT) return INT;
      if (l === STRING && r === STRING) return STRING;
      return null;
    case '-': case '*': case '/': case '%':
      return l === INT && r === INT ? INT : null;
    case '<': case '<=': case '>': case '>=':
      return l === INT && r === INT ? BOOL : null;
    case '==': case '!=':
      return l === r ? BOOL : null;
    case '&&': case '||':
      return l === BOOL && r === BOOL ? BOOL : null;
    default:
      return null;
  }
}

// Definite-return analysis. Conservative: loops may run zero times, so they
// never count as returning.
export function returns(stmt) {
  switch (stmt.kind) {
    case 'Return': return true;
    case 'Block': return stmt.body.some(returns);
    case 'If': return stmt.else !== null && returns(stmt.then) && returns(stmt.else);
    default: return false;
  }
}
