import { describe, expect, it } from "vitest";
import { makeJpeg, makePng, makeWebp } from "../verification/openai/test-fixtures";
import { ImageInputError } from "./image-content";
import { inspectImage } from "./inspect";

const code = (bytes: Uint8Array) => {
  try {
    inspectImage(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(ImageInputError);
    return { code: (error as ImageInputError).code, message: (error as ImageInputError).message };
  }
  throw new Error("expected inspectImage to fail");
};

describe("inspectImage", () => {
  it("reads PNG, JPEG and WebP dimensions", () => {
    expect(inspectImage(makePng(32, 24))).toEqual({ mimeType: "image/png", width: 32, height: 24 });
    expect(inspectImage(makeJpeg(40, 30))).toEqual({ mimeType: "image/jpeg", width: 40, height: 30 });
    expect(inspectImage(makeWebp(50, 20))).toEqual({ mimeType: "image/webp", width: 50, height: 20 });
  });

  it("rejects truncated and corrupted files", () => {
    const png = makePng();
    expect(code(png.subarray(0, png.length - 5)).message).toMatch(/truncated/);
    const flipped = Buffer.from(png);
    flipped[40] ^= 0xff;
    expect(code(flipped).message).toMatch(/CRC/);
    const jpeg = makeJpeg();
    expect(code(jpeg.subarray(0, jpeg.length - 2)).message).toMatch(/end-of-image/);
    const webp = makeWebp();
    expect(code(webp.subarray(0, webp.length - 1)).message).toMatch(/RIFF size/);
  });

  it("rejects unsupported formats, naming AVIF explicitly", () => {
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(20)]);
    expect(code(avif)).toMatchObject({ code: "unsupported_format", message: expect.stringMatching(/AVIF .*convert/) });
    expect(code(Buffer.from("GIF89a....")).code).toBe("unsupported_format");
    expect(code(new Uint8Array()).code).toBe("empty");
  });

  it("enforces dimension limits", () => {
    expect(code(makePng(8, 8)).message).toMatch(/at least 16 px/);
    expect(code(makePng(12_001, 16)).code).toBe("too_large");
  });
});
