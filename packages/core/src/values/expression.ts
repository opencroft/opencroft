// Math Expression's language: a precedence-climbing parser that builds a tree,
// and an evaluator that walks it over fixed operator and function tables.
// Names resolve only against the variables, the constants `pi` and `e` and
// the literals `true` and `false`; there is no member access, no call on a
// value and no assignment, so an expression can reach nothing but numbers and
// true or false. A parsed expression is kept by its text (`cachedParse`), so
// every read of a node's handles, output and checks parses it once.

import { cachedParse } from './parse-cache'

/** The type of an expression's result or of a variable. */
export type ExpressionType = 'number' | 'boolean'

/**
 * The type of a group of variables: fixed by where they stand, or `free`:
 * either type, set by what is connected into them.
 */
export type GroupType = ExpressionType | 'free'

type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '^' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||'

/** A node of an expression's tree. `at` is the 1-based position of the character it starts at. */
export type ExpressionNode =
  | { kind: 'number'; value: number; at: number }
  | { kind: 'boolean'; value: boolean; at: number }
  | { kind: 'name'; name: string; at: number }
  | { kind: 'unary'; operator: '-' | '!'; operand: ExpressionNode; at: number }
  | { kind: 'binary'; operator: BinaryOperator; left: ExpressionNode; right: ExpressionNode; at: number }
  | { kind: 'conditional'; test: ExpressionNode; then: ExpressionNode; otherwise: ExpressionNode; at: number }
  | { kind: 'call'; name: string; args: ExpressionNode[]; at: number }

/** An expression that parsed. */
export interface ParsedExpression {
  tree: ExpressionNode
  /**
   * Its variables, in order of first appearance: every name but `pi`, `e`,
   * `true`, `false` and the functions called.
   */
  variables: string[]
  /**
   * Each variable's type group, named by the first of its variables in order
   * of appearance. Variables that `==` or `!=` compare with each other, or
   * that are the two branches of one `? :`, share one type.
   */
  groups: Record<string, string>
  /**
   * Each group's type, from where its variables stand: a number as an operand
   * of arithmetic or of `< <= > >=`, or an argument of a function; true or
   * false as an operand of `&&`, `||` or `!`, or the condition before `?`;
   * `free` while only `==`, `!=`, `? :` or the whole expression decides it.
   */
  groupTypes: Record<string, GroupType>
  /** The result's type, or the group whose type it has (`c ? x : y`, `a`). */
  type: ExpressionType | { group: string }
}

/** The types of an expression's variables and of its result. */
export interface ExpressionTypes {
  variables: Record<string, ExpressionType>
  result: ExpressionType
}

/** Why an expression does not parse, and the 1-based position of the character at fault. */
export interface ExpressionError {
  /** Says what and where: `Unexpected ")" at 7`. */
  message: string
  position: number
}

export type ParseExpressionResult = { ok: true; expression: ParsedExpression } | { ok: false; error: ExpressionError }

export type EvaluateExpressionResult = { ok: true; value: number | boolean } | { ok: false; error: string }

/** The longest expression parsed, in characters. */
export const MAX_EXPRESSION_LENGTH = 1000
/** How deeply parentheses, operators, conditions and calls may nest. */
const MAX_DEPTH = 64

const CONSTANTS: ReadonlyMap<string, number> = new Map([
  ['pi', Math.PI],
  ['e', Math.E],
])

interface ExpressionFunction {
  /** Fewest and most arguments; `Infinity` for any number. */
  arity: readonly [number, number]
  apply(args: number[]): number | string
}

const unary = (apply: (x: number) => number | string): ExpressionFunction => ({
  arity: [1, 1],
  apply: ([x]) => apply(x),
})

