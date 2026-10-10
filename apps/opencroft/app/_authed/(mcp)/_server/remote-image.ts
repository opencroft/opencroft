/**
 * What remote_view_image does between the remote file and the image block: read
 * the bytes over the exec channel, decide what they are, crop and scale them
 * into what a vision model takes, and say what was done.
 *
 * The exec channel is injected, so the reading is testable against a real shell
 * without a node, and the picture work needs only `sharp`.
 */

import sharp from 'sharp'

import {
  VISION_MAX_EDGE,
  VISION_QUALITY_STEPS,
  VISION_REENCODE_ABOVE_CHARS,
  type VisionMimeType,
} from '@/app/_authed/(agent)/_lib/vision-image'
import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'

/**
 * The largest file remote_view_image reads, in bytes. Bigger is refused, never
 * cut: a picture's bytes cut short decode to nothing or to half a picture.
 *
 * Bounded by what is worth carrying through the exec channel for one look, not
 * by a format: a full-page retina screenshot as PNG is a few megabytes, and a
 * file eight times that is either not a screenshot or wants `region`.
 */
export const MAX_VIEW_FILE_BYTES = 32 * 1024 * 1024

/**
 * Raw bytes read per exec round trip. As base64 that is 4 MiB of output, under
 * the 5 MiB the terminal backend collects from one command before it cuts.
 */
export const VIEW_CHUNK_BYTES = 3 * 1024 * 1024

/**
 * The most pixels a picture may decode to. Decoding happens in this server, so a
 * small file that inflates to gigapixels (a decompression bomb) must be refused
 * before it is decoded. 100 MP admits a 10000×10000 image and any full-page
 * screenshot we take; sharp's own default is 268 MP.
 */
export const MAX_VIEW_INPUT_PIXELS = 100_000_000

/** Bytes needed from the start of a file to tell the four types apart. */
const SNIFF_BYTES = 16

/**
 * The image type the bytes declare, by their signature, or null when they are
 * none of the types a vision model takes. Never the file name: an extension is
 * a label, and a `.png` holding HTML is still HTML.
 */
export function sniffImageType(head: Buffer): VisionMimeType | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg'
  }
  const ascii = head.toString('latin1')
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/**
 * One round trip that says whether `filePath` is a readable regular file, its
 * byte count and its first bytes — enough to refuse a directory, a missing
 * file, a non-image or an oversized file before any of it is transferred.
 *
 * Every field is printed whatever happens and a trailing `ok=1` marks a complete
 * run, so a failed `wc` reads as "unreadable", never as "empty". Only reading
 * verbs, and the one interpolated value is quoted (see READ_ONLY_TOOLS).
 */
export function buildImageProbeCommand(filePath: string, quote: (s: string) => string): string {
  return [
    `f=${quote(filePath)}`,
    `if [ -d "$f" ]; then k=dir; elif [ -f "$f" ]; then k=file; elif [ -e "$f" ]; then k=other; else k=missing; fi`,
    `s=$(wc -c < "$f" 2>/dev/null | tr -d ' ' || true)`,
    `h=$(head -c ${SNIFF_BYTES} "$f" 2>/dev/null | base64 | tr -d '\\n' || true)`,
    `printf 'kind=%s\\nsize=%s\\nhead=%s\\nok=1\\n' "$k" "$s" "$h"`,
  ].join('; ')
}

/** A probed file that may be viewed: its size and the type its bytes declare. */
export interface ProbedImage {
  size: number
  mimeType: VisionMimeType
}

