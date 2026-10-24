/**
 * TEST FIXTURES: minimal byte sequences with valid image signatures. They
 * are not decodable photographs and are only used by unit tests.
 */

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

export const TEST_JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF", [0x00, 0x01, 0x02]);
export const TEST_PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0x00, 0x00, 0x00, 0x0d], "IHDR");
export const TEST_WEBP = bytes("RIFF", [0x1a, 0x00, 0x00, 0x00], "WEBP", "VP8 ", [0x00, 0x00]);
export const TEST_GIF = bytes("GIF89a", [0x01, 0x00, 0x01, 0x00]);
export const TEST_TEXT = bytes("not an image at all");
