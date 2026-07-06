/**
 * Minimal yq/jq expression evaluator.
 *
 * Only the subset of jq syntax needed to execute docker/mcp-gateway's
 * `pkg/client/config.yml` `yq.set` expressions. Nine primitives, one
 * hand-written recursive-descent parser, one evaluator. When an
 * expression uses a construct outside this grammar, we throw with the
 * offending token position so the catalog sync fails loud.
 *
 * Supported constructs:
 *   - Path selector       .foo[$NAME].bar
 *   - Variable reference  $JSON, $NAME, $SIMPLE_NAME
 *   - Field access        $JSON.command
 *   - Object literal      {"key": expr, ...}
 *   - Array literal       [expr, ...]
 *   - Object merge        A + B (right-wins deep merge; array concat if both arrays)
 *   - List append         path += [expr]
 *   - Null coalesce       A // B
 *   - Pipe                stmt | stmt (sequential updates against the same document root)
 *   - Assignment          path = expr
 *
 * NOT supported (throws on encounter, forcing a human to extend):
 *   Array indexing .foo[0], conditionals, recursion `..`, regex, format
 *   strings, path variables, arithmetic beyond `+`, comparison operators.
 */

// -------------------------------------------------------------------
// Lexer
// -------------------------------------------------------------------

export type Token =
  | { kind: 'dot' }
  | { kind: 'lbracket' }
  | { kind: 'rbracket' }
  | { kind: 'lbrace' }
  | { kind: 'rbrace' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'colon' }
  | { kind: 'comma' }
  | { kind: 'assign' } // =
  | { kind: 'append' } // +=
  | { kind: 'plus' } // +
  | { kind: 'pipe' } // |
  | { kind: 'coalesce' } // //
  | { kind: 'variable'; name: string } // $NAME
  | { kind: 'ident'; name: string } // foo (a-z A-Z 0-9 _)
  | { kind: 'string'; value: string } // "..."
  | { kind: 'number'; value: number } // 300
  | { kind: 'bool'; value: boolean } // true / false
  | { kind: 'null' }

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '.') {
      tokens.push({ kind: 'dot' })
      i++
      continue
    }
    if (c === '[') {
      tokens.push({ kind: 'lbracket' })
      i++
      continue
    }
    if (c === ']') {
      tokens.push({ kind: 'rbracket' })
      i++
      continue
    }
    if (c === '{') {
      tokens.push({ kind: 'lbrace' })
      i++
      continue
    }
    if (c === '}') {
      tokens.push({ kind: 'rbrace' })
      i++
      continue
    }
    if (c === '(') {
      tokens.push({ kind: 'lparen' })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ kind: 'rparen' })
      i++
      continue
    }
    if (c === ':') {
      tokens.push({ kind: 'colon' })
      i++
      continue
    }
    if (c === ',') {
      tokens.push({ kind: 'comma' })
      i++
      continue
    }
    if (c === '|') {
      tokens.push({ kind: 'pipe' })
      i++
      continue
    }
    if (c === '=') {
      tokens.push({ kind: 'assign' })
      i++
      continue
    }
    if (c === '+') {
      if (source[i + 1] === '=') {
        tokens.push({ kind: 'append' })
        i += 2
        continue
      }
      tokens.push({ kind: 'plus' })
      i++
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      tokens.push({ kind: 'coalesce' })
      i += 2
      continue
    }
    if (c === '$') {
      let j = i + 1
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] ?? '')) j++
      tokens.push({ kind: 'variable', name: source.slice(i + 1, j) })
      i = j
      continue
    }
    if (c === '"') {
      let j = i + 1
      let out = ''
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1]
          out +=
            next === 'n'
              ? '\n'
              : next === '"'
                ? '"'
                : next === '\\'
                  ? '\\'
                  : next
          j += 2
        } else {
          out += source[j]
          j++
        }
      }
      if (j >= source.length) {
        throw new YqError(`unterminated string starting at position ${i}`)
      }
      tokens.push({ kind: 'string', value: out })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c ?? '')) {
      let j = i
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] ?? '')) j++
      const word = source.slice(i, j)
      if (word === 'null') tokens.push({ kind: 'null' })
      else if (word === 'true') tokens.push({ kind: 'bool', value: true })
      else if (word === 'false') tokens.push({ kind: 'bool', value: false })
      else tokens.push({ kind: 'ident', name: word })
      i = j
      continue
    }
    if (/[0-9]/.test(c ?? '')) {
      let j = i
      while (j < source.length && /[0-9]/.test(source[j] ?? '')) j++
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        j++
        while (j < source.length && /[0-9]/.test(source[j] ?? '')) j++
      }
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) })
      i = j
      continue
    }
    throw new YqError(`unexpected character '${c}' at position ${i}`)
  }
  return tokens
}

