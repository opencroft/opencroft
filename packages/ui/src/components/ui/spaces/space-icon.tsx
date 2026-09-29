import {
  AtomIcon,
  BinocularsIcon,
  BookOpenIcon,
  BriefcaseIcon,
  Building2Icon,
  CalendarIcon,
  ChartPieIcon,
  ClipboardListIcon,
  CloudIcon,
  CodeIcon,
  CompassIcon,
  ContainerIcon,
  CpuIcon,
  DatabaseIcon,
  EarthIcon,
  FenceIcon,
  FlagIcon,
  FlaskConicalIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  GlobeIcon,
  HardDriveIcon,
  LayersIcon,
  LayoutGridIcon,
  LightbulbIcon,
  type LucideIcon,
  MessagesSquareIcon,
  MicroscopeIcon,
  MoonStarIcon,
  MountainSnowIcon,
  NotebookPenIcon,
  OrbitIcon,
  PackageIcon,
  PaletteIcon,
  PenToolIcon,
  PuzzleIcon,
  RocketIcon,
  RouterIcon,
  ServerIcon,
  ShieldIcon,
  SquareTerminalIcon,
  StarIcon,
  StarsIcon,
  SunIcon,
  TargetIcon,
  TelescopeIcon,
  TrendingUpIcon,
  UsersIcon,
  WorkflowIcon,
  WrenchIcon,
} from 'lucide-react'

import { cn } from 'cn'

// A preset icon is a glyph on a flat colour, chosen independently, and stored as
// `preset:<glyph>:<colour>`. Ids are stored, so none is ever renamed or reused.

export interface SpaceIconGlyph {
  id: string
  label: string
  Icon: LucideIcon
}

export interface SpaceIconColor {
  id: string
  label: string
  /** A CSS colour; the glyph on it is white. */
  value: string
}

// Exploration, then work, then infrastructure. 48 fills a grid of 6 or 8
// columns without a ragged last row.
//
// The glyphs are the Icon-suffixed Lucide exports: the kit preview resolves
// components by bare name, and a bare Calendar or Container would draw the
// kit's own components of that name instead of the glyph.
export const SPACE_ICON_GLYPHS: SpaceIconGlyph[] = [
  { id: 'rocket', label: 'Rocket', Icon: RocketIcon },
  { id: 'orbit', label: 'Orbit', Icon: OrbitIcon },
  { id: 'telescope', label: 'Telescope', Icon: TelescopeIcon },
  { id: 'stars', label: 'Stars', Icon: StarsIcon },
  { id: 'moon-star', label: 'Moon and star', Icon: MoonStarIcon },
  { id: 'sun', label: 'Sun', Icon: SunIcon },
  { id: 'star', label: 'Star', Icon: StarIcon },
  { id: 'earth', label: 'Earth', Icon: EarthIcon },
  { id: 'globe', label: 'Globe', Icon: GlobeIcon },
  { id: 'compass', label: 'Compass', Icon: CompassIcon },
  { id: 'binoculars', label: 'Binoculars', Icon: BinocularsIcon },
  { id: 'mountain', label: 'Mountain', Icon: MountainSnowIcon },
  { id: 'flag', label: 'Flag', Icon: FlagIcon },
  { id: 'atom', label: 'Atom', Icon: AtomIcon },
  { id: 'flask', label: 'Flask', Icon: FlaskConicalIcon },
  { id: 'microscope', label: 'Microscope', Icon: MicroscopeIcon },
  { id: 'lightbulb', label: 'Lightbulb', Icon: LightbulbIcon },
  { id: 'target', label: 'Target', Icon: TargetIcon },
  { id: 'briefcase', label: 'Briefcase', Icon: BriefcaseIcon },
  { id: 'office', label: 'Office', Icon: Building2Icon },
  { id: 'team', label: 'Team', Icon: UsersIcon },
  { id: 'chat', label: 'Chat', Icon: MessagesSquareIcon },
  { id: 'calendar', label: 'Calendar', Icon: CalendarIcon },
  { id: 'board', label: 'Board', Icon: FolderKanbanIcon },
  { id: 'checklist', label: 'Checklist', Icon: ClipboardListIcon },
  { id: 'notebook', label: 'Notebook', Icon: NotebookPenIcon },
  { id: 'book', label: 'Book', Icon: BookOpenIcon },
  { id: 'pen', label: 'Pen', Icon: PenToolIcon },
  { id: 'palette', label: 'Palette', Icon: PaletteIcon },
  { id: 'growth', label: 'Growth', Icon: TrendingUpIcon },
  { id: 'chart', label: 'Chart', Icon: ChartPieIcon },
  { id: 'puzzle', label: 'Puzzle', Icon: PuzzleIcon },
  { id: 'layers', label: 'Layers', Icon: LayersIcon },
  { id: 'package', label: 'Package', Icon: PackageIcon },
  { id: 'workflow', label: 'Workflow', Icon: WorkflowIcon },
  { id: 'code', label: 'Code', Icon: CodeIcon },
  { id: 'branch', label: 'Branch', Icon: GitBranchIcon },
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminalIcon },
  { id: 'server', label: 'Server', Icon: ServerIcon },
  { id: 'database', label: 'Database', Icon: DatabaseIcon },
  { id: 'drive', label: 'Drive', Icon: HardDriveIcon },
  { id: 'container', label: 'Container', Icon: ContainerIcon },
  { id: 'cloud', label: 'Cloud', Icon: CloudIcon },
  { id: 'cpu', label: 'Processor', Icon: CpuIcon },
  { id: 'router', label: 'Router', Icon: RouterIcon },
  { id: 'shield', label: 'Shield', Icon: ShieldIcon },
  { id: 'fence', label: 'Fence', Icon: FenceIcon },
  { id: 'wrench', label: 'Wrench', Icon: WrenchIcon },
]

