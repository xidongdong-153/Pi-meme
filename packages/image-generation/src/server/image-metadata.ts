import { imageSize } from 'image-size'
import type { ImageLibraryMimeType } from '@pi-meme/contracts/image-library'

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const maxDimension = 16_384
const maxPixels = 64 * 1024 * 1024

/** TIFF orientation in a PNG eXIf or WebP EXIF chunk; JPEG is handled by image-size. */
function exifOrientation(input: Buffer) {
  const bytes = input.subarray(input.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0)
  if (bytes.length < 8) return undefined
  const order = bytes.toString('ascii', 0, 2)
  if (order !== 'II' && order !== 'MM') return undefined
  const uint16 = (offset: number) => (order === 'II' ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset))
  const uint32 = (offset: number) => (order === 'II' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset))
  if (uint16(2) !== 42) return undefined
  const directory = uint32(4)
  if (directory < 8 || directory > bytes.length - 2) return undefined
  const entries = uint16(directory)
  for (let index = 0; index < entries; index++) {
    const offset = directory + 2 + index * 12
    if (offset > bytes.length - 12) return undefined
    if (uint16(offset) === 0x0112 && uint16(offset + 2) === 3 && uint32(offset + 4) === 1) return uint16(offset + 8)
  }
  return undefined
}

function chunkOrientation(bytes: Buffer, mimeType: 'image/png' | 'image/webp') {
  const png = mimeType === 'image/png'
  let offset = png ? 8 : 12
  while (offset <= bytes.length - 12) {
    const length = png ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset + 4)
    const name = bytes.toString('ascii', offset + (png ? 4 : 0), offset + (png ? 8 : 4))
    const start = offset + 8
    if (length > bytes.length - start - (png ? 4 : 0)) return undefined
    if (name === (png ? 'eXIf' : 'EXIF')) return exifOrientation(bytes.subarray(start, start + length))
    offset = start + length + (png ? 4 : length % 2)
  }
  return undefined
}

/** Metadata only: the UI still handles an image that fails to decode. */
export function imageMetadata(bytes: Buffer): { mimeType: ImageLibraryMimeType; width: number; height: number } {
  let mimeType: ImageLibraryMimeType
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature) && bytes.toString('ascii', 12, 16) === 'IHDR')
    mimeType = 'image/png'
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg'
  else if (
    bytes.length >= 20 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) === bytes.length - 8
  )
    mimeType = 'image/webp'
  else throw new Error('图片格式无效，仅支持 PNG、JPEG 和 WebP')
  try {
    const metadata = imageSize(bytes)
    const expected = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)
    if (metadata.type !== expected) throw new Error('图片格式与元数据不一致')
    const orientation = mimeType === 'image/jpeg' ? metadata.orientation : chunkOrientation(bytes, mimeType)
    const rotated = orientation !== undefined && orientation >= 5 && orientation <= 8
    const width = rotated ? metadata.height : metadata.width
    const height = rotated ? metadata.width : metadata.height
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > maxDimension ||
      height > maxDimension ||
      width * height > maxPixels
    )
      throw new Error('图片尺寸无效，单边不能超过 16384 像素，总像素不能超过 64 Mi 像素')
    return { mimeType, width, height }
  } catch (cause) {
    throw new Error('无法读取有效的图片尺寸', { cause })
  }
}
