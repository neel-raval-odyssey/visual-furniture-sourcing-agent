import type { ReferenceImage } from "../domain";

/** Image formats accepted for model input in this phase. */
export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/webp";

/** Conservative default upload limit: 10 MB. */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Validated image bytes, exactly as read (never re-encoded or resized). Kept
 * out of domain contracts: it holds binary data and is not serializable.
 */
export interface ImageContent {
  bytes: Uint8Array;
  mimeType: SupportedImageMimeType;
}

/**
 * Resolves the bytes for a reference image. Implementations decide where the
 * bytes live (local file, upload, object storage); consumers must not assume
 * `ReferenceImage.image.uri` is a filesystem path.
 */
export interface ReferenceImageContentProvider {
  load(reference: ReferenceImage): Promise<ImageContent>;
}

export type ImageInputErrorCode =
  | "not_found"
  | "not_a_file"
  | "unreadable"
  | "empty"
  | "too_large"
  | "unsupported_format"
  | "unknown_reference";

export class ImageInputError extends Error {
  readonly code: ImageInputErrorCode;

  constructor(code: ImageInputErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImageInputError";
    this.code = code;
  }
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Identifies the format from the file signature ("magic bytes"), not the name. */
export function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** Validates size and format. Returns the original bytes unchanged. */
export function validateImageBytes(
  bytes: Uint8Array,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ImageContent {
  if (bytes.length === 0) throw new ImageInputError("empty", "Image file is empty");
  if (bytes.length > maxBytes) {
    throw new ImageInputError(
      "too_large",
      `Image is ${formatBytes(bytes.length)}; the limit is ${formatBytes(maxBytes)}`,
    );
  }
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new ImageInputError(
      "unsupported_format",
      "Unsupported image format: expected JPEG, PNG or WebP content",
    );
  }
  return { bytes, mimeType };
}

/** Encodes image bytes as a base64 data URL for model input. */
export function toDataUrl(content: ImageContent): string {
  return `data:${content.mimeType};base64,${Buffer.from(content.bytes).toString("base64")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