// A string result is the reason the function has no value for those arguments.
const FUNCTIONS: ReadonlyMap<string, ExpressionFunction> = new Map([
  ['abs', unary(Math.abs)],
  ['round', unary(Math.round)],
  ['floor', unary(Math.floor)],
  ['ceil', unary(Math.ceil)],
  ['sqrt', unary((x) => (x < 0 ? 'sqrt of a negative number' : Math.sqrt(x)))],
  ['log', unary((x) => (x <= 0 ? 'log of a number that is not positive' : Math.log(x)))],
  ['exp', unary(Math.exp)],
  ['sin', unary(Math.sin)],
  ['cos', unary(Math.cos)],
  ['tan', unary(Math.tan)],
  ['pow', { arity: [2, 2], apply: ([x, y]) => x ** y }],
  ['clamp', { arity: [3, 3], apply: ([x, lo, hi]) => Math.min(Math.max(x, lo), hi) }],
  ['min', { arity: [1, Number.POSITIVE_INFINITY], apply: (args) => Math.min(...args) }],
  ['max', { arity: [1, Number.POSITIVE_INFINITY], apply: (args) => Math.max(...args) }],
])

// Lowest first. `^` and the unary operators bind tighter than all of these
// and are parsed on their own (see `Parser.unary`).
const BINARY_LEVELS: readonly (readonly BinaryOperator[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
]

const COMPARISONS = new Set<BinaryOperator>(['<', '<=', '>', '>='])
const LOGIC = new Set<BinaryOperator>(['&&', '||'])
const EQUALITY = new Set<BinaryOperator>(['==', '!='])

interface Token {
  kind: 'number' | 'name' | 'operator' | 'end'
  text: string
  /** 1-based. */
  at: number
}

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const NAME = /^[A-Za-z][A-Za-z0-9_]*/
// Longest first, so `<=` is read before `<`.
const OPERATORS = [
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '<',
  '>',
  '!',
  '?',
  ':',
  '(',
  ')',
  ',',
]

class ExpressionSyntaxError extends Error {
  constructor(
    readonly reason: string,
    readonly position: number,
  ) {
    super(`${reason} at ${position}`)
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const rest = source.slice(i)
    const space = /^\s+/.exec(rest)
    if (space) {
      i += space[0].length
      continue
    }
    const number = NUMBER.exec(rest)
    if (number) {
      tokens.push({ kind: 'number', text: number[0], at: i + 1 })
      i += number[0].length
      continue
    }
    const name = NAME.exec(rest)
    if (name) {
      tokens.push({ kind: 'name', text: name[0], at: i + 1 })
      i += name[0].length
      continue
    }
    const operator = OPERATORS.find((op) => rest.startsWith(op))
    if (!operator) {
      throw new ExpressionSyntaxError(`Unexpected "${[...rest][0]}"`, i + 1)
    }
    tokens.push({ kind: 'operator', text: operator, at: i + 1 })
    i += operator.length
  }
  tokens.push({ kind: 'end', text: '', at: source.length + 1 })
  return tokens
}

class Parser {
  private index = 0
  private depth = 0
  readonly variables: string[] = []

  constructor(private readonly tokens: Token[]) {}

  parse(): ExpressionNode {
    const tree = this.conditional()
    const next = this.peek()
    if (next.kind !== 'end') {
      throw unexpected(next)
    }
    return tree
  }

  private peek(): Token {
    return this.tokens[this.index]
  }

  private take(): Token {
    const token = this.tokens[this.index]
    if (token.kind !== 'end') {
      this.index++
    }
    return token
  }

  private takeOperator(...operators: string[]): Token | null {
    const token = this.peek()
    if (token.kind === 'operator' && operators.includes(token.text)) {
      return this.take()
    }
    return null
  }

  private expect(operator: string): void {
    const token = this.peek()
    if (!this.takeOperator(operator)) {
      throw new ExpressionSyntaxError(`Expected "${operator}"${token.kind === 'end' ? ' at the end' : ''}`, token.at)
    }
  }

  private nested<T>(at: number, parse: () => T): T {
    if (++this.depth > MAX_DEPTH) {
      throw new ExpressionSyntaxError(`Nested more than ${MAX_DEPTH} deep`, at)
    }
    try {
      return parse()
    } finally {
      this.depth--
    }
  }

  private conditional(): ExpressionNode {
    const test = this.binary(0)
    const question = this.takeOperator('?')
    if (!question) {
      return test
    }
    return this.nested(question.at, () => {
      const then = this.conditional()
      this.expect(':')
      const otherwise = this.conditional()
      return { kind: 'conditional', test, then, otherwise, at: question.at }
    })
  }

  private binary(level: number): ExpressionNode {
    if (level === BINARY_LEVELS.length) {
      return this.unary()
    }
    let left = this.binary(level + 1)
    for (let op = this.takeOperator(...BINARY_LEVELS[level]); op; op = this.takeOperator(...BINARY_LEVELS[level])) {
      const right = this.binary(level + 1)
      left = { kind: 'binary', operator: op.text as BinaryOperator, left, right, at: op.at }
    }
    return left
  }

  private unary(): ExpressionNode {
    const op = this.takeOperator('-', '!')
    if (op) {
      return this.nested(op.at, () => ({
        kind: 'unary',
        operator: op.text as '-' | '!',
        operand: this.unary(),
        at: op.at,
      }))
    }
    return this.power()
  }

  // Right-associative, and tighter than a unary minus on its left: -2^2 is -4,
  // 2^3^2 is 2^9, and 2^-1 is a half.
  private power(): ExpressionNode {
    const base = this.primary()
    const op = this.takeOperator('^')
    if (!op) {
      return base
    }
    return this.nested(op.at, () => ({ kind: 'binary', operator: '^', left: base, right: this.unary(), at: op.at }))
  }

  private primary(): ExpressionNode {
    const token = this.take()
    if (token.kind === 'number') {
      const value = Number(token.text)
      if (!Number.isFinite(value)) {
        throw new ExpressionSyntaxError('The number is too large', token.at)
      }
      return { kind: 'number', value, at: token.at }
    }
    if (token.kind === 'name') {
      if (this.takeOperator('(')) {
        return this.nested(token.at, () => this.call(token))
      }
      if (token.text === 'true' || token.text === 'false') {
        return { kind: 'boolean', value: token.text === 'true', at: token.at }
      }
      if (!CONSTANTS.has(token.text) && !this.variables.includes(token.text)) {
        this.variables.push(token.text)
      }
      return { kind: 'name', name: token.text, at: token.at }
    }
    if (token.kind === 'operator' && token.text === '(') {
      return this.nested(token.at, () => {
        const inner = this.conditional()
        this.expect(')')
        return inner
      })
    }
    throw unexpected(token)
  }

  private call(name: Token): ExpressionNode {
    const args: ExpressionNode[] = []
    if (!this.takeOperator(')')) {
      do {
        args.push(this.conditional())
      } while (this.takeOperator(','))
      this.expect(')')
    }
    return { kind: 'call', name: name.text, args, at: name.at }
  }
}

function unexpected(token: Token): ExpressionSyntaxError {
  return token.kind === 'end'
    ? new ExpressionSyntaxError('Unexpected end of expression', token.at)
    : new ExpressionSyntaxError(`Unexpected "${token.text}"`, token.at)
}

// Where a node's text starts: an operator's node is placed at the operator.
function startOf(node: ExpressionNode): number {
  switch (node.kind) {
    case 'binary':
      return startOf(node.left)
    case 'conditional':
      return startOf(node.test)
    default:
      return node.at
  }
}

/** What a value of `type` is, in an error: `a number`, `true or false`. */
function kindOf(type: ExpressionType): string {
  return type === 'number' ? 'a number' : 'true or false'
}

// A subexpression's type as inference has it: a type, or the index of a
// variable whose group's type is still free and is the subexpression's too.
type Inferred = ExpressionType | number

// Where a group's type was fixed, for the error of a variable then used as
// the other type: the position, and the variable that stood there, if one did.
interface Fixed {
  type: ExpressionType
  at: number
  name?: string
}

// The types of an expression's nodes, inferred as the tree is read: the
// operators give their operands a type, and `==`, `!=` and `? :` tie the
// types of their two sides, which may be variables of no type yet. Tied
// variables are one group (a union-find over the variables, its root the
// first of them in order of appearance).
//
// A variable used as both types is the error reported: it is thrown at its
// first such use. Any other value of the wrong type for its operator is kept
// and reported only when no variable is, so `a + 1 && a` names the second `a`
// rather than the `&&` between them.
class Inference {
  private readonly parent: number[]
  private readonly fixed = new Map<number, Fixed>()
  private firstError: ExpressionSyntaxError | undefined

  constructor(private readonly variables: readonly string[]) {
    this.parent = variables.map((_, i) => i)
  }

  run(tree: ExpressionNode): Pick<ParsedExpression, 'groups' | 'groupTypes' | 'type'> {
    const top = this.resolve(this.infer(tree))
    if (this.firstError) {
      throw this.firstError
    }
    const groups: Record<string, string> = {}
    const groupTypes: Record<string, GroupType> = {}
    for (const [i, name] of this.variables.entries()) {
      const root = this.root(i)
      groups[name] = this.variables[root]
      groupTypes[this.variables[root]] = this.fixed.get(root)?.type ?? 'free'
    }
    return { groups, groupTypes, type: typeof top === 'number' ? { group: this.variables[top] } : top }
  }

  private root(i: number): number {
    let at = i
    while (this.parent[at] !== at) {
      this.parent[at] = this.parent[this.parent[at]]
      at = this.parent[at]
    }
    return at
  }

  // The type `t` has now, or the root of its group while that is free.
  private resolve(t: Inferred): Inferred {
    if (typeof t === 'string') {
      return t
    }
    const root = this.root(t)
    return this.fixed.get(root)?.type ?? root
  }

  private fail(reason: string, at: number): void {
    this.firstError ??= new ExpressionSyntaxError(reason, at)
  }

  private infer(node: ExpressionNode): Inferred {
    switch (node.kind) {
      case 'number':
        return 'number'
      case 'boolean':
        return 'boolean'
      case 'name':
        return CONSTANTS.has(node.name) ? 'number' : this.variables.indexOf(node.name)
      case 'unary': {
        const type: ExpressionType = node.operator === '-' ? 'number' : 'boolean'
        this.expect(node.operand, type, `"${node.operator}"`, node.at)
        return type
      }
      case 'call':
        for (const arg of node.args) {
          this.expect(arg, 'number', `${node.name}()`, startOf(arg))
        }
        return 'number'
      case 'conditional': {
        this.expect(node.test, 'boolean', 'The condition before "?"', startOf(node.test))
        const then = this.infer(node.then)
        if (!this.tie(node.then, then, node.otherwise, this.infer(node.otherwise))) {
          this.fail('Both sides of ":" need the same type', startOf(node.otherwise))
        }
        return then
      }
      case 'binary': {
        const what = `"${node.operator}"`
        if (EQUALITY.has(node.operator)) {
          if (!this.tie(node.left, this.infer(node.left), node.right, this.infer(node.right))) {
            this.fail(`${what} compares two values of the same type`, node.at)
          }
          return 'boolean'
        }
        const operands: ExpressionType = LOGIC.has(node.operator) ? 'boolean' : 'number'
        this.expect(node.left, operands, what, node.at)
        this.expect(node.right, operands, what, node.at)
        return COMPARISONS.has(node.operator) || LOGIC.has(node.operator) ? 'boolean' : 'number'
      }
    }
  }

  // `operand` is of `type`: its group takes the type while free. Otherwise a
  // variable of the other type is used both ways, and any other operand of
  // the other type is the operator's error (`what`, at `at`).
  private expect(operand: ExpressionNode, type: ExpressionType, what: string, at: number): void {
    const t = this.resolve(this.infer(operand))
    if (typeof t === 'number') {
      this.fix(t, type, operand)
      return
    }
    if (t === type) {
      return
    }
    if (operand.kind === 'name' && !CONSTANTS.has(operand.name)) {
      throw this.usedBothWays(operand, type)
    }
    this.fail(`${what} needs ${type === 'number' ? 'numbers' : 'true or false'}`, at)
  }

  // The two sides of `==`, `!=` or `:` have one type: two free groups become
  // one, a free group takes the other side's type. False for two types.
  private tie(left: ExpressionNode, l: Inferred, right: ExpressionNode, r: Inferred): boolean {
    const a = this.resolve(l)
    const b = this.resolve(r)
    if (typeof a === 'string' && typeof b === 'string') {
      return a === b
    }
    if (typeof a === 'number' && typeof b === 'number') {
      this.parent[Math.max(a, b)] = Math.min(a, b)
      return true
    }
    if (typeof a === 'number') {
      this.fix(a, b as ExpressionType, left)
    } else {
      this.fix(b as number, a, right)
    }
    return true
  }

  private fix(root: number, type: ExpressionType, where: ExpressionNode): void {
    this.fixed.set(root, { type, at: startOf(where), ...(where.kind === 'name' ? { name: where.name } : {}) })
  }

  private usedBothWays(variable: { name: string; at: number }, type: ExpressionType): ExpressionSyntaxError {
    const fixed = this.fixed.get(this.root(this.variables.indexOf(variable.name))) as Fixed
    const subject =
      fixed.name === undefined || fixed.name === variable.name
        ? `"${variable.name}"`
        : `"${variable.name}", which has the type of "${fixed.name}",`
    return new ExpressionSyntaxError(
      `${subject} is used as ${kindOf(fixed.type)} at ${fixed.at} and as ${kindOf(type)}`,
      variable.at,
    )
  }
}

/**
 * The types of `expression`'s variables and of its result, with each free
 * group of the type `free` gives it by the group's name, a number when it
 * gives none.
 */
export function expressionTypes(
  expression: ParsedExpression,
  free: Readonly<Record<string, ExpressionType>> = {},
): ExpressionTypes {
  const groupType = (group: string): ExpressionType => {
    const type = expression.groupTypes[group]
    if (type !== 'free' && type !== undefined) {
      return type
    }
    const given = Object.hasOwn(free, group) ? free[group] : undefined
    return given === 'boolean' ? 'boolean' : 'number'
  }
  const variables = Object.fromEntries(expression.variables.map((name) => [name, groupType(expression.groups[name])]))
  const result = typeof expression.type === 'string' ? expression.type : groupType(expression.type.group)
  return { variables, result }
}

/**
 * Parses an expression of Math Expression's language: numbers (`2`, `0.5`,
 * `1e3`), `pi` and `e`, `true` and `false`, variables (letters, digits and
 * `_`, starting with a letter), `+ - * / % ^`, unary `-`, parentheses,
 * `< <= > >= == !=`, `&& || !`, `cond ? a : b`, and the functions `abs min
 * max round floor ceil sqrt pow clamp log exp sin cos tan`. Each variable's
 * type comes from where it stands (see `ParsedExpression`). A mistake, a
 * value of the wrong type for its operator, or a variable used as both types,
 * is an error naming the position (`Unexpected ")" at 7`). Kept by its text
 * and reused (`cachedParse`): the answer is shared, and not to be changed.
 */
export function parseExpression(source: string): ParseExpressionResult {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    return fail(`Longer than ${MAX_EXPRESSION_LENGTH} characters`, MAX_EXPRESSION_LENGTH + 1)
  }
  return cachedParse(`expression:${source}`, () => parse(source))
}

