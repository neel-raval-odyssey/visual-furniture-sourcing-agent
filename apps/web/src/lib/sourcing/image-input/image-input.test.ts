import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  detectImageMimeType,
  ImageInputError,
  toDataUrl,
  validateImageBytes,
  type ImageInputErrorCode,
} from "./image-content";
import { createLocalReferenceImage, InMemoryImageContentProvider, readLocalImageFile } from "./local-file";
import { TEST_GIF, TEST_JPEG, TEST_PNG, TEST_TEXT, TEST_WEBP } from "./test-fixtures";

let dir: string;
const file = (name: string) => join(dir, name);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-image-input-"));
  await writeFile(file("chair.jpg"), TEST_JPEG);
  await writeFile(file("chair.png"), TEST_PNG);
  await writeFile(file("chair.webp"), TEST_WEBP);
  await writeFile(file("empty.jpg"), new Uint8Array());
  await writeFile(file("animation.gif"), TEST_GIF);
  await writeFile(file("text-renamed.jpg"), TEST_TEXT);
  await writeFile(file("png-renamed.jpg"), TEST_PNG);
  await writeFile(file("large.jpg"), new Uint8Array(2048).fill(0xff));
  await mkdir(file("folder.jpg"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: ImageInputErrorCode) {
  await expect(promise).rejects.toBeInstanceOf(ImageInputError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("readLocalImageFile", () => {
  it.each([
    ["chair.jpg", "image/jpeg", TEST_JPEG],
    ["chair.png", "image/png", TEST_PNG],
    ["chair.webp", "image/webp", TEST_WEBP],
  ])("reads %s as %s with the original bytes", async (name, mimeType, original) => {
    const content = await readLocalImageFile(file(name));
    expect(content.mimeType).toBe(mimeType);
    expect(content.bytes).toEqual(original);
  });

  it("rejects a missing file", async () => {
    await expectCode(readLocalImageFile(file("missing.jpg")), "not_found");
  });

  it("rejects a directory", async () => {
    await expectCode(readLocalImageFile(file("folder.jpg")), "not_a_file");
  });

  it("rejects an empty file", async () => {
    await expectCode(readLocalImageFile(file("empty.jpg")), "empty");
  });

  it("rejects an unsupported format", async () => {
    await expectCode(readLocalImageFile(file("animation.gif")), "unsupported_format");
  });

  it("uses the file signature, not the extension", async () => {
    await expectCode(readLocalImageFile(file("text-renamed.jpg")), "unsupported_format");
    expect((await readLocalImageFile(file("png-renamed.jpg"))).mimeType).toBe("image/png");
  });

  it("rejects an oversized file before reading it", async () => {
    await expectCode(readLocalImageFile(file("large.jpg"), 1024), "too_large");
  });

  it("keeps the path out of error messages", async () => {
    const error = await readLocalImageFile(file("missing.jpg")).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(dir);
  });

  it("makes no network requests", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await readLocalImageFile(file("chair.png"));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("image content helpers", () => {
  it("detects formats from signatures only", () => {
    expect(detectImageMimeType(TEST_JPEG)).toBe("image/jpeg");
    expect(detectImageMimeType(TEST_PNG)).toBe("image/png");
    expect(detectImageMimeType(TEST_WEBP)).toBe("image/webp");
    expect(detectImageMimeType(TEST_GIF)).toBeNull();
    expect(detectImageMimeType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("validates size limits on in-memory bytes", () => {
    expect(() => validateImageBytes(TEST_PNG, 4)).toThrow(/limit/);
    expect(() => validateImageBytes(new Uint8Array())).toThrow(ImageInputError);
  });

  it("encodes a base64 data URL with the detected MIME type", () => {
    const url = toDataUrl({ bytes: TEST_PNG, mimeType: "image/png" });
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(url.split(",")[1], "base64")).toEqual(Buffer.from(TEST_PNG));
  });

  it("creates a reference whose id and uri do not contain the file path", async () => {
    const content = await readLocalImageFile(file("chair.jpg"));
    const reference = createLocalReferenceImage(content, "2026-10-24T10:00:00.000Z");

    expect(reference.id).toMatch(/^ref-local-[0-9a-f]{16}$/);
    expect(JSON.stringify(reference)).not.toContain(dir);
    expect(reference.image.mimeType).toBe("image/jpeg");
    expect(createLocalReferenceImage(content, "2026-10-24T10:00:00.000Z").id).toBe(reference.id);
  });

  it("serves registered content and rejects unregistered references", async () => {
    const provider = new InMemoryImageContentProvider();
    const content = { bytes: TEST_PNG, mimeType: "image/png" as const };
    const reference = createLocalReferenceImage(content, "2026-10-24T10:00:00.000Z");

    await expectCode(provider.load(reference), "unknown_reference");
    provider.register(reference.id, content);
    expect(await provider.load(reference)).toBe(content);
  });
});
