import { createServerFn } from '@tanstack/react-start'
import type { BrandColor } from 'ui/logo'

import { brandColor } from '@/app/_server/brand-color'

// OPEN TO EVERYONE, SIGNED IN OR NOT. The root document reads it for every page,
// the login page included, because the instance has to look like itself
// before anyone signs in. It answers one palette name, which the tab icon
// shows to any visitor anyway.
export const getBrandColor = createServerFn({ method: 'POST', strict: { output: false } }).handler(
  async (): Promise<BrandColor> => brandColor,
)
