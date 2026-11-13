import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateExpression, expressionTypes, MAX_EXPRESSION_LENGTH, parseExpression } from './expression'

function parsed(source: string) {
  const result = parseExpression(source)
  if (!result.ok) {
    assert.fail(`${source} did not parse: ${result.error.message}`)
  }
  return result.expression
}

function value(source: string, variables: Record<string, number | boolean> = {}) {
  const result = evaluateExpression(parsed(source), variables)
  if (!result.ok) {
    assert.fail(`${source} has no value: ${result.error}`)
  }
  return result.value
}

function parseError(source: string): string {
  const result = parseExpression(source)
  assert.equal(result.ok, false, `${source} parsed`)
  return result.ok ? '' : result.error.message
}

function evaluationError(source: string, variables: Record<string, number | boolean> = {}): string {
  const result = evaluateExpression(parsed(source), variables)
  assert.equal(result.ok, false, `${source} has a value`)
  return result.ok ? '' : result.error
}

test('numbers, constants and arithmetic', () => {
  assert.equal(value('2'), 2)
  assert.equal(value('0.5'), 0.5)
  assert.equal(value('.5'), 0.5)
  assert.equal(value('1e3'), 1000)
  assert.equal(value('2.5E-1'), 0.25)
  assert.equal(value('pi'), Math.PI)
  assert.equal(value('e'), Math.E)
  assert.equal(value('7 % 3'), 1)
  assert.equal(value('a * 2 + 1', { a: 3 }), 7)
})

test('precedence and associativity', () => {
  assert.equal(value('2 + 3 * 4'), 14)
  assert.equal(value('(2 + 3) * 4'), 20)
  assert.equal(value('10 - 4 - 3'), 3)
  assert.equal(value('16 / 4 / 2'), 2)
  assert.equal(value('2 ^ 3 ^ 2'), 512)
  assert.equal(value('-2 ^ 2'), -4)
  assert.equal(value('2 ^ -1'), 0.5)
  assert.equal(value('--3'), 3)
  assert.equal(value('1 + 2 < 4 && 3 > 2'), true)
  assert.equal(value('1 < 2 == 3 < 4'), true)
  assert.equal(value('1 > 2 || 2 > 1 && 1 > 2'), false)
})

test('comparisons and logic give booleans, and type the output', () => {
  assert.equal(parsed('a + 1').type, 'number')
  assert.equal(parsed('a < 1').type, 'boolean')
  assert.equal(parsed('!(a < 1)').type, 'boolean')
  assert.equal(parsed('a > 0 ? 1 : 2').type, 'number')
  assert.equal(parsed('a > 0 ? a < 5 : a > 9').type, 'boolean')
  assert.equal(value('3 <= 3'), true)
  assert.equal(value('3 >= 4'), false)
  assert.equal(value('2 != 2'), false)
  assert.equal(value('!(1 < 2)'), false)
  assert.equal(value('x > 0 ? 10 : 20', { x: -1 }), 20)
  assert.equal(value('x > 0 ? 10 : x < -5 ? 30 : 20', { x: -9 }), 30)
})

test('a variable used with &&, || or ! or as a condition is true or false; in arithmetic, a comparison or a function, a number', () => {
  const logic = parsed('a && !b || c > 1')
  assert.deepEqual(logic.groupTypes, { a: 'boolean', b: 'boolean', c: 'number' })
  assert.equal(logic.type, 'boolean')
  assert.deepEqual(parsed('ok ? x : 0').groupTypes, { ok: 'boolean', x: 'number' })
  assert.deepEqual(parsed('abs(n)').groupTypes, { n: 'number' })
  assert.equal(value('a && !b', { a: true, b: false }), true)
  assert.equal(value('a || b', { a: false, b: false }), false)
  assert.equal(value('ok ? x * 2 : 0', { ok: true, x: 4 }), 8)
})

test('true and false are literals, not variables', () => {
  const literal = parsed('a == true')
  assert.deepEqual(literal.variables, ['a'])
  assert.deepEqual(literal.groupTypes, { a: 'boolean' })
  assert.equal(value('true && !false'), true)
  assert.equal(value('a ? false : true', { a: true }), false)
  assert.equal(parsed('true ? 1 : 2').type, 'number')
})

test('variables that == or ? : alone decide are free, and the ones tied together share one group', () => {
  const equal = parsed('a == b')
  assert.deepEqual(equal.groups, { a: 'a', b: 'a' })
  assert.deepEqual(equal.groupTypes, { a: 'free' })
  const choice = parsed('c ? x : y')
  assert.deepEqual(choice.groups, { c: 'c', x: 'x', y: 'x' })
  assert.deepEqual(choice.groupTypes, { c: 'boolean', x: 'free' })
  assert.deepEqual(choice.type, { group: 'x' })
  assert.deepEqual(parsed('a').type, { group: 'a' })
  // A group fixed anywhere is fixed for every variable in it.
  assert.deepEqual(parsed('a == b && b > 1').groupTypes, { a: 'number' })
  assert.deepEqual(parsed('(a == b) == (c == d)').groupTypes, { a: 'free', c: 'free' })
  // Ties found later still join the group named by the first variable.
  assert.deepEqual(parsed('b == c && a == b').groups, { b: 'b', c: 'b', a: 'b' })
})

