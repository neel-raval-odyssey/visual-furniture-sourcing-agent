import { describe, expect, it } from "vitest";
import type { FurnitureFeature, ReferenceImage } from "../../domain";
import { MOCK_FINGERPRINTS, MOCK_REFERENCE_IMAGES } from "./fixtures";
import {
  MockImageUnderstandingService,
  UnsupportedReferenceError,
} from "./mock-image-understanding";

const allFeatures = (features: FurnitureFeature[][]) => features.flat();

describe("MockImageUnderstandingService", () => {
  const service = new MockImageUnderstandingService();

  it("returns the chair fingerprint for the chair reference", async () => {
    const fp = await service.analyze(MOCK_REFERENCE_IMAGES.chair);

    expect(fp.id).toBe("mock-fp-chair-001");
    expect(fp.category).toBe("chair");
    expect(fp.referenceImageIds).toEqual([MOCK_REFERENCE_IMAGES.chair.id]);
  });

  it("returns the table fingerprint for the table reference", async () => {
    const fp = await service.analyze(MOCK_REFERENCE_IMAGES.table);

    expect(fp.id).toBe("mock-fp-table-001");
    expect(fp.category).toBe("table");
    expect(fp.referenceImageIds).toEqual([MOCK_REFERENCE_IMAGES.table.id]);
  });

  it("returns observed, inferred and unknown features without claiming analysis", async () => {
    const fp = await service.analyze(MOCK_REFERENCE_IMAGES.chair);
    const certainties = new Set(
      allFeatures([fp.structure, fp.appearance, fp.distinctiveFeatures]).map(
        (f) => f.certainty,
      ),
    );

    expect(certainties).toEqual(new Set(["observed", "inferred", "unknown"]));
    expect(fp.source).toEqual({ kind: "fixture", dataSource: "mock" });
  });

  it("rejects an unsupported reference instead of inventing a fingerprint", async () => {
    const unknown: ReferenceImage = {
      id: "unknown-ref",
      image: { uri: "https://example.com/unknown.jpg" },
      origin: { kind: "unknown" },
      submittedAt: "2026-01-01T00:00:00.000Z",
    };

    await expect(service.analyze(unknown)).rejects.toThrow(UnsupportedReferenceError);
    await expect(service.analyze(unknown)).rejects.toMatchObject({
      referenceImageId: "unknown-ref",
    });
  });

  it("identifies references by id, not by image content", async () => {
    const sameImageDifferentId: ReferenceImage = {
      ...MOCK_REFERENCE_IMAGES.chair,
      id: "another-ref",
    };
    await expect(service.analyze(sameImageDifferentId)).rejects.toThrow(
      UnsupportedReferenceError,
    );
  });

  it("is deterministic and does not expose its fixtures to mutation", async () => {
    const before = structuredClone(MOCK_FINGERPRINTS);

    const first = await service.analyze(MOCK_REFERENCE_IMAGES.chair);
    first.category = "changed";
    first.searchQueries.push("changed");
    const second = await service.analyze(MOCK_REFERENCE_IMAGES.chair);

    expect(second).toEqual(before[0]);
    expect(MOCK_FINGERPRINTS).toEqual(before);
  });
});