function parse(source: string): ParseExpressionResult {
  try {
    const parser = new Parser(tokenize(source))
    const tree = parser.parse()
    return { ok: true, expression: { tree, variables: parser.variables, ...new Inference(parser.variables).run(tree) } }
  } catch (err) {
    if (err instanceof ExpressionSyntaxError) {
      return fail(err.reason, err.position)
    }
    throw err
  }
}

function fail(reason: string, position: number): { ok: false; error: ExpressionError } {
  return { ok: false, error: { message: `${reason} at ${position}`, position } }
}

class EvaluationError extends Error {}

/**
 * The value of a parsed expression for the given variables. An error says why
 * it has none: division or `%` by zero, `sqrt` or `log` of a number out of
 * their range, a result that is not a finite number, an unknown function, a
 * function given the wrong number of arguments, or a variable with no value
 * of its type. `free` gives the type of each free group, as
 * `expressionTypes` reads it.
 */
export function evaluateExpression(
  expression: ParsedExpression,
  variables: Readonly<Record<string, number | boolean>>,
  free: Readonly<Record<string, ExpressionType>> = {},
): EvaluateExpressionResult {
  try {
    return { ok: true, value: evaluate(expression.tree, variablesOfType(expression, variables, free)) }
  } catch (err) {
    if (err instanceof EvaluationError) {
      return { ok: false, error: err.message }
    }
    throw err
  }
}

