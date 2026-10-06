import { SquareDashed } from 'lucide-react'
import { paletteTextClass } from 'ui/components/ui/input/color-palette'
import { iconKey, NamedIcon } from 'ui/components/ui/media/named-icon'
import { cn } from 'cn'

/**
 * The theme colours an icon in documentation can take, in the order a picker
 * offers them; they follow Light and Dark. Any colour of Tailwind's palette,
 * by its hue and shade (`sky-300`), is one too. No colour is the text's own.
 *
 * Each class is listed out in full rather than built from the token: a class
 * name assembled at runtime is one no stylesheet scanner ever sees. The
 * palette's classes are generated for that reason by `ui/styles.css`.
 */
export const MARKDOWN_ICON_COLOR_CHOICES = [
  { id: 'primary', label: 'Primary', className: 'text-primary' },
  { id: 'success', label: 'Success', className: 'text-success' },
  { id: 'warning', label: 'Warning', className: 'text-warning' },
  { id: 'destructive', label: 'Destructive', className: 'text-destructive' },
  { id: 'muted', label: 'Muted', className: 'text-muted-foreground' },
] as const

function colorClass(color: string | undefined): string | undefined {
  return MARKDOWN_ICON_COLOR_CHOICES.find((choice) => choice.id === color)?.className ?? paletteTextClass(color)
}

export interface MarkdownIconProps {
  /** The Lucide icon's kebab-case name (`rocket`, `arrow-right`). */
  name: string
  /**
   * A theme colour's id or a palette colour's (`sky-300`); absent, or neither,
   * is the text's own colour.
   */
  color?: string
  className?: string
}

/**
 * A Lucide icon inside a line of text: the text's own size, sitting on its
 * baseline, coloured by a theme token or a palette colour. It is what
 * `markdown` renders an `:icon[name]{color=…}` directive as.
 *
 * A name Lucide doesn't have is a small dashed square in the muted colour,
 * whatever colour was asked for, with the name in its tooltip -- never an
 * error, and never the raw directive.
 */
export function MarkdownIcon({ name, color, className }: MarkdownIconProps) {
  const box = 'inline-block size-[1.1em] shrink-0 align-[-0.2em]'
  if (!iconKey(name)) {
    return (
      <SquareDashed className={cn(box, 'text-muted-foreground', className)}>
        <title>{`Unknown icon “${name}”`}</title>
      </SquareDashed>
    )
  }
  return <NamedIcon name={name} className={cn(box, colorClass(color), className)} />
}
