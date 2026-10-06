/**
 * Pictures written into markdown as `data:` URLs: which ones may render, and
 * how large they are, read from the bytes already in the text rather than by
 * decoding the picture.
 *
 * The size is what lets such a picture take its final box before it paints.
 * A remote picture has to be guessed at; this one has its header right here.
 */

/** Past this many decoded bytes a `data:` picture is not drawn. */
export const DATA_IMAGE_MAX_BYTES = 8 * 1024 * 1024

// Raster formats only, and base64 only. SVG is a document that can carry
// script, so it never renders from a data URL.
const DATA_IMAGE = /^data:image\/(?:png|gif|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/

export interface DataImageSize {
  width: number
  height: number
}

export interface DataImage {
  /** The picture's size in bytes, decoded. */
  bytes: number
  /**
   * Its size in pixels as a browser draws it, or null where the header does
   * not say: a format it does not recognise, or a header cut short. Null too
   * past `DATA_IMAGE_MAX_BYTES`, where nothing is drawn.
   */
  size: DataImageSize | null
}

/** Whether a URL is a `data:` picture that may render as an image source. */
export function isDataImage(url: string): boolean {
  return DATA_IMAGE.test(url)
}

/** The picture a `data:` URL carries, or null for anything `isDataImage` refuses. */
export function readDataImage(url: string): DataImage | null {
  const payload = DATA_IMAGE.exec(url)?.[1]
  if (payload === undefined) {
    return null
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  const bytes = Math.floor(((payload.length - padding) * 3) / 4)
  return { bytes, size: bytes > DATA_IMAGE_MAX_BYTES ? null : headerSize(decodeHead(payload)) }
}

// Enough of the file to reach the size in all four formats. A JPEG whose
// metadata runs past it -- a large embedded thumbnail -- gets no size.
const HEAD_BASE64_CHARS = 4 * Math.ceil((128 * 1024) / 3)

function decodeHead(payload: string): Uint8Array {
  try {
    return Uint8Array.from(atob(payload.slice(0, HEAD_BASE64_CHARS)), (char) => char.charCodeAt(0))
  } catch {
    return new Uint8Array(0)
  }
}

function headerSize(bytes: Uint8Array): DataImageSize | null {
  const size = pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes)
  return size && size.width > 0 && size.height > 0 ? size : null
}

function hasAscii(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) {
      return false
    }
  }
  return true
}

const u16be = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1]
const u16le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8)
const u24le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
const u32be = (bytes: Uint8Array, at: number) => bytes[at] * 0x1000000 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3])
const u32le = (bytes: Uint8Array, at: number) => bytes[at + 3] * 0x1000000 + ((bytes[at + 2] << 16) | (bytes[at + 1] << 8) | bytes[at])

// The signature, then the IHDR chunk, which the format requires to come first.
function pngSize(bytes: Uint8Array): DataImageSize | null {
  if (bytes.length < 24 || !hasAscii(bytes, 0, '\x89PNG\r\n\x1a\n') || !hasAscii(bytes, 12, 'IHDR')) {
    return null
  }
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

// The logical screen every frame is drawn in.
function gifSize(bytes: Uint8Array): DataImageSize | null {
  if (bytes.length < 10 || !(hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a'))) {
    return null
  }
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) }
}

// The first chunk says which of the three encodings follows, and each keeps
// its size in its own place.
function webpSize(bytes: Uint8Array): DataImageSize | null {
  if (bytes.length < 16 || !hasAscii(bytes, 0, 'RIFF') || !hasAscii(bytes, 8, 'WEBP')) {
    return null
  }
  if (hasAscii(bytes, 12, 'VP8 ')) {
    // Lossy: a key frame's start code, then 14-bit sizes beside a scale.
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null
    }
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
  }
  if (hasAscii(bytes, 12, 'VP8L')) {
    // Lossless: a signature byte, then two 14-bit fields, each one less than the size.
    if (bytes.length < 25 || bytes[20] !== 0x2f) {
      return null
    }
    return {
      width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
      height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)),
    }
  }
  if (hasAscii(bytes, 12, 'VP8X') && bytes.length >= 30) {
    // Extended: the canvas, as two 24-bit fields each one less than the size.
    return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) }
  }
  return null
}

// Start-of-frame markers, which carry the size: C0 to CF, less the three that
// share the range and mean something else (DHT, JPG, DAC).
function isJpegFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

// The segments before the frame, walked by their lengths. A browser turns a
// photo by its EXIF orientation, so a quarter turn there swaps the axes.
function jpegSize(bytes: Uint8Array): DataImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null
  }
  let turned: boolean | null = null
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return null
    }
    const marker = bytes[at + 1]
    if (marker === 0xff) {
      at += 1
      continue
    }
    // The image or its data started with no frame before it.
    if (marker === 0xd9 || marker === 0xda) {
      return null
    }
    // Markers that stand alone, with no length after them.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    const length = u16be(bytes, at + 2)
    if (isJpegFrame(marker)) {
      if (at + 9 > bytes.length) {
        return null
      }
      const height = u16be(bytes, at + 5)
      const width = u16be(bytes, at + 7)
      return turned ? { width: height, height: width } : { width, height }
    }
    if (marker === 0xe1 && turned === null) {
      turned = exifTurnsQuarter(bytes.subarray(at + 4, at + 2 + length))
    }
    at += 2 + length
  }
  return null
}

// EXIF orientations 5 to 8 are the ones with a quarter turn in them. Read from
// the first directory, in whichever byte order the block declares.
function exifTurnsQuarter(segment: Uint8Array): boolean | null {
  if (segment.length < 14 || !hasAscii(segment, 0, 'Exif\0\0')) {
    return null
  }
  const tiff = segment.subarray(6)
  const little = hasAscii(tiff, 0, 'II')
  if (!little && !hasAscii(tiff, 0, 'MM')) {
    return null
  }
  const u16 = (at: number) => (little ? u16le(tiff, at) : u16be(tiff, at))
  const directory = little ? u32le(tiff, 4) : u32be(tiff, 4)
  if (directory + 2 > tiff.length) {
    return null
  }
  const count = u16(directory)
  for (let entry = directory + 2; entry + 12 <= tiff.length && entry < directory + 2 + count * 12; entry += 12) {
    if (u16(entry) === 0x0112) {
      const orientation = u16(entry + 8)
      return orientation >= 5 && orientation <= 8
    }
  }
  return false
}