// The variables given a value of the type the expression uses them as; any
// other value is left out, and reads as no value.
function variablesOfType(
  expression: ParsedExpression,
  variables: Readonly<Record<string, number | boolean>>,
  free: Readonly<Record<string, ExpressionType>>,
): Scope {
  const types = expressionTypes(expression, free).variables
  const values = new Map<string, number | boolean>()
  for (const name of expression.variables) {
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined
    if (types[name] === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value)) {
      values.set(name, value as number | boolean)
    }
  }
  return { values, types }
}

interface Scope {
  values: ReadonlyMap<string, number | boolean>
  types: Readonly<Record<string, ExpressionType>>
}

function evaluate(node: ExpressionNode, variables: Scope): number | boolean {
  const num = (n: ExpressionNode) => evaluate(n, variables) as number
  const bool = (n: ExpressionNode) => evaluate(n, variables) as boolean
  switch (node.kind) {
    case 'number':
    case 'boolean':
      return node.value
    case 'name': {
      const constant = CONSTANTS.get(node.name)
      if (constant !== undefined) {
        return constant
      }
      const value = variables.values.get(node.name)
      if (value === undefined) {
        const wanted = variables.types[node.name] === 'boolean' ? 'true or false' : 'number'
        throw new EvaluationError(`No ${wanted} for "${node.name}"`)
      }
      return value
    }
    case 'unary':
      return node.operator === '-' ? finite(-num(node.operand)) : !bool(node.operand)
    case 'conditional':
      return bool(node.test) ? evaluate(node.then, variables) : evaluate(node.otherwise, variables)
    case 'call':
      return callFunction(
        node.name,
        node.args.map((arg) => num(arg)),
      )
    case 'binary':
      return binary(node, variables)
  }
}

