import { type BrandColor, DEFAULT_BRAND_COLOR, Logo } from './logo'

// The app icon -- the mark on its own tile, the way a browser tab or a
// bookmark shows it.
//
// IT IS A STANDALONE IMAGE, which is the whole difference from the mark. Served
// as an icon file, it is drawn where no page reaches it: there is no
// surrounding text colour for the outline to inherit and no host variable for
// the accent to read. So everything the mark normally takes from around it is
// stated here -- a dark tile, a light outline, and the brand colour handed to
// the mark outright. Not through the page variable: an image renderer may not
// resolve a variable set on an ancestor, and the accent would fall back to the
// default.
//
// THE MARK IS DRAWN, NOT COPIED. The sibling mark is nested at the tile's
// centre, so the icon has no geometry of its own to drift from the in-app one.

const TILE = 'rgb(15, 15, 46)'
const OUTLINE = '#f0f0ff'

// The tile is 100 units; the mark fills 84 of them, centred.
const TILE_SIZE = 100
const TILE_RADIUS = 22
const MARK_INSET = 8

export interface AppIconProps {
  /** The brand colour of the instance the icon stands for. */
  color?: BrandColor
  /** Rendered edge length in px. */
  size?: number
  /** Fill the square to its edges instead of rounding the tile, for a
   *  platform that masks the icon to its own shape (a home-screen icon, a
   *  maskable app icon). The mark stays where it is: its outer corners sit
   *  inside the central circle such a mask keeps. */
  fullBleed?: boolean
}

export function AppIcon({ color = DEFAULT_BRAND_COLOR, size = TILE_SIZE, fullBleed }: AppIconProps) {
  return (
    <svg xmlns='http://www.w3.org/2000/svg' viewBox={`0 0 ${TILE_SIZE} ${TILE_SIZE}`} width={size} height={size}>
      <rect width={TILE_SIZE} height={TILE_SIZE} rx={fullBleed ? 0 : TILE_RADIUS} fill={TILE} />
      <Logo x={MARK_INSET} y={MARK_INSET} size={TILE_SIZE - 2 * MARK_INSET} color={OUTLINE} accent={color} />
    </svg>
  )
}