/** Read a `buildImageProbeCommand` answer, refusing every file that may not be viewed. */
export function parseImageProbe(output: string, filePath: string): ProbedImage {
  const fields = new Map<string, string>()
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1))
    }
  }
  if (fields.get('ok') !== '1') {
    fail(-32603, `Cannot view ${filePath}: the remote did not complete the probe.`)
  }
  const kind = fields.get('kind')
  if (kind === 'missing') {
    fail(-32602, `Cannot view ${filePath}: no such file.`)
  }
  if (kind !== 'file') {
    fail(-32602, `Cannot view ${filePath}: it is ${kind === 'dir' ? 'a directory' : 'not a regular file'}.`)
  }
  const size = Number.parseInt(fields.get('size') ?? '', 10)
  if (!Number.isFinite(size)) {
    fail(-32602, `Cannot view ${filePath}: the file cannot be read.`)
  }
  if (size === 0) {
    fail(-32602, `Cannot view ${filePath}: the file is empty.`)
  }
  const mimeType = sniffImageType(Buffer.from(fields.get('head') ?? '', 'base64'))
  if (!mimeType) {
    fail(
      -32602,
      `Cannot view ${filePath}: it is not a PNG, JPEG, WebP or GIF image (judged by its content, not its name). Use remote_read for text.`,
    )
  }
  if (size > MAX_VIEW_FILE_BYTES) {
    fail(
      -32602,
      `Cannot view ${filePath}: it is ${formatBytes(size)}, over the ${formatBytes(MAX_VIEW_FILE_BYTES)} a view reads. Make a smaller copy on the remote first.`,
    )
  }
  return { size, mimeType }
}

/** Read `length` bytes from `offset` as one line of base64. Reading verbs only; the path is quoted. */
export function buildChunkReadCommand(
  filePath: string,
  offset: number,
  length: number,
  quote: (s: string) => string,
): string {
  return `tail -c +${offset + 1} ${quote(filePath)} | head -c ${length} | base64 | tr -d '\\n'`
}

/** An exec channel: the command's stdout, and whether the backend cut it. */
export type DetailedExec = (command: string) => Promise<{ stdout: string; truncated: boolean }>

/**
 * Bring `size` bytes of `filePath` across in chunks, checking every chunk's
 * length and refusing rather than returning a short file — a file that changes
 * size while it is read included.
 */
export async function readRemoteBytes(
  exec: DetailedExec,
  filePath: string,
  size: number,
  quote: (s: string) => string,
  chunkBytes: number = VIEW_CHUNK_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < size; offset += chunkBytes) {
    const expected = Math.min(chunkBytes, size - offset)
    const { stdout, truncated } = await exec(buildChunkReadCommand(filePath, offset, expected, quote))
    const chunk = Buffer.from(stdout.trim(), 'base64')
    if (truncated || chunk.length !== expected) {
      fail(
        -32603,
        `Read verification failed for ${filePath}: expected ${expected} bytes at offset ${offset}, received ${chunk.length}. Refusing to view a partial file.`,
      )
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** A rectangle of the source picture, in its pixels as displayed. */
export interface ImageRegion {
  x: number
  y: number
  width: number
  height: number
}

/** Validate the caller's `region`, or undefined when none was given. Bounds are checked against the picture later. */
export function parseRegion(value: unknown): ImageRegion | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(-32602, 'region must be an object { x, y, width, height } in source pixels')
  }
  const r = value as Record<string, unknown>
  const field = (name: keyof ImageRegion, min: number): number => {
    const n = r[name]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min) {
      fail(-32602, `region.${name} must be a whole number of at least ${min}`)
    }
    return n
  }
  return { x: field('x', 0), y: field('y', 0), width: field('width', 1), height: field('height', 1) }
}

/** The size a picture is sent at: the long edge within `maxEdge`, the aspect ratio kept. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = VISION_MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** What is sent, and the facts the text part reports about it. */
export interface PreparedImage {
  data: Buffer
  mimeType: VisionMimeType
  source: { width: number; height: number; bytes: number; mimeType: VisionMimeType; frames: number }
  region?: ImageRegion
  sent: { width: number; height: number }
  scaled: boolean
  reencoded: boolean
}

const SHARP_FORMAT: Record<VisionMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * Turn the file's bytes into what is sent.
 *
 * Sent exactly as read when nothing asks otherwise — no region, within the long
 * edge, no recorded rotation, within the size budget — so lossless stays
 * lossless. Otherwise re-encoded in the source's own kind (a GIF as a PNG of its
 * first frame), and as WebP at falling qualities while that is still over the
 * budget; the smallest attempt goes if none fits.
 */
