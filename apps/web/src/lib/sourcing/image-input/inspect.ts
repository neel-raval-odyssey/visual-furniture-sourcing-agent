import { detectImageMimeType, ImageInputError, type SupportedImageMimeType } from "./image-content";

/**
 * Structural validation of PNG, JPEG and WebP files without a decoder
 * dependency: walks the container structure, checks PNG chunk CRCs and
 * required chunks, JPEG markers through end-of-image, and WebP RIFF sizes, and
 * reads the pixel dimensions. Truncated, corrupted or mislabelled files are
 * rejected. It does not decompress pixel data; full decoding happens in the
 * model provider (and in the SigLIP 2 component, which uses Pillow).
 */

export interface ImageInspection {
  mimeType: SupportedImageMimeType;
  width: number;
  height: number;
}

/** Conservative local limits for model input (not provider limits). */
export const MAX_IMAGE_SIDE_PX = 12_000;
export const MIN_IMAGE_SIDE_PX = 16;
export const MAX_IMAGE_PIXELS = 50_000_000;

const corrupt = (message: string) => new ImageInputError("unsupported_format", `Corrupted image: ${message}`);

let crcTable: Uint32Array | undefined;
/** CRC-32 as used by PNG chunks. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let first = true;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw corrupt("PNG chunk header is truncated");
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) throw corrupt(`PNG chunk ${type} is truncated`);
    const expected = view.getUint32(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expected) throw corrupt(`PNG chunk ${type} fails its CRC check`);
    if (first) {
      if (type !== "IHDR" || length !== 13) throw corrupt("PNG does not start with IHDR");
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      first = false;
    }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (!sawIdat) throw corrupt("PNG has no image data");
      return { width, height };
    }
    offset = end;
  }
  throw corrupt("PNG has no IEND chunk (truncated)");
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let size: { width: number; height: number } | undefined;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw corrupt("JPEG marker expected");
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) throw corrupt("JPEG segment is truncated");
    if (SOF_MARKERS.has(marker)) {
      if (length < 7) throw corrupt("JPEG frame header is too short");
      size = { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (marker === 0xda) {
      if (!size) throw corrupt("JPEG has no frame header before its scan data");
      // Entropy-coded data follows; the file must end with an end-of-image marker.
      if (!(bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9)) throw corrupt("JPEG has no end-of-image marker (truncated)");
      return size;
    }
    offset += 2 + length;
  }
  throw corrupt("JPEG has no scan data");
}

function inspectWebp(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30) throw corrupt("WebP is too short");
  if (view.getUint32(4, true) + 8 !== bytes.length) throw corrupt("WebP RIFF size does not match the file size (truncated)");
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8 ") {
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) throw corrupt("WebP VP8 frame header is invalid");
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) throw corrupt("WebP VP8L header is invalid");
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const w = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    const h = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  throw corrupt(`unknown WebP chunk "${chunk}"`);
}

const isAvif = (bytes: Uint8Array) =>
  bytes.length > 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp" && /^avi[fs]$/.test(String.fromCharCode(...bytes.subarray(8, 12)));

/** Validates the structure and dimensions of PNG, JPEG or WebP bytes. */
export function inspectImage(bytes: Uint8Array): ImageInspection {
  if (bytes.length === 0) throw new ImageInputError("empty", "Image file is empty");
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new ImageInputError(
      "unsupported_format",
      isAvif(bytes)
        ? "AVIF is not accepted for model input: convert it to PNG, JPEG or WebP locally first"
        : "Unsupported image format: expected JPEG, PNG or WebP content",
    );
  }
  const { width, height } =
    mimeType === "image/png" ? inspectPng(bytes) : mimeType === "image/jpeg" ? inspectJpeg(bytes) : inspectWebp(bytes);
  if (width < MIN_IMAGE_SIDE_PX || height < MIN_IMAGE_SIDE_PX) {
    throw new ImageInputError("unsupported_format", `Image is ${width}x${height}; each side must be at least ${MIN_IMAGE_SIDE_PX} px`);
  }
  if (width > MAX_IMAGE_SIDE_PX || height > MAX_IMAGE_SIDE_PX || width * height > MAX_IMAGE_PIXELS) {
    throw new ImageInputError("too_large", `Image is ${width}x${height}; the local limit is ${MAX_IMAGE_SIDE_PX} px per side and ${MAX_IMAGE_PIXELS} pixels`);
  }
  return { mimeType, width, height };
}
