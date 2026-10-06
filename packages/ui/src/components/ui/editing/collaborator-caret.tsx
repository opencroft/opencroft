import { cn } from 'cn'
import { useId } from 'react'

import { PALETTE_HUES, type PaletteHue } from 'ui/components/ui/input/color-palette'

/** The hues collaborators are drawn in: the palette's colours, without its greys. */
const COLLABORATOR_HUES = PALETTE_HUES.filter(
  (hue) => !['slate', 'gray', 'zinc', 'neutral', 'stone'].includes(hue),
)

/** The hue a collaborator is drawn in, picked from their id so it is the same on every screen. */
export function hueFor(id: string): PaletteHue {
  let hash = 0
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return COLLABORATOR_HUES[hash % COLLABORATOR_HUES.length]
}

/** `value` as a collaborator's hue, or undefined when it is none: a hue from another client is not trusted. */
export function collaboratorHue(value: unknown): PaletteHue | undefined {
  return PALETTE_HUES.find((hue) => hue === value)
}

// The caret is a zero-width inline box whose left border is the line; the tag
// sits above it, filled with the caret's own colour, its text white.
const CARET = 'pointer-events-none relative -mx-px border-l-2 border-current'
// The tag is tethered to its caret rather than laid out in the text around it.
// Text sits in boxes that scroll -- a table, the editor itself -- and a tag
// laid out inside one is cut off at its edge or widens what it scrolls, so a
// tag near a table's edge would give the table a scrollbar. Tethered, it is
// in neither box: it follows the caret as the text scrolls, and it is hidden
// while its caret is scrolled out of sight. It behaves like the line it
// labels: laid out against an editor's text area (one with layout
// containment), it goes under the editor's toolbar together with its caret,
// and drops below the caret where the text area has no room above it -- the
// first line -- or turns left at its right edge. It is drawn above the text
// and below anything stacked above the text. A browser without anchor
// positioning lays it out in the text.
const TAG = cn(
  'absolute bottom-full left-0 z-1 -ml-0.5 mb-0.5 select-none whitespace-nowrap rounded-sm bg-current px-1 py-px text-[0.7rem] font-medium leading-tight',
  'supports-[anchor-name:--a]:fixed supports-[anchor-name:--a]:bottom-[anchor(top)] supports-[anchor-name:--a]:left-[anchor(left)]',
  'supports-[anchor-name:--a]:[position-try-fallbacks:flip-block,flip-inline,flip-block_flip-inline] supports-[anchor-name:--a]:[position-visibility:anchors-visible]',
)
// A tag with no caret of its own marks a block. Where there is no room above
// the block -- the first block of a text -- it stands just inside the block's
// top edge rather than below the whole block. It has nothing to be laid out
// beside, so a browser without anchor positioning does not draw it.
const LONE_TAG =
  'pointer-events-none not-supports-[anchor-name:--a]:hidden supports-[anchor-name:--a]:[position-try-fallbacks:--collaborator-tag-inside]'
const TRY_RULES = '@position-try --collaborator-tag-inside { top: anchor(top); bottom: auto; margin: 2px 0 0 2px }'

/** Adds the lone tag's fallback position to the page, once; it can only be declared in a stylesheet. */
function ensureTryRules(): void {
  if (typeof document === 'undefined' || document.getElementById('collaborator-caret-try')) {
    return
  }
  const style = document.createElement('style')
  style.id = 'collaborator-caret-try'
  style.textContent = TRY_RULES
  document.head.append(style)
}
const TAG_TEXT = 'text-white'

function caretColor(hue: PaletteHue): string {
  return `text-${hue}-500`
}

let anchors = 0

/** A name no other caret on the page has, for the tag to find its own caret by. */
function anchorName(): string {
  anchors += 1
  return `--collaborator-caret-${anchors}`
}

export interface CollaboratorCaretProps {
  /** Who this is: shown on the tag. */
  name: string
  /** Their colour; see `hueFor`. */
  hue: PaletteHue
  className?: string
}

/** Someone else's caret in a line of text, with their name above it. */
export function CollaboratorCaret({ name, hue, className }: CollaboratorCaretProps) {
  // React's id, which a server render and the page it hydrates agree on, made
  // an identifier; letters keep it apart from the elements' numbered names.
  const anchor = `--collaborator-caret-${useId().replace(/[^\w-]/g, '')}`
  return (
    <span className={cn(CARET, caretColor(hue), className)} style={{ anchorName: anchor }}>
      <span className={TAG} style={{ positionAnchor: anchor }}>
        <span className={TAG_TEXT}>{name}</span>
      </span>
    </span>
  )
}

function tagElement(name: string, anchor: string, className?: string): HTMLElement {
  const tag = document.createElement('span')
  tag.className = cn(TAG, className)
  tag.style.setProperty('position-anchor', anchor)
  const text = document.createElement('span')
  text.className = TAG_TEXT
  text.textContent = name
  tag.append(text)
  return tag
}

/** The same caret as a DOM element, for an editor that places elements at positions in its text. */
export function collaboratorCaretElement(name: string, hue: PaletteHue): HTMLElement {
  const anchor = anchorName()
  const caret = document.createElement('span')
  caret.className = cn(CARET, caretColor(hue))
  caret.style.setProperty('anchor-name', anchor)
  caret.append(tagElement(name, anchor))
  return caret
}

/**
 * The tag alone, for someone in a block's own controls -- its title, say --
 * rather than in its text: it stands on the top edge of the element whose
 * `anchor-name` is `anchor`. Put it outside the document, beside the editor:
 * an element among the blocks changes how they are laid out, while the marked
 * block only takes a name. Not drawn in a browser without anchor positioning.
 */
export function collaboratorTagElement(name: string, hue: PaletteHue, anchor: string): HTMLElement {
  ensureTryRules()
  return tagElement(name, anchor, cn(LONE_TAG, caretColor(hue)))
}

/** The inline style of a collaborator's selection: their colour, faint, behind the text. */
export function collaboratorSelectionStyle(hue: PaletteHue): string {
  return `background-color: color-mix(in oklab, var(--color-${hue}-500) 25%, transparent)`
}
