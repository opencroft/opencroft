// Graph data carries every node type qualified with the id of the extension
// declaring it: `<extensionId>.<type>`. Core's code declares and dispatches on
// its bare names, so where it reads nodes out of a graph — its own among
// others' — it compares against this form. Free of the client runtime, so the
// server module uses the same definition.

/** One of this extension's bare node types in the form graph data stores it. */
export function storedType(extensionId: string, bare: string): string {
  return `${extensionId}.${bare}`
}
