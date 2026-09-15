// The context-window field on the agent node's Inspector -> Profile tab is NOT
// behind the native-harness gate.
//
// WHICH COPY THIS PROTECTS. There are two fields writing the same
// `contextWindow`, and they are guarded by different things:
//
//   - `AgentPresetForm` (packages/agent-chat) -- guarded by
//     preset-form-context-window.test.tsx, which RENDERS it. That component is
//     mounted nowhere in the live app.
//   - this one, in the agent node's Profile tab -- the one a person actually
//     reaches, and until this file, guarded by nothing at all.
//
// That asymmetry is what an earlier bug was: a change ungated the unmounted copy
// and read as done through review, merge and closeout, because the reachable
// copy was never the one anyone checked.
//
// WHY SOURCE RATHER THAN A RENDER. Components in an extension `src` tree take
// React and every UI primitive from `@opencroft/client`'s `legacy`, which is
// TYPE DECLARATIONS ONLY -- the runtime is injected by the host. So nothing in
// this repository can render this file, and a rendering guard for it cannot be
// written today. Reading the source is the accepted ceiling for
// extension components here; that trade-off was considered and accepted.
//
// WHY THE PARSER AND NOT A PATTERN. The distinction being asserted is exactly
// the one a regular expression is worst at: whether the element sits INSIDE a
// conditional, not whether the words appear near each other. `isNative` and
// `<ContextWindowField/>` are a few lines apart in the correct code and a few
// lines apart in the broken code; only the tree tells them apart.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(here, 'agent.tsx')

const source = ts.createSourceFile(
  AGENT,
  readFileSync(AGENT, 'utf-8'),
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TSX,
)

/** Every place `<Name ... />` or `<Name ...>` is RENDERED (not declared). */
function renderSitesOf(name: string): ts.Node[] {
  const sites: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === name
    ) {
      sites.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

/**
 * Every condition that decides whether this element renders, up to the
 * component that owns it -- `cond ? <X/> : null`, `cond && <X/>`, an enclosing
 * `if`, and the early-return guards standing before it.
 *
 * Empty means the element renders unconditionally wherever its component does.
 *
 * THE WALK IS TRANSPARENT THROUGH ARROWS AND FUNCTION EXPRESSIONS, and stops
 * only at the named FunctionDeclaration -- the component boundary. A gate
 * outside the component is a statement about the component rather than about
 * this field, so that boundary stays; but a local closure is not a boundary, it
 * is a hiding place. Stopping at every function let this through green
 * (as found in review):
 *
 *   const renderContextWindow = () => {
 *     if (!isNative) { return null }
 *     return <ContextWindowField ... />
 *   }
 *   ...
 *   {renderContextWindow()}
 *
 * Two blind spots composed there: the walk halted at the arrow, and it never
 * read `if` at all. Note what the control could NOT do about it -- the
 * legitimate gate is written `cond ? ... : null`, so the control certifies the
 * walk on conditional expressions, not the walk. A control can only vouch for
 * the shapes it exercises.
 *
 * THE RESIDUAL, stated rather than left to be discovered: a field handed out
 * through a callback prop that escapes the component is beyond any parent walk,
 * because the deciding condition is then in someone else's file. Nothing here
 * covers that shape. What stands against it is the position assertion below --
 * the field must be rendered by the same component that renders the gate, which
 * a field that has left the component no longer is.
 */
function gatesAbove(node: ts.Node): string[] {
  const gates: string[] = []
  let child: ts.Node = node
  for (let cur: ts.Node | undefined = node.parent; cur && !ts.isFunctionDeclaration(cur); cur = cur.parent) {
    if (ts.isConditionalExpression(cur)) {
      gates.push(cur.condition.getText(source))
    } else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      gates.push(cur.left.getText(source))
    } else if (ts.isIfStatement(cur)) {
      gates.push(cur.expression.getText(source))
    } else if (ts.isBlock(cur)) {
      gates.push(...guardsBefore(cur, child))
    }
    child = cur
  }
  return gates
}

/**
 * The conditions of the early-return guards standing before `statement` in
 * `block`.
 *
 * These are the element's SIBLINGS, not its ancestors, so the walk above cannot
 * reach them -- and `if (!isNative) return null` above a return is the ordinary
 * way a gate is written once the markup moves into a helper.
 *
 * Only guards that RETURN count. An `if` that does something else and falls
 * through does not decide whether the element renders, and counting it would
 * report a gate that is not one.
 */
function guardsBefore(block: ts.Block, statement: ts.Node): string[] {
  const gates: string[] = []
  for (const candidate of block.statements) {
    if (candidate === statement) {
      break
    }
    if (ts.isIfStatement(candidate) && returnsOutright(candidate.thenStatement)) {
      gates.push(candidate.expression.getText(source))
    }
  }
  return gates
}

function returnsOutright(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) {
    return true
  }
  return ts.isBlock(statement) && statement.statements.some((inner) => ts.isReturnStatement(inner))
}

/** The name of the function whose body renders this element. */
function enclosingFunctionOf(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) {
      return cur.name.text
    }
  }
  return '<none>'
}

const NATIVE_GATE = /isNative|kind === 'native'|kind === "native"/

// The control, and it comes first because every assertion below is an ABSENCE.
// `gatesAbove` returning nothing has two causes -- the element is ungated, or
// the walk does not work -- and they read identically. NativeProfileFields is
// legitimately gated on the same condition in the same component, so the same
// walk must find it. If this fails, the tests under it are worthless rather
// than passing.
test('CONTROL: the walk finds the native-harness gate where one legitimately is', () => {
  const sites = renderSitesOf('NativeProfileFields')
  assert.equal(sites.length, 1, 'expected exactly one render of NativeProfileFields')

  const gates = gatesAbove(sites[0])
  assert.ok(gates.length > 0, 'the walk found no gate above a field set that is gated')
  assert.ok(
    gates.some((gate) => NATIVE_GATE.test(gate)),
    `expected a native-harness gate, saw: ${JSON.stringify(gates)}`,
  )
})

test('the context window field is not behind the native-harness gate', () => {
  const sites = renderSitesOf('ContextWindowField')
  assert.equal(sites.length, 1, 'expected exactly one render of ContextWindowField')

  const gates = gatesAbove(sites[0])
  assert.deepEqual(
    gates.filter((gate) => NATIVE_GATE.test(gate)),
    [],
    'the context window field is gated to the native harness again -- a bridged session cannot then set the one window it has',
  )
})

// The other way the gate comes back: not a condition around the field, but the
// field moved back INSIDE the field set that is itself gated. No conditional is
// added anywhere, and `gatesAbove` stops at the function boundary, so the test
// above would still pass.
//
// Asserted as "the same component renders both" rather than against a function
// name, so renaming the component does not fail this and moving the field does.
test('the context window field sits beside the native-only field set, not inside it', () => {
  const field = renderSitesOf('ContextWindowField')[0]
  const nativeSet = renderSitesOf('NativeProfileFields')[0]

  assert.equal(
    enclosingFunctionOf(field),
    enclosingFunctionOf(nativeSet),
    'the context window field is no longer rendered by the component that renders the gate -- if it moved inside the native-only fields, it is gated again by position rather than by a condition',
  )
})
