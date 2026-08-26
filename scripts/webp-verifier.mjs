import sharp from 'sharp'

export const DOCUMENTATION_WEBP_LIMITS = Object.freeze({
  minimumBytes: 1_024,
  maximumBytes: 5 * 1_024 * 1_024,
  minimumWidth: 320,
  minimumHeight: 200,
  maximumWidth: 4_096,
  maximumHeight: 4_096,
  maximumPixels: 16_777_216,
})

const SAFE_WEBP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH'])
// Alpha (0x10) is the only permitted VP8X feature. Metadata, animation, and
// reserved bits fail closed.
const UNSAFE_VP8X_FEATURES = 0xef

/**
 * Decode and validate one documentation screenshot. Only still-image WebP
 * payload chunks are accepted; metadata, animation, unknown chunks, trailing
 * bytes, and oversized images fail closed.
 *
 * @param {Uint8Array} bytes
 * @param {string} [label]
 * @returns {Promise<{ readonly width: number, readonly height: number, readonly bytes: number }>}
 */
export async function verifySafeDocumentationWebp(bytes, label = 'documentation screenshot') {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const limits = DOCUMENTATION_WEBP_LIMITS
  if (input.length < limits.minimumBytes || input.length > limits.maximumBytes) {
    throw new Error(
      `${label} must be between ${String(limits.minimumBytes)} and ` +
      `${String(limits.maximumBytes)} bytes`,
    )
  }
  verifyWebpContainer(input, label)

  let metadata
  try {
    metadata = await sharp(input, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: limits.maximumPixels,
    }).metadata()
  } catch {
    throw new Error(`${label} is not a decodable WebP image`)
  }
  if (metadata.format !== 'webp') throw new Error(`${label} must decode as WebP`)
  const width = metadata.width
  const height = metadata.height
  if (width === undefined || height === undefined) {
    throw new Error(`${label} has no decodable dimensions`)
  }
  if (
    width < limits.minimumWidth || height < limits.minimumHeight ||
    width > limits.maximumWidth || height > limits.maximumHeight ||
    width * height > limits.maximumPixels
  ) {
    throw new Error(`${label} dimensions ${String(width)}x${String(height)} are outside the safe bounds`)
  }
  if ((metadata.pages ?? 1) !== 1) throw new Error(`${label} must be a still image`)
  if (
    metadata.exif !== undefined || metadata.icc !== undefined || metadata.iptc !== undefined ||
    metadata.xmp !== undefined || (metadata.comments?.length ?? 0) > 0
  ) {
    throw new Error(`${label} must not contain metadata`)
  }
  let decoded
  try {
    decoded = await sharp(input, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: limits.maximumPixels,
    }).raw().toBuffer({ resolveWithObject: true })
  } catch {
    throw new Error(`${label} does not contain a completely decodable WebP image`)
  }
  if (
    decoded.info.width !== width || decoded.info.height !== height ||
    decoded.info.channels < 1 || decoded.info.channels > 4 ||
    decoded.data.length !== width * height * decoded.info.channels
  ) {
    throw new Error(`${label} decoded pixels do not match its declared dimensions`)
  }
  return Object.freeze({ width, height, bytes: input.length })
}

/** @param {Buffer} bytes @param {string} label */
function verifyWebpContainer(bytes, label) {
  if (
    bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error(`${label} is not a WebP RIFF container`)
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error(`${label} has trailing or truncated RIFF data`)
  }

  let offset = 12
  let imagePayloads = 0
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error(`${label} has a truncated WebP chunk header`)
    const chunk = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const contentStart = offset + 8
    const next = contentStart + length + (length & 1)
    if (next > bytes.length) throw new Error(`${label} has a truncated WebP chunk`)
    if (!SAFE_WEBP_CHUNKS.has(chunk)) {
      throw new Error(`${label} contains forbidden WebP chunk ${JSON.stringify(chunk)}`)
    }
    if (chunk === 'VP8 ' || chunk === 'VP8L') imagePayloads += 1
    if (chunk === 'VP8X') {
      if (length < 10) throw new Error(`${label} has an invalid VP8X chunk`)
      if ((bytes.readUInt8(contentStart) & UNSAFE_VP8X_FEATURES) !== 0) {
        throw new Error(`${label} declares metadata or animation features`)
      }
    }
    offset = next
  }
  if (offset !== bytes.length || imagePayloads !== 1) {
    throw new Error(`${label} must contain exactly one still-image payload`)
  }
}
