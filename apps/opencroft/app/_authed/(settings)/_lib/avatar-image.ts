// Turning a picked file into something small enough to keep in a database
// column.
//
// THE DECISION: cap the image here rather than introduce
// image storage. An avatar is stored as a data URL in `user.image`, exactly
// as an agent node stores its own — see `readAsDataUrl` in the core agent
// node. That precedent needs no upload endpoint and no object store, and
// following it keeps a small feature small.
//
// What the precedent does NOT account for is that these rows come back as a
// LIST: the administrator's user list renders every account at once, so an
// uncapped avatar is a cost paid on every load of that page by everyone, not
// just by the person who chose the picture. An agent node is read one at a
// time and never had that problem. So the file is re-encoded to a small
// square before it is ever sent.
//
// Real storage is the right answer once avatars are large, numerous, or want
// caching and CDN delivery. None of that is true yet, and doing it now would
// be a backend, a migration and a serving path for a 48-pixel circle.

/**
 * The stored square, in pixels.
 *
 * `AgentAvatar` renders at 48px (`lg`, the account screen) and 32px (`md`,
 * the user list), so 192 is four times the largest place it appears — sharp
 * on a 3x display with room to spare, and far below anything worth a storage
 * backend.
 */
export const AVATAR_PX = 192

// The encoder is asked for progressively lower quality until the result fits.
// A ceiling in characters rather than bytes: base64 is one character per byte
// to within a rounding error, and this is a budget, not an audit. The server
// enforces its own, higher limit — this one only decides how good the picture
// is, not whether it is allowed.
const TARGET_MAX_CHARS = 32 * 1024
const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.4]

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

/**
 * Read a picked file and re-encode it as a small square data URL, ready to
 * store on `user.image`.
 *
 * Centre-cropped rather than squashed: the avatar is rendered in a circle, so
 * letterboxing would show as bars and stretching would distort a face.
 */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
  const image = await loadImage(file)

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_PX
  canvas.height = AVATAR_PX
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('This browser could not process the image.')
  }

  // JPEG has no alpha, so a transparent PNG would otherwise composite onto
  // black. White matches the surface the avatar sits on.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, AVATAR_PX, AVATAR_PX)

  // Cover: scale so the shorter side fills the square, then centre the
  // overflow.
  const scale = Math.max(AVATAR_PX / image.width, AVATAR_PX / image.height)
  const width = image.width * scale
  const height = image.height * scale
  context.drawImage(image, (AVATAR_PX - width) / 2, (AVATAR_PX - height) / 2, width, height)

  let encoded = ''
  for (const quality of QUALITY_STEPS) {
    encoded = canvas.toDataURL('image/jpeg', quality)
    if (encoded.length <= TARGET_MAX_CHARS) {
      return encoded
    }
  }
  // Every step was still too big — hand back the smallest attempt and let the
  // server have the final say rather than silently storing nothing.
  return encoded
}
