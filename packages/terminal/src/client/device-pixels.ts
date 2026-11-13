/**
 * Whether the browser's two measures of device pixels agree, which xterm's WebGL renderer needs.
 *
 * The renderer lays its frame out in device pixels from `devicePixelRatio`, and sizes its canvas's
 * backing store from a ResizeObserver's `devicePixelContentBoxSize`. When the two disagree, frame and
 * canvas differ in size, and the GL viewport, anchored at the bottom left, shows only part of the
 * frame. Headless Chromium under Playwright's `deviceScaleFactor` emulation reports a ratio of 2 with
 * the device-pixel box at its CSS size: only the lower-left quarter of the frame reaches the screen,
 * and output in the top rows, such as a short log, draws as a blank pane. The DOM renderer reads
 * neither measure, so it is the one to use there.
 */

// Snapping each edge of a box to the device-pixel grid moves its device width by up to a pixel.
const SNAP_TOLERANCE_PX = 2

/**
 * `cssWidth` and `deviceWidth` are one box's content width in CSS and in device pixels. With nothing to
 * compare (no device-pixel box in this browser, or a box with no width) they count as agreeing: the
 * renderer then keeps the size it computes from the ratio, which is right.
 */
export function devicePixelsAgree(cssWidth: number, deviceWidth: number | undefined, ratio: number): boolean {
  if (deviceWidth === undefined || cssWidth <= 0) {
    return true
  }
  return Math.abs(deviceWidth - cssWidth * ratio) <= SNAP_TOLERANCE_PX
}

/**
 * Measure `el` once and answer `devicePixelsAgree` for it. Browser only. The answer comes with the
 * observer's first report, which waits until `el` has a size.
 */
export function measureDevicePixels(el: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const observer = new ResizeObserver((entries) => {
        observer.disconnect()
        const entry = entries[0]
        resolve(
          devicePixelsAgree(
            entry?.contentBoxSize?.[0]?.inlineSize ?? 0,
            entry?.devicePixelContentBoxSize?.[0]?.inlineSize,
            window.devicePixelRatio,
          ),
        )
      })
      observer.observe(el, { box: 'device-pixel-content-box' })
    } catch {
      // A browser that cannot observe the device-pixel box: the renderer cannot read it either.
      resolve(true)
    }
  })
}