// One lightness and chroma for every hue, so no colour is louder than the next
// and white stays legible on all of them; slate is the one neutral.
export const SPACE_ICON_COLORS: SpaceIconColor[] = [
  { id: 'red', label: 'Red', value: 'oklch(0.62 0.17 25)' },
  { id: 'orange', label: 'Orange', value: 'oklch(0.66 0.16 50)' },
  { id: 'amber', label: 'Amber', value: 'oklch(0.7 0.15 75)' },
  { id: 'green', label: 'Green', value: 'oklch(0.63 0.15 145)' },
  { id: 'emerald', label: 'Emerald', value: 'oklch(0.62 0.13 165)' },
  { id: 'teal', label: 'Teal', value: 'oklch(0.62 0.11 190)' },
  { id: 'sky', label: 'Sky', value: 'oklch(0.64 0.13 230)' },
  { id: 'blue', label: 'Blue', value: 'oklch(0.58 0.17 257)' },
  { id: 'indigo', label: 'Indigo', value: 'oklch(0.55 0.18 277)' },
  { id: 'violet', label: 'Violet', value: 'oklch(0.57 0.19 297)' },
  { id: 'pink', label: 'Pink', value: 'oklch(0.63 0.18 350)' },
  { id: 'slate', label: 'Slate', value: 'oklch(0.55 0.03 257)' },
]

const PRESET_PREFIX = 'preset:'

/** The value a space stores for a glyph on a colour. */
export function spaceIconPresetValue(glyphId: string, colorId: string): string {
  return `${PRESET_PREFIX}${glyphId}:${colorId}`
}

/** A random glyph on a random colour, as a stored value. */
export function randomSpaceIconValue(random: () => number = Math.random): string {
  const glyph = SPACE_ICON_GLYPHS[Math.floor(random() * SPACE_ICON_GLYPHS.length)]
  const color = SPACE_ICON_COLORS[Math.floor(random() * SPACE_ICON_COLORS.length)]
  return spaceIconPresetValue(glyph.id, color.id)
}

export interface SpaceIconPreset {
  glyph: SpaceIconGlyph
  color: SpaceIconColor
}

/**
 * The glyph and colour a stored value names, when it names a preset this build
 * knows. An unknown colour falls back to the first one; an unknown glyph is not
 * a preset.
 */
export function findSpaceIconPreset(value: string | undefined): SpaceIconPreset | undefined {
  if (!value?.startsWith(PRESET_PREFIX)) {
    return undefined
  }
  const [glyphId, colorId] = value.slice(PRESET_PREFIX.length).split(':')
  const glyph = SPACE_ICON_GLYPHS.find((g) => g.id === glyphId)
  if (!glyph) {
    return undefined
  }
  const color = SPACE_ICON_COLORS.find((c) => c.id === colorId) ?? SPACE_ICON_COLORS[0]
  return { glyph, color }
}

/** A glyph drawn white on a flat tile of its colour. */
export function SpaceIconTile({ glyph, color, className }: SpaceIconPreset & { className?: string }) {
  const { Icon } = glyph
  return (
    <span
      aria-hidden='true'
      className={cn('flex shrink-0 items-center justify-center rounded-[22%] text-white', className)}
      style={{ backgroundColor: color.value }}
    >
      <Icon className='size-[58%]' strokeWidth={2} />
    </span>
  )
}

/**
 * A space's icon from its stored value: a preset tile or an uploaded image. A
 * preset this build does not know draws a neutral tile rather than a broken
 * image.
 */
export function SpaceIcon({ icon, className }: { icon: string; className?: string }) {
  const preset = findSpaceIconPreset(icon)
  if (preset) {
    return <SpaceIconTile glyph={preset.glyph} color={preset.color} className={className} />
  }
  if (!icon.startsWith(PRESET_PREFIX)) {
    return <img src={icon} alt='' className={cn('shrink-0 rounded-[22%] object-cover', className)} />
  }
  return (
    <span
      aria-hidden='true'
      className={cn('flex shrink-0 items-center justify-center rounded-[22%] bg-muted text-muted-foreground', className)}
    >
      <LayoutGridIcon className='size-[58%]' />
    </span>
  )
}
