/**
 * Web edition: turn a picked/pasted/dropped file into a JPEG/PNG data URI the AI
 * endpoint accepts. Only real JPEG/PNG (checked by magic bytes, not by the file
 * name) is accepted; large photos are downscaled in the browser so a phone photo
 * fits the server's ~1 MB per-image limit. Nothing is uploaded or stored here.
 */
export const MAX_IMAGES = 3
const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_DATA_URI = 1_400_000
const MAX_SIDE = 1600

export type PickedImage = { id: string; url: string }

async function sniff(f: Blob): Promise<'png' | 'jpeg' | null> {
  const b = new Uint8Array(await f.slice(0, 8).arrayBuffer())
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  return null
}

function readDataUrl(f: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(f)
  })
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = () => rej(new Error('图片无法解码'))
    im.src = url
  })
}

export async function prepareImage(f: File): Promise<{ ok: true; image: PickedImage } | { ok: false; reason: string }> {
  if (f.size > MAX_FILE_BYTES) return { ok: false, reason: '图片太大（原图需小于 15MB）' }
  const kind = await sniff(f)
  if (!kind) return { ok: false, reason: '只支持 JPEG / PNG 图片' }
  try {
    const raw = await readDataUrl(f)
    const im = await loadImg(raw)
    const scale = Math.min(1, MAX_SIDE / Math.max(im.naturalWidth, im.naturalHeight))
    let url = raw.replace(/^data:[^;]+;/, `data:image/${kind};`)
    if (scale < 1 || url.length > MAX_DATA_URI) {
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(im.naturalWidth * scale))
      c.height = Math.max(1, Math.round(im.naturalHeight * scale))
      const ctx = c.getContext('2d')
      if (!ctx) return { ok: false, reason: '浏览器无法处理图片' }
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(im, 0, 0, c.width, c.height)
      for (const q of [0.88, 0.75, 0.6]) {
        url = c.toDataURL('image/jpeg', q)
        if (url.length <= MAX_DATA_URI) break
      }
    }
    if (url.length > MAX_DATA_URI) return { ok: false, reason: '图片压缩后仍过大，请裁剪后再试' }
    return { ok: true, image: { id: Math.random().toString(36).slice(2), url } }
  } catch {
    return { ok: false, reason: '图片无法读取' }
  }
}

/**
 * The copy that is SAVED with the conversation (shown again on every device of the account).
 * Long side ≤ STORE_SIDE, JPEG; quality steps down only as far as needed to fit STORE_MAX_BYTES,
 * and never below STORE_MIN_Q, so printed question text stays readable (checked on real
 * question screenshots: 1400 px / q≥0.72 keeps 14 px CJK text legible).
 */
export const STORE_SIDE = 1400
export const STORE_MAX_BYTES = 420_000
const STORE_MIN_Q = 0.6
export async function storeCopy(
  dataUri: string,
): Promise<{ ok: true; url: string; bytes: number } | { ok: false; reason: string }> {
  try {
    const im = await loadImg(dataUri)
    const scale = Math.min(1, STORE_SIDE / Math.max(im.naturalWidth, im.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(im.naturalWidth * scale))
    c.height = Math.max(1, Math.round(im.naturalHeight * scale))
    const ctx = c.getContext('2d')
    if (!ctx) return { ok: false, reason: '浏览器无法处理图片' }
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(im, 0, 0, c.width, c.height)
    // re-encoding through a canvas also drops EXIF / GPS and other metadata
    for (const q of [0.82, 0.76, 0.7, 0.65, STORE_MIN_Q]) {
      const url = c.toDataURL('image/jpeg', q)
      const bytes = Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4)
      if (bytes <= STORE_MAX_BYTES) return { ok: true, url, bytes }
    }
    return { ok: false, reason: '图片内容太复杂，压缩后仍超过 420KB，请裁剪后再试' }
  } catch {
    return { ok: false, reason: '图片无法读取' }
  }
}
