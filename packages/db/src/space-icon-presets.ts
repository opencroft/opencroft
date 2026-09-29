// The preset space icons, by id. A preset is stored as `preset:<glyph>:<colour>`.
//
// The design kit's Space Icon draws them: there each glyph id names a Lucide
// icon and each colour id a flat colour. These are the same sets as plain ids,
// which is what the schema's column default and the server's checks need --
// neither may load a component to learn which ids exist. An id is never
// removed or reused, so a stored preset stays valid.

export const SPACE_ICON_GLYPH_IDS: readonly string[] = [
  'rocket',
  'orbit',
  'telescope',
  'stars',
  'moon-star',
  'sun',
  'star',
  'earth',
  'globe',
  'compass',
  'binoculars',
  'mountain',
  'flag',
  'atom',
  'flask',
  'microscope',
  'lightbulb',
  'target',
  'briefcase',
  'office',
  'team',
  'chat',
  'calendar',
  'board',
  'checklist',
  'notebook',
  'book',
  'pen',
  'palette',
  'growth',
  'chart',
  'puzzle',
  'layers',
  'package',
  'workflow',
  'code',
  'branch',
  'terminal',
  'server',
  'database',
  'drive',
  'container',
  'cloud',
  'cpu',
  'router',
  'shield',
  'fence',
  'wrench',
]

export const SPACE_ICON_COLOR_IDS: readonly string[] = [
  'red',
  'orange',
  'amber',
  'green',
  'emerald',
  'teal',
  'sky',
  'blue',
  'indigo',
  'violet',
  'pink',
  'slate',
]

const PRESET_PREFIX = 'preset:'

export function spaceIconPresetValue(glyphId: string, colorId: string): string {
  return `${PRESET_PREFIX}${glyphId}:${colorId}`
}

/** A preset drawn at random, glyph and colour independently. */
export function randomSpaceIconValue(random: () => number = Math.random): string {
  const glyph = SPACE_ICON_GLYPH_IDS[Math.floor(random() * SPACE_ICON_GLYPH_IDS.length)]
  const color = SPACE_ICON_COLOR_IDS[Math.floor(random() * SPACE_ICON_COLOR_IDS.length)]
  return spaceIconPresetValue(glyph, color)
}

/** Whether the value names a preset that exists: a known glyph on a known colour. */
export function isSpaceIconPreset(value: string): boolean {
  if (!value.startsWith(PRESET_PREFIX)) {
    return false
  }
  const [glyphId, colorId, ...rest] = value.slice(PRESET_PREFIX.length).split(':')
  return rest.length === 0 && SPACE_ICON_GLYPH_IDS.includes(glyphId) && SPACE_ICON_COLOR_IDS.includes(colorId)
}
