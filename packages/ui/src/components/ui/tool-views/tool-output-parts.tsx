import type { ToolOutputPart } from 'agent-chat/tool-views'
import { type CSSProperties, createContext, type ReactNode, useContext, useState } from 'react'

// How tall a picture is drawn in a transcript's inline preview, in CSS pixels
// (Tailwind's h-64): the preview is a glimpse, the full view shows it whole.
const PREVIEW_PICTURE_HEIGHT = 256

/**
 * Inside this, pictures are drawn at their own size (never wider than their
 * container) instead of the preview's height. For a view that shows a result
 * in full, such as a dialog opened from its preview.
 */
export const ToolOutputFullSize = createContext(false)

// What a tool returned, part by part, in the order it returned it: its text,
// and the pictures, sounds, files and links between. Every piece whose bytes
// are not there to show -- never kept, or kept and since let go -- is one
// quiet line saying what it was, never a broken picture or a silent gap.
//
// `renderText` draws a text part, so the parts sit in whatever text block the
// surrounding view draws its output in.
export function ToolOutputParts({
  parts,
  renderText,
}: {
  parts: readonly ToolOutputPart[]
  renderText: (text: string) => ReactNode
}) {
  return (
    <div className='flex min-w-0 flex-col gap-1.5'>
      {parts.map((part, index) => (
        // A result is an ordered list of parts with no ids: position is the identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: a part's position is its identity
        <OutputPart key={index} part={part} renderText={renderText} />
      ))}
    </div>
  )
}

function OutputPart({ part, renderText }: { part: ToolOutputPart; renderText: (text: string) => ReactNode }) {
  switch (part.type) {
    case 'text':
      return <>{renderText(part.text)}</>
    case 'image':
    case 'audio':
      return part.src ? (
        <KeptMedia part={{ ...part, src: part.src }} />
      ) : (
        <PartLine>{mediaLine(part, 'not kept')}</PartLine>
      )
    case 'resource_link':
      return <ResourceLink part={part} />
    case 'resource':
      return part.text !== undefined ? (
        <div className='flex min-w-0 flex-col gap-0.5'>
          <PartLine>{part.uri}</PartLine>
          {renderText(part.text)}
        </div>
      ) : (
        <PartLine>{[part.uri, part.mimeType, sizeLabel(part.byteSize), 'not kept'].filter(Boolean).join(', ')}</PartLine>
      )
    case 'terminal':
      return <PartLine>Ran in terminal {part.terminalId}; its output is not shown here</PartLine>
  }
}

type Media = Extract<ToolOutputPart, { type: 'image' | 'audio' }> & { src: string }

// A kept picture or sound, until it fails to load: then its bytes are gone
// (let go after the conversation was compacted or archived) and it is the
// line instead.
//
// A server-rendered picture starts loading before React attaches onError, and
// React does not replay an error that fired before then: the element is left
// broken with no event to come. So a picture is also checked when it is
// mounted, and one already broken (`complete` with no pixels) is the line.
function KeptMedia({ part }: { part: Media }) {
  const [gone, setGone] = useState(false)
  const fullSize = useContext(ToolOutputFullSize)
  if (gone) {
    return <PartLine>{mediaLine(part, 'no longer kept')}</PartLine>
  }
  if (part.type === 'audio') {
    return (
      // biome-ignore lint/a11y/useMediaCaption: a tool's sound comes with no captions to offer
      <audio controls preload='none' src={part.src} onError={() => setGone(true)} className='w-full max-w-sm' />
    )
  }
  return (
    <img
      ref={(img) => {
        if (img?.complete && img.naturalWidth === 0) {
          setGone(true)
        }
      }}
      src={part.src}
      alt={mediaLine(part)}
      width={part.width}
      height={part.height}
      loading='lazy'
      decoding='async'
      onError={() => setGone(true)}
      style={pictureSize(part, fullSize)}
      // self-start: in a column flex box an item is stretched to the box's
      // width, which would frame a narrow picture in a wide empty border.
      className='block h-auto max-w-full self-start rounded-md border object-contain'
    />
  )
}

// The width a picture is drawn at; its height follows from the aspect ratio
// its width and height attributes give, which also reserves its box before it
// loads, so a late picture does not move what is around it. Never enlarged,
// never wider than its container (max-w-full), and in a preview no taller than
// PREVIEW_PICTURE_HEIGHT. A picture of unknown size is drawn at its own size
// within the same bounds, its box unreserved.
function pictureSize(part: Media, fullSize: boolean): CSSProperties {
  if (!part.width || !part.height) {
    return fullSize ? {} : { maxHeight: PREVIEW_PICTURE_HEIGHT }
  }
  if (fullSize) {
    return { width: part.width }
  }
  return { width: Math.min(part.width, Math.round((PREVIEW_PICTURE_HEIGHT * part.width) / part.height)) }
}

function ResourceLink({ part }: { part: Extract<ToolOutputPart, { type: 'resource_link' }> }) {
  const label = part.title || part.name || part.uri
  const facts = [part.mimeType, sizeLabel(part.byteSize)].filter(Boolean).join(', ')
  // Only a web address opens: anything else (a file path on the agent's
  // machine, a scheme a browser would run) is named, not followed.
  const opens = /^https?:\/\//i.test(part.uri)
  return (
    <div className='min-w-0 text-[11px]'>
      {opens ? (
        <a href={part.uri} target='_blank' rel='noreferrer noopener' className='wrap-anywhere text-primary underline'>
          {label}
        </a>
      ) : (
        <span className='wrap-anywhere text-foreground'>{label}</span>
      )}
      {label !== part.uri && <span className='wrap-anywhere text-muted-foreground'> {part.uri}</span>}
      {facts && <span className='text-muted-foreground'> ({facts})</span>}
    </div>
  )
}

function PartLine({ children }: { children: ReactNode }) {
  return <div className='wrap-anywhere text-[11px] text-muted-foreground italic'>{children}</div>
}

// "image/png, 120 KB" and, given, what became of it.
function mediaLine(part: { mimeType: string; byteSize: number }, fate?: string): string {
  return [part.mimeType || 'media', sizeLabel(part.byteSize), fate].filter(Boolean).join(', ')
}

function sizeLabel(bytes: number | undefined): string | undefined {
  if (bytes === undefined) {
    return undefined
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
