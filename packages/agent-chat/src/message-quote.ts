// Text quoted from a message into the composer, as markdown.
//
// Every line of the quoted text gets `> `; an empty line becomes a bare `>`,
// so a paragraph break inside the quotation stays inside it instead of ending
// it. Line breaks around the text are dropped first: a selection that ran to
// the end of a paragraph carries its break, and a quotation that opened or
// closed on an empty `>` line would read as a stray mark.
export function quoteMarkdown(text: string): string {
  return text
    .replace(/^(\s*\n)+|(\n\s*)+$/g, '')
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}

// The composer's text after replying with `text`: whatever was already written,
// then one empty line, then the quotation, then one empty line that ends it --
// so the caret, placed at the end, sits on a fresh line outside the quote.
//
// What was written is kept as it was apart from trailing whitespace, which is
// what lets the gap before the quotation always be exactly one empty line. A
// composer holding only whitespace counts as empty.
export function appendQuotedReply(current: string, text: string): string {
  const quote = quoteMarkdown(text)
  const before = current.trimEnd()
  return before ? `${before}\n\n${quote}\n\n` : `${quote}\n\n`
}
