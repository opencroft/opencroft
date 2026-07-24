/** Clamps a fixed-position popover so it doesn't spill past the viewport edge. */
export function clampPosition(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const clamped = { x, y }
  if (x + width > window.innerWidth) {
    clamped.x = window.innerWidth - width - 8
  }
  if (y + height > window.innerHeight) {
    clamped.y = window.innerHeight - height - 8
  }
  return clamped
}