// -------------------------------------------------------------------
// AST
// -------------------------------------------------------------------

export type Expr =
  | { kind: 'path'; segments: PathSegment[] } // .foo[$NAME].bar
  | { kind: 'var'; name: string } // $JSON
  | { kind: 'field'; target: Expr; field: string } // $JSON.command
  | { kind: 'objectLit'; entries: Array<{ key: string; value: Expr }> }
  | { kind: 'arrayLit'; items: Expr[] }
  | { kind: 'lit'; value: string | number | boolean | null } // "foo", 300, true, null
  | { kind: 'merge'; left: Expr; right: Expr } // A + B
  | { kind: 'coalesce'; left: Expr; right: Expr } // A // B

export type PathSegment =
  | { kind: 'field'; name: string }
  | { kind: 'bracket'; key: Expr }

export type Statement =
  | { kind: 'assign'; path: Expr; value: Expr }
  | { kind: 'append'; path: Expr; value: Expr }
  | { kind: 'expr'; expr: Expr }

export type Program = { statements: Statement[] }

// -------------------------------------------------------------------
// Parser
// -------------------------------------------------------------------

export class YqError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YqError'
  }
}

class Parser {
  private pos = 0
  constructor(private tokens: Token[]) {}

  parseProgram(): Program {
    const statements: Statement[] = []
    statements.push(this.parseStatement())
    while (this.peek()?.kind === 'pipe') {
      this.consume('pipe')
      statements.push(this.parseStatement())
    }
    if (this.pos < this.tokens.length) {
      throw new YqError(
        `unexpected trailing token: ${JSON.stringify(this.peek())}`,
      )
    }
    return { statements }
  }

  private parseStatement(): Statement {
    const left = this.parseExpr()
    const tok = this.peek()
    if (tok?.kind === 'assign') {
      this.consume('assign')
      const value = this.parseExpr()
      return { kind: 'assign', path: left, value }
    }
    if (tok?.kind === 'append') {
      this.consume('append')
      const value = this.parseExpr()
      return { kind: 'append', path: left, value }
    }
    return { kind: 'expr', expr: left }
  }

  // expr := coalesce
  private parseExpr(): Expr {
    return this.parseCoalesce()
  }

  private parseCoalesce(): Expr {
    let left = this.parseAdditive()
    while (this.peek()?.kind === 'coalesce') {
      this.consume('coalesce')
      const right = this.parseAdditive()
      left = { kind: 'coalesce', left, right }
    }
    return left
  }

  private parseAdditive(): Expr {
    let left = this.parsePostfix()
    while (this.peek()?.kind === 'plus') {
      this.consume('plus')
      const right = this.parsePostfix()
      left = { kind: 'merge', left, right }
    }
    return left
  }

  // postfix := atom ('.' ident)*
  // The trailing '.ident' is field access on a variable (e.g. $JSON.command).
  private parsePostfix(): Expr {
    let node = this.parseAtom()
    while (this.peek()?.kind === 'dot') {
      // Only consume '.field' as field access when the CURRENT node is a
      // variable. A leading '.' on a path is handled inside parseAtom.
      if (node.kind !== 'var' && node.kind !== 'field') break
      this.consume('dot')
      const t = this.expectIdent()
      node = { kind: 'field', target: node, field: t.name }
    }
    return node
  }

