/**
 * How a tool refuses a call: a JSON-RPC error, thrown, which both surfaces turn
 * into the error their caller sees.
 *
 * Its own module, with no imports, because operations reached through a tool
 * without being tool modules themselves (an App's actions) refuse the same way
 * and must not pull the tool registry in to do it.
 */
export function fail(code: number, message: string): never {
  throw { code, message }
}
