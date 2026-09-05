import { LayoutGrid } from 'lucide-react'

/**
 * A space's icon: the uploaded image as a rounded square, or the plain
 * LayoutGrid glyph when none is set. Size comes from the caller (`size-*`
 * in className).
 */
export function SpaceIcon({ icon, className = '' }: { icon?: string | null; className?: string }) {
  if (icon) {
    return <img src={icon} alt='' className={`shrink-0 rounded-md object-cover ${className}`} />
  }
  return (
    <span className={`flex shrink-0 items-center justify-center ${className}`}>
      <LayoutGrid className='size-[80%]' />
    </span>
  )
}