test('a free group has the type it is given, a number when it is given none', () => {
  const choice = parsed('c ? x : y')
  assert.deepEqual(expressionTypes(choice), { variables: { c: 'boolean', x: 'number', y: 'number' }, result: 'number' })
  assert.deepEqual(expressionTypes(choice, { x: 'boolean' }), {
    variables: { c: 'boolean', x: 'boolean', y: 'boolean' },
    result: 'boolean',
  })
  // A fixed group keeps its type whatever it is given.
  assert.deepEqual(expressionTypes(parsed('a + 1'), { a: 'boolean' }).variables, { a: 'number' })
  assert.equal(evaluateExpression(parsed('a == b'), { a: true, b: true }, { a: 'boolean' }).ok, true)
  assert.deepEqual(evaluateExpression(parsed('c ? x : y'), { c: false, x: true, y: false }, { x: 'boolean' }), {
    ok: true,
    value: false,
  })
})

test('a variable used as both types is a parse error at its second use, naming the first', () => {
  assert.equal(parseError('a + 1 && a'), '"a" is used as a number at 1 and as true or false at 10')
  assert.equal(parseError('a && a > 1'), '"a" is used as true or false at 1 and as a number at 6')
  assert.equal(parseError('x > 0 || x'), '"x" is used as a number at 1 and as true or false at 10')
  assert.equal(parseError('a == 1 && a'), '"a" is used as a number at 1 and as true or false at 11')
  assert.equal(
    parseError('a == b && a > 1 && b'),
    '"b", which has the type of "a", is used as a number at 11 and as true or false at 20',
  )
})

test('a variable given a value of the other type has no value', () => {
  assert.equal(evaluationError('a && b', { a: 1, b: true }), 'No true or false for "a"')
  assert.equal(evaluationError('x + 1', { x: true }), 'No number for "x"')
  assert.equal(evaluationError('a == b', { a: true, b: true }), 'No number for "a"')
})

test('an expression is parsed once per distinct text', () => {
  assert.equal(parseExpression('a * 2 == b'), parseExpression('a * 2 == b'))
  assert.notEqual(parseExpression('a * 2 == b'), parseExpression('a * 3 == b'))
})

test('functions', () => {
  assert.equal(value('abs(-2)'), 2)
  assert.equal(value('min(3, 1, 2)'), 1)
  assert.equal(value('max(3, 1, 2)'), 3)
  assert.equal(value('round(2.5)'), 3)
  assert.equal(value('floor(2.7)'), 2)
  assert.equal(value('ceil(2.1)'), 3)
  assert.equal(value('sqrt(9)'), 3)
  assert.equal(value('pow(2, 10)'), 1024)
  assert.equal(value('clamp(15, 0, 10)'), 10)
  assert.equal(value('clamp(-1, 0, 10)'), 0)
  assert.equal(value('log(e)'), 1)
  assert.equal(value('exp(0)'), 1)
  assert.equal(value('sin(0) + cos(0) + tan(0)'), 1)
})

test('variables are listed in order of first appearance, without constants or functions', () => {
  assert.deepEqual(parsed('b * a + b - pi + e + sqrt(c)').variables, ['b', 'a', 'c'])
  assert.deepEqual(parsed('x_1 + Y2').variables, ['x_1', 'Y2'])
  assert.deepEqual(parsed('2 + 2').variables, [])
})

test('a parse error names what is wrong and its 1-based position', () => {
  assert.equal(parseError('(a + b))'), 'Unexpected ")" at 8')
  assert.equal(parseError('1 +'), 'Unexpected end of expression at 4')
  assert.equal(parseError('(1 + 2'), 'Expected ")" at the end at 7')
  assert.equal(parseError('1 $ 2'), 'Unexpected "$" at 3')
  assert.equal(parseError('a ? 1'), 'Expected ":" at the end at 6')
  assert.equal(parseError(''), 'Unexpected end of expression at 1')
  const result = parseExpression('(a + b))')
  assert.equal(result.ok ? 0 : result.error.position, 8)
})

