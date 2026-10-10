// What a picture handed to a vision model may be, and how big it is worth
// making it — one answer for every path that hands one over: a reader's
// attachment (the composer and the store) and an agent's own look at a remote
// file (remote_view_image).
//
// Pure constants, no I/O, so both the browser and the server import it.

/**
 * The image types a vision model is actually served by the providers we reach,
 * not everything a browser will hand over: an SVG is a script host rather than
 * a picture, and a TIFF is a file no endpoint here accepts.
 */
export const VISION_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export type VisionMimeType = (typeof VISION_MIME_TYPES)[number]

/**
 * The long edge past which a picture is downscaled, in pixels.
 *
 * The providers resize anything past roughly 1568px on its long edge before the
 * model sees it, so sending more is paying to transmit detail that is thrown
 * away at the other end. Some newer models look at more (2576px); this stays at
 * the bound every model we reach honours.
 */
export const VISION_MAX_EDGE = 1568

/**
 * The size past which a picture is re-encoded, in base64 characters.
 *
 * Base64 is one character per byte to within a rounding error, so this is
 * roughly 1.5 MB — well under the 5 MB a provider takes per image.
 */
export const VISION_REENCODE_ABOVE_CHARS = 1_500_000

/**
 * The lossy qualities tried in turn, on a 0–1 scale, when a re-encoded picture
 * is still over `VISION_REENCODE_ABOVE_CHARS`.
 */
export const VISION_QUALITY_STEPS = [0.92, 0.85, 0.75, 0.6] as const