  private parseAtom(): Expr {
    const tok = this.peek()
    if (!tok) throw new YqError('unexpected end of input')
    if (tok.kind === 'lparen') {
      this.consume('lparen')
      const inner = this.parseExpr()
      this.consume('rparen')
      return inner
    }
    if (tok.kind === 'lbrace') return this.parseObjectLit()
    if (tok.kind === 'lbracket') return this.parseArrayLit()
    if (tok.kind === 'variable') {
      this.pos++
      return { kind: 'var', name: tok.name }
    }
    if (tok.kind === 'dot') return this.parsePath()
    if (tok.kind === 'null') {
      this.pos++
      return { kind: 'lit', value: null }
    }
    if (tok.kind === 'string') {
      this.pos++
      return { kind: 'lit', value: tok.value }
    }
    if (tok.kind === 'number') {
      this.pos++
      return { kind: 'lit', value: tok.value }
    }
    if (tok.kind === 'bool') {
      this.pos++
      return { kind: 'lit', value: tok.value }
    }
    throw new YqError(`unexpected token in atom: ${JSON.stringify(tok)}`)
  }

  private parsePath(): Expr {
    this.consume('dot')
    const segments: PathSegment[] = []
    // A bare '.' selects root; grab identifier if present.
    const t = this.peek()
    if (t?.kind === 'ident') {
      this.pos++
      segments.push({ kind: 'field', name: t.name })
    }
    while (true) {
      const nxt = this.peek()
      if (!nxt) break
      if (nxt.kind === 'lbracket') {
        this.consume('lbracket')
        const key = this.parseExpr()
        this.consume('rbracket')
        segments.push({ kind: 'bracket', key })
        continue
      }
      if (nxt.kind === 'dot') {
        // Peek ahead: '.ident' continues the path; '.something-that-isnt-ident'
        // is not part of this path.
        const after = this.tokens[this.pos + 1]
        if (after?.kind === 'ident') {
          this.consume('dot')
          const id = this.expectIdent()
          segments.push({ kind: 'field', name: id.name })
          continue
        }
      }
      break
    }
    return { kind: 'path', segments }
  }

  private parseObjectLit(): Expr {
    this.consume('lbrace')
    const entries: Array<{ key: string; value: Expr }> = []
    while (this.peek()?.kind !== 'rbrace') {
      const keyTok = this.peek()
      let key: string
      if (keyTok?.kind === 'string') {
        this.pos++
        key = keyTok.value
      } else if (keyTok?.kind === 'ident') {
        this.pos++
        key = keyTok.name
      } else {
        throw new YqError(`object key expected, got ${JSON.stringify(keyTok)}`)
      }
      this.consume('colon')
      const value = this.parseExpr()
      entries.push({ key, value })
      if (this.peek()?.kind === 'comma') this.consume('comma')
    }
    this.consume('rbrace')
    return { kind: 'objectLit', entries }
  }