test('a value of the wrong type for its operator is a parse error', () => {
  assert.equal(parseError('1 + (2 < 3)'), '"+" needs numbers at 3')
  assert.equal(parseError('1 && 2'), '"&&" needs true or false at 3')
  assert.equal(parseError('!1'), '"!" needs true or false at 1')
  assert.equal(parseError('1 ? 2 : 3'), 'The condition before "?" needs true or false at 1')
  assert.equal(parseError('a > 1 ? 2 : 1 < 2'), 'Both sides of ":" need the same type at 13')
  assert.equal(parseError('1 == (1 < 2)'), '"==" compares two values of the same type at 3')
  assert.equal(parseError('abs(1 < 2)'), 'abs() needs numbers at 5')
  assert.equal(parseError('1 < 2 < 3'), '"<" needs numbers at 7')
  assert.equal(parseError('true + 1'), '"+" needs numbers at 6')
  assert.equal(parseError('a + 1 == true'), '"==" compares two values of the same type at 7')
  assert.equal(parseError('c ? x + 1 : x > 1'), 'Both sides of ":" need the same type at 13')
})

test('evaluation errors', () => {
  assert.equal(evaluationError('1 / 0'), 'Division by zero')
  assert.equal(evaluationError('a / b', { a: 1, b: 0 }), 'Division by zero')
  assert.equal(evaluationError('5 % 0'), 'Remainder of a division by zero')
  assert.equal(evaluationError('sqrt(-1)'), 'No value: sqrt of a negative number')
  assert.equal(evaluationError('log(0)'), 'No value: log of a number that is not positive')
  assert.equal(evaluationError('10 ^ 400'), 'The result is not a finite number')
  assert.equal(evaluationError('exp(1000)'), 'The result is not a finite number')
  assert.equal(evaluationError('foo(1)'), 'Unknown function "foo"')
  assert.equal(evaluationError('abs(1, 2)'), 'abs() takes 1 argument')
  assert.equal(evaluationError('pow(1)'), 'pow() takes 2 arguments')
  assert.equal(evaluationError('min()'), 'min() takes at least 1 argument')
  assert.equal(evaluationError('a + 1'), 'No number for "a"')
})

test('only the branch a condition picks is evaluated', () => {
  assert.equal(value('a == 0 ? 0 : 1 / a', { a: 0 }), 0)
  assert.equal(value('a != 0 && 1 / a > 0', { a: 0 }), false)
  assert.equal(value('a == 0 || 1 / a > 0', { a: 0 }), true)
  assert.equal(value('b != 0 && a / b > 1', { a: 4, b: 0 }), false)
})

test('hostile input reaches nothing but numbers', () => {
  // Names are variables, read only as the caller's own numbers.
  assert.equal(evaluationError('constructor'), 'No number for "constructor"')
  assert.equal(evaluationError('toString + 1'), 'No number for "toString"')
  assert.equal(value('constructor * 2', { constructor: 4 }), 8)
  // A variable inherited by the variables object is not one of its values.
  const inherited = Object.create({ a: 5 }) as Record<string, number>
  assert.equal(evaluateExpression(parsed('a'), inherited).ok, false)
  // Only the fixed functions are called.
  assert.equal(evaluationError('constructor(1)'), 'Unknown function "constructor"')
  assert.equal(evaluationError('hasOwnProperty(1)'), 'Unknown function "hasOwnProperty"')
  assert.equal(evaluationError('valueOf(1)'), 'Unknown function "valueOf"')
  // No member access, no names starting with an underscore, no strings, no assignment.
  assert.equal(parseError('a.constructor'), 'Unexpected "." at 2')
  assert.equal(parseError('__proto__'), 'Unexpected "_" at 1')
  assert.equal(parseError('"a"'), 'Unexpected """ at 1')
  assert.equal(parseError('a = 1'), 'Unexpected "=" at 3')
  assert.equal(parseError('abs(1)(2)'), 'Unexpected "(" at 7')
  assert.equal(parseError('[1]'), 'Unexpected "[" at 1')
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('deep nesting is refused instead of exhausting the stack', () => {
  const deep = `${'('.repeat(65)}1${')'.repeat(65)}`
  assert.match(parseError(deep), /^Nested more than 64 deep at \d+$/)
  assert.equal(value(`${'('.repeat(60)}1${')'.repeat(60)}`), 1)
  assert.match(parseError(`${'-'.repeat(200)}1`), /^Nested more than 64 deep/)
  assert.match(parseError(`${'abs('.repeat(100)}1${')'.repeat(100)}`), /^Nested more than 64 deep/)
})

test('a long expression is refused; one at the limit evaluates', () => {
  const long = '1+'.repeat(5000).concat('1')
  assert.equal(long.length > MAX_EXPRESSION_LENGTH, true)
  assert.equal(parseError(long), `Longer than ${MAX_EXPRESSION_LENGTH} characters at ${MAX_EXPRESSION_LENGTH + 1}`)
  const atLimit = '1+'.repeat(MAX_EXPRESSION_LENGTH / 2 - 1).concat('10')
  assert.equal(atLimit.length, MAX_EXPRESSION_LENGTH)
  assert.equal(value(atLimit), MAX_EXPRESSION_LENGTH / 2 - 1 + 10)
})
