import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, EmbeddingProtocolError, PROTOCOL, PROTOCOL_VERSION, validateEmbedResponse, type EmbedRequest } from "./protocol";
import { COMMIT, fakeResponse, sha256 } from "./test-fixtures";

const request: EmbedRequest = {
  protocol: PROTOCOL,
  protocolVersion: PROTOCOL_VERSION,
  model: { id: DEFAULT_MODEL_ID, revision: null },
  device: "auto",
  reference: { id: "ref-1", path: "/abs/ref.png", sha256: sha256("ref") },
  groups: [
    { id: "listing-a", images: [{ ref: "c/a.png", path: "/abs/a.png", sha256: sha256("a") }] },
    {
      id: "listing-b",
      images: [
        { ref: "c/b1.png", path: "/abs/b1.png", sha256: sha256("b1") },
        { ref: "c/b2.png", path: "/abs/b2.png", sha256: sha256("b2") },
      ],
    },
    { id: "listing-c", images: [{ ref: "c/c.png", path: "/abs/c.png", sha256: sha256("c") }] },
  ],
};

const rejects = (raw: unknown, pattern: RegExp) => {
  expect(() => validateEmbedResponse(request, raw)).toThrow(EmbeddingProtocolError);
  expect(() => validateEmbedResponse(request, raw)).toThrow(pattern);
};
const ok = () => structuredClone(fakeResponse(request, { "listing-a": 0.91, "listing-b": 0.42, "listing-c": 0.42 }));

describe("embedding response validation", () => {
  it("accepts a consistent response with deterministic tie order", () => {
    const res = validateEmbedResponse(request, ok());
    expect(res.groups.map((g) => g.id)).toEqual(["listing-a", "listing-b", "listing-c"]);
  });

  it("rejects wrong model metadata", () => {
    rejects({ ...ok(), model: { ...ok().model, id: "google/siglip2-so400m-patch14-384" } }, /was not the requested/);
    rejects({ ...ok(), model: { ...ok().model, revision: "main" } }, /model.revision/);
    rejects({ ...ok(), model: { ...ok().model, dtype: "float16" } }, /model.dtype/);
    rejects({ ...ok(), model: { ...ok().model, modelType: "clip" } }, /model.modelType/);
    const pinned = { ...request, model: { id: DEFAULT_MODEL_ID, revision: "f".repeat(40) } };
    expect(() => validateEmbedResponse(pinned, fakeResponse(pinned, { "listing-a": 1 }))).toThrow(/pinned revision/);
  });

  it("rejects fabricated confidence, design similarity or classification fields", () => {
    for (const field of ["confidence", "designSimilarityIndex", "classification"]) {
      const res = ok();
      (res.groups[0] as Record<string, unknown>)[field] = 0.9;
      rejects(res, /invalid/);
    }
  });

  it("rejects out-of-range or non-numeric scores", () => {
    for (const value of [1.5, -1.2, "0.9", null]) {
      const res = ok() as { groups: { embeddingCosineSimilarity?: unknown }[] };
      res.groups[0].embeddingCosineSimilarity = value;
      rejects(res, /invalid/);
    }
    const near = ok();
    (near.groups[0] as { embeddingCosineSimilarity: number }).embeddingCosineSimilarity = 1 + 1e-6;
    expect(() => validateEmbedResponse(request, near)).not.toThrow();
  });

  it("rejects unsorted results and wrong tie order", () => {
    const res = ok();
    res.groups.reverse();
    rejects(res, /descending similarity order/);
    const tie = ok();
    [tie.groups[1], tie.groups[2]] = [tie.groups[2], tie.groups[1]];
    rejects(tie, /descending similarity order/);
  });

  it("rejects missing, extra or duplicated groups and unoffered images", () => {
    rejects({ ...ok(), groups: ok().groups.slice(0, 2) }, /missing/);
    rejects({ ...ok(), groups: [...ok().groups, { ...ok().groups[2], id: "listing-z" }] }, /unknown group/);
    rejects({ ...ok(), groups: [ok().groups[0], ok().groups[0], ok().groups[1], ok().groups[2]] }, /appears twice/);
    const other = ok();
    (other.groups[0] as { selectedImage: { ref: string } }).selectedImage.ref = "c/elsewhere.png";
    rejects(other, /not offered/);
    const hash = ok();
    (hash.groups[0] as { selectedImage: { sha256: string } }).selectedImage.sha256 = sha256("other");
    rejects(hash, /hash differs/);
  });

  it("requires the first usable image to be the one selected", () => {
    const res = ok();
    const b = res.groups[1] as { selectedImage: { ref: string; sha256: string } };
    b.selectedImage.ref = "c/b2.png";
    b.selectedImage.sha256 = sha256("b2");
    rejects(res, /image-selection order/);
    (res.groups[1] as { rejectedImages: unknown[] }).rejectedImages = [{ ref: "c/b1.png", problem: "decode_failed", message: "x" }];
    expect(() => validateEmbedResponse(request, res)).not.toThrow();
  });

  it("checks the reference and device", () => {
    rejects({ ...ok(), reference: { ...ok().reference, sha256: sha256("other") } }, /reference image differs/);
    const mps = { ...request, device: "mps" as const };
    expect(() => validateEmbedResponse(mps, fakeResponse(mps, { "listing-a": 1 }))).toThrow(/device "cpu" was not the requested "mps"/);
    rejects({ ...ok(), model: { ...ok().model, revision: COMMIT.toUpperCase() } }, /invalid/);
  });

  it("orders unusable groups after embedded ones", () => {
    const res = fakeResponse(request, { "listing-b": 0.3 });
    expect(res.groups.map((g) => [g.id, g.status])).toEqual([
      ["listing-b", "embedded"],
      ["listing-a", "no_usable_image"],
      ["listing-c", "no_usable_image"],
    ]);
    expect(() => validateEmbedResponse(request, res)).not.toThrow();
    rejects({ ...res, groups: [res.groups[1], res.groups[0], res.groups[2]] }, /before unusable/);
  });
});
