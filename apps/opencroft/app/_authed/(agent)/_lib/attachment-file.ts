// Turning a picked file into what an ACP image block carries.
//
// THE PAYLOAD IS BASE64 WITH NO `data:` PREFIX, because that is the shape the
// block itself takes — so the bytes chosen here are the bytes the model reads,
// with nothing re-encoding them in between.
//
// A picture is only re-encoded when it has to be. A screenshot pasted at
// retina size is several megabytes of pixels no vision model will look at: the
// providers resize anything past roughly 1568px on its long edge before the
// model sees it, so sending more is paying to transmit detail that is thrown
// away at the other end. Under that, the file goes exactly as it arrived —
// lossless stays lossless, which for a screenshot of text is the difference
// between readable and not.
//
// A GIF is never re-encoded: a canvas holds one frame, so re-encoding an
// animation silently turns it into a still. It is offered as-is and refused by
// the store if it is too large, which is the honest failure.

/** The long edge past which a picture is downscaled, in pixels. */
const MAX_EDGE = 1568

/**
 * The size past which a picture is re-encoded, in base64 characters.
 *
 * Base64 is one character per byte to within a rounding error, so this is
 * roughly 1.5 MB. Well under the store's own 4 MB ceiling: this decides how
 * good the picture is, and that decides whether it is allowed at all.
 */
const REENCODE_ABOVE_CHARS = 1_500_000

const QUALITY_STEPS = [0.92, 0.85, 0.75, 0.6]

/** What one attached picture is, on its way to the store. */
export interface AttachableImage {
  name: string
  mimeType: string
  /** Base64, no `data:` prefix. */
  data: string
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('That file could not be read as an image.'))
    }
    image.src = objectUrl
  })
}

function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? '' : dataUrl.slice(comma + 1)
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.readAsDataURL(file)
  })
}

/**
 * Read a picked file into the base64 an image block carries, re-encoding it
 * only if it is bigger than a model will ever look at.
 *
 * The name is kept as the reader's own: it is what the chip says, and what
 * names the picture to a harness that cannot take the image itself.
 */
export async function readAttachableImage(file: File): Promise<AttachableImage> {
  const asIs = base64Of(await readAsDataUrl(file))
  // An animation survives only by being left alone — see the note above.
  if (file.type === 'image/gif' || asIs.length <= REENCODE_ABOVE_CHARS) {
    return { name: file.name, mimeType: file.type, data: asIs }
  }

  const image = await loadImage(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    // No canvas: hand over what was read and let the store have the final say,
    // rather than refusing a picture this browser simply cannot resize.
    return { name: file.name, mimeType: file.type, data: asIs }
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  // WebP rather than JPEG: it is accepted by the same endpoints, holds text
  // and UI edges far better at the same size — and a screenshot is mostly
  // text and edges, which is exactly what JPEG blurs.
  let encoded = ''
  for (const quality of QUALITY_STEPS) {
    encoded = base64Of(canvas.toDataURL('image/webp', quality))
    if (encoded.length <= REENCODE_ABOVE_CHARS) {
      return { name: file.name, mimeType: 'image/webp', data: encoded }
    }
  }
  // Every step was still too big. The smallest attempt goes, and the store
  // refuses it if it is over the ceiling — a refusal the reader can see beats
  // a picture that quietly never existed.
  return { name: file.name, mimeType: 'image/webp', data: encoded }
}
