import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { ReferenceImage } from "../domain";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  formatBytes,
  ImageInputError,
  validateImageBytes,
  type ImageContent,
  type ReferenceImageContentProvider,
} from "./image-content";

/**
 * Reads and validates a local image file. Errors name the problem, not the
 * path, so callers can decide whether to show the path.
 */
export async function readLocalImageFile(
  path: string,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): Promise<ImageContent> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new ImageInputError("not_a_file", "Image path is not a regular file");
    size = info.size;
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ImageInputError("not_found", "Image file not found", { cause: error });
    throw new ImageInputError("unreadable", "Image file cannot be accessed", { cause: error });
  }

  // Check the size before reading so oversized files are never loaded.
  if (size === 0) throw new ImageInputError("empty", "Image file is empty");
  if (size > maxBytes) {
    throw new ImageInputError(
      "too_large",
      `Image is ${formatBytes(size)}; the limit is ${formatBytes(maxBytes)}`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new ImageInputError("unreadable", "Image file cannot be read", { cause: error });
  }
  return validateImageBytes(bytes, maxBytes);
}

/**
 * Builds a ReferenceImage for a local file without exposing its path: the id
 * and uri are derived from a SHA-256 of the content.
 */
export function createLocalReferenceImage(
  content: ImageContent,
  submittedAt: string,
): ReferenceImage {
  const digest = createHash("sha256").update(content.bytes).digest("hex").slice(0, 16);
  return {
    id: `ref-local-${digest}`,
    image: { uri: `local-file:sha256-${digest}`, mimeType: content.mimeType },
    origin: { kind: "unknown" },
    submittedAt,
  };
}

/**
 * Serves already-validated content for explicitly registered reference ids.
 * Used by the local CLI; production providers will read uploads or storage.
 */
export class InMemoryImageContentProvider implements ReferenceImageContentProvider {
  private readonly contents = new Map<string, ImageContent>();

  register(referenceId: string, content: ImageContent): void {
    this.contents.set(referenceId, content);
  }

  async load(reference: ReferenceImage): Promise<ImageContent> {
    const content = this.contents.get(reference.id);
    if (!content) {
      throw new ImageInputError(
        "unknown_reference",
        `No image content registered for reference "${reference.id}"`,
      );
    }
    return content;
  }
}