  private parseArrayLit(): Expr {
    this.consume('lbracket')
    const items: Expr[] = []
    while (this.peek()?.kind !== 'rbracket') {
      items.push(this.parseExpr())
      if (this.peek()?.kind === 'comma') this.consume('comma')
    }
    this.consume('rbracket')
    return { kind: 'arrayLit', items }
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private consume(kind: Token['kind']): Token {
    const t = this.tokens[this.pos]
    if (!t) throw new YqError(`expected ${kind}, got end of input`)
    if (t.kind !== kind)
      throw new YqError(`expected ${kind}, got ${JSON.stringify(t)}`)
    this.pos++
    return t
  }

  private expectIdent(): Token & { kind: 'ident' } {
    const t = this.tokens[this.pos]
    if (t?.kind !== 'ident')
      throw new YqError(`expected ident, got ${JSON.stringify(t)}`)
    this.pos++
    return t
  }
}

export function parse(source: string): Program {
  return new Parser(tokenize(source)).parseProgram()
}

// -------------------------------------------------------------------
// Evaluator
// -------------------------------------------------------------------

export type Env = Record<string, unknown>
export type Doc = unknown

/**
 * Evaluate a parsed program against a starting document and environment.
 * Every statement runs in sequence against the same document. Returns the
 * final document plus a list of every path that got written or appended
 * so downstream inference knows where the "entry" lives.
 */
export interface EvalTrace {
  writes: Array<{
    op: 'assign' | 'append'
    setPath: PathSegment[]
    resolvedPath: string[]
    written: unknown
  }>
  finalDoc: Doc
}

export function evaluate(
  program: Program,
  env: Env,
  initialDoc: Doc = {},
): EvalTrace {
  let doc: Doc = deepClone(initialDoc)
  const writes: EvalTrace['writes'] = []
  for (const stmt of program.statements) {
    if (stmt.kind === 'expr') continue
    const value = evalExpr(stmt.value, env, doc)
    if (stmt.path.kind !== 'path') {
      throw new YqError(
        `left-hand side of ${stmt.kind} must be a path, got ${stmt.path.kind}`,
      )
    }
    const resolved = stmt.path.segments.map((s) => resolveSegment(s, env, doc))
    if (stmt.kind === 'assign') {
      doc = setPath(doc, resolved, value)
      writes.push({
        op: 'assign',
        setPath: stmt.path.segments,
        resolvedPath: resolved,
        written: value,
      })
    } else {
      const existing = getPath(doc, resolved)
      if (!Array.isArray(value)) {
        throw new YqError('right side of += must be an array')
      }
      const nextArr = Array.isArray(existing)
        ? [...existing, ...value]
        : [...value]
      doc = setPath(doc, resolved, nextArr)
      writes.push({
        op: 'append',
        setPath: stmt.path.segments,
        resolvedPath: resolved,
        written: value[value.length - 1],
      })
    }
  }
  return { writes, finalDoc: doc }
}

function evalExpr(expr: Expr, env: Env, doc: Doc): unknown {
  switch (expr.kind) {
    case 'lit':
      return expr.value
    case 'var':
      return env[expr.name] ?? null
    case 'field': {
      const t = evalExpr(expr.target, env, doc)
      if (t == null || typeof t !== 'object') return null
      return (t as Record<string, unknown>)[expr.field] ?? null
    }
    case 'objectLit': {
      const out: Record<string, unknown> = {}
      for (const { key, value } of expr.entries) {
        out[key] = evalExpr(value, env, doc)
      }
      return out
    }
    case 'arrayLit':
      return expr.items.map((item) => evalExpr(item, env, doc))
    case 'path': {
      const segs = expr.segments.map((s) => resolveSegment(s, env, doc))
      return getPath(doc, segs) ?? null
    }
    case 'merge': {
      const a = evalExpr(expr.left, env, doc)
      const b = evalExpr(expr.right, env, doc)
      return merge(a, b)
    }
    case 'coalesce': {
      const a = evalExpr(expr.left, env, doc)
      return a != null ? a : evalExpr(expr.right, env, doc)
    }
  }
}

function resolveSegment(seg: PathSegment, env: Env, doc: Doc): string {
  if (seg.kind === 'field') return seg.name
  const val = evalExpr(seg.key, env, doc)
  if (typeof val === 'string') return val
  throw new YqError(
    `bracket key must resolve to a string (array indexing and numeric keys not supported), got ${typeof val}`,
  )
}

function merge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    return {
      ...(a as Record<string, unknown>),
      ...(b as Record<string, unknown>),
    }
  }
  // Right wins when types disagree.
  return b
}

function getPath(doc: Doc, segments: string[]): unknown {
  let cur: unknown = doc
  for (const s of segments) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[String(s)]
  }
  return cur
}

function setPath(doc: Doc, segments: string[], value: unknown): Doc {
  if (segments.length === 0) return value
  const [head, ...rest] = segments
  const base =
    doc != null && typeof doc === 'object' && !Array.isArray(doc)
      ? { ...(doc as Record<string, unknown>) }
      : {}
  base[String(head)] = setPath(base[String(head)], rest, value)
  return base
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x ?? null))
}
