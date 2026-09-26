import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'

/**
 * Exact-string replacement shared by remote_edit and the graph's editNodeProperty:
 * enforces the found/unique contract, and uses a function replacer so
 * dollar-prefixed substitution patterns in newString are inserted literally
 * instead of being expanded.
 */
export function replaceExact(
  content: string,
  edit: { oldString: string; newString: string; replaceAll: boolean },
  subject: string,
): string {
  const occurrences = content.split(edit.oldString).length - 1
  if (occurrences === 0) {
    fail(-32602, `oldString not found in ${subject}`)
  }
  if (occurrences > 1 && !edit.replaceAll) {
    fail(-32602, `oldString is not unique (${occurrences} matches). Set replaceAll=true or provide more context.`)
  }
  if (edit.replaceAll) {
    return content.split(edit.oldString).join(edit.newString)
  }
  return content.replace(edit.oldString, () => edit.newString)
}