export async function prepareImage(
  bytes: Buffer,
  mimeType: VisionMimeType,
  filePath: string,
  region?: ImageRegion,
): Promise<PreparedImage> {
  const open = () => sharp(bytes, { limitInputPixels: MAX_VIEW_INPUT_PIXELS })
  let meta: sharp.Metadata
  try {
    meta = await open().metadata()
  } catch (err) {
    fail(-32602, `Cannot view ${filePath}: it could not be decoded as ${mimeType} (${(err as Error).message}).`)
  }
  if (meta.format !== SHARP_FORMAT[mimeType]) {
    fail(-32602, `Cannot view ${filePath}: its bytes start as ${mimeType} but decode as ${meta.format ?? 'nothing'}.`)
  }
  const width = meta.autoOrient.width
  const height = meta.autoOrient.height
  if (width * height > MAX_VIEW_INPUT_PIXELS) {
    fail(
      -32602,
      `Cannot view ${filePath}: it is ${width}×${height}, over the ${MAX_VIEW_INPUT_PIXELS / 1_000_000} megapixels a view decodes.`,
    )
  }
  const source = { width, height, bytes: bytes.length, mimeType, frames: meta.pages ?? 1 }
  if (region && (region.x + region.width > width || region.y + region.height > height)) {
    fail(
      -32602,
      `Cannot view ${filePath}: region ${region.x},${region.y} ${region.width}×${region.height} reaches outside the ${width}×${height} picture.`,
    )
  }
  const cropped = region ? { width: region.width, height: region.height } : { width, height }
  const sent = fitWithin(cropped.width, cropped.height)
  const scaled = sent.width !== cropped.width || sent.height !== cropped.height
  const rotated = (meta.orientation ?? 1) > 1
  if (!region && !scaled && !rotated && base64Length(bytes.length) <= VISION_REENCODE_ABOVE_CHARS) {
    return { data: bytes, mimeType, source, sent, scaled: false, reencoded: false }
  }

  // Orientation first, so `region` is in the pixels a viewer sees; then the crop, then the scale.
  const pipeline = () => {
    let image = open().autoOrient()
    if (region) {
      image = image.extract({ left: region.x, top: region.y, width: region.width, height: region.height })
    }
    return scaled ? image.resize(sent.width, sent.height, { fit: 'fill' }) : image
  }
  let out: { data: Buffer; mimeType: VisionMimeType }
  if (mimeType === 'image/jpeg') {
    out = { data: await pipeline().jpeg({ quality: 90 }).toBuffer(), mimeType }
  } else if (mimeType === 'image/webp') {
    out = { data: await pipeline().webp({ quality: 90 }).toBuffer(), mimeType }
  } else {
    out = { data: await pipeline().png().toBuffer(), mimeType: 'image/png' }
  }
  for (const quality of VISION_QUALITY_STEPS) {
    if (base64Length(out.data.length) <= VISION_REENCODE_ABOVE_CHARS) {
      break
    }
    out = {
      data: await pipeline()
        .webp({ quality: Math.round(quality * 100) })
        .toBuffer(),
      mimeType: 'image/webp',
    }
  }
  return { ...out, source, ...(region ? { region } : {}), sent, scaled, reencoded: true }
}

/** Bytes as a reader says them: KB under a megabyte, MB to one decimal above. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const TYPE_LABEL: Record<VisionMimeType, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
}

/** The text part: the path, the original size, the size sent, and why they differ. */
export function describeView(filePath: string, image: PreparedImage): string {
  const { source, sent } = image
  const lines = [
    `${filePath}: ${TYPE_LABEL[source.mimeType]}, ${source.width}×${source.height}, ${formatBytes(source.bytes)}.`,
  ]
  if (image.region) {
    const r = image.region
    lines.push(`Region: x=${r.x}, y=${r.y}, ${r.width}×${r.height}.`)
  }
  const sentLine = `Sent: ${TYPE_LABEL[image.mimeType]}, ${sent.width}×${sent.height}, ${formatBytes(image.data.length)}`
  if (!image.reencoded) {
    lines.push(`${sentLine}, the file as it is.`)
  } else if (image.scaled) {
    const from = image.region ? `${image.region.width}×${image.region.height}` : `${source.width}×${source.height}`
    lines.push(`${sentLine}, scaled down from ${from} to keep the long edge within ${VISION_MAX_EDGE} px.`)
  } else {
    lines.push(`${sentLine}, re-encoded at full resolution.`)
  }
  if (image.reencoded && source.mimeType === 'image/gif' && source.frames > 1) {
    lines.push(`The GIF has ${source.frames} frames; only the first was sent.`)
  }
  return lines.join('\n')
}