function binary(node: Extract<ExpressionNode, { kind: 'binary' }>, variables: Scope): number | boolean {
  const left = () => evaluate(node.left, variables)
  const right = () => evaluate(node.right, variables)
  switch (node.operator) {
    case '&&':
      return (left() as boolean) && (right() as boolean)
    case '||':
      return (left() as boolean) || (right() as boolean)
    case '==':
      return left() === right()
    case '!=':
      return left() !== right()
  }
  const a = left() as number
  const b = right() as number
  switch (node.operator) {
    case '<':
      return a < b
    case '<=':
      return a <= b
    case '>':
      return a > b
    case '>=':
      return a >= b
    case '+':
      return finite(a + b)
    case '-':
      return finite(a - b)
    case '*':
      return finite(a * b)
    case '/':
    case '%':
      if (b === 0) {
        throw new EvaluationError(node.operator === '/' ? 'Division by zero' : 'Remainder of a division by zero')
      }
      return finite(node.operator === '/' ? a / b : a % b)
    case '^':
      return finite(a ** b)
  }
}

function callFunction(name: string, args: number[]): number {
  const fn = FUNCTIONS.get(name)
  if (!fn) {
    throw new EvaluationError(`Unknown function "${name}"`)
  }
  const [least, most] = fn.arity
  if (args.length < least || args.length > most) {
    const count = least === most ? `${least}` : `at least ${least}`
    throw new EvaluationError(`${name}() takes ${count} argument${least === 1 ? '' : 's'}`)
  }
  const result = fn.apply(args)
  if (typeof result === 'string') {
    throw new EvaluationError(`No value: ${result}`)
  }
  return finite(result)
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new EvaluationError('The result is not a finite number')
  }
  return value
}
