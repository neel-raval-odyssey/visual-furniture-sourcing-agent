/**
 * Runs the fully synthetic sourcing pipeline and prints a summary.
 * Run with `pnpm demo:pipeline`. Excluded from `pnpm test`.
 */
import { expect, it } from "vitest";
import { MOCK_REFERENCE_IMAGES } from "../understanding/mock/fixtures";
import { summarizeSourcingRun } from "./summary";
import { createSyntheticSourcingPipeline } from "./synthetic";

const BANNER = [
  "=".repeat(72),
  "SYNTHETIC DEMO: mock fixtures only. Listings, suppliers, fingerprints and",
  "similarity values are invented. Not real Alibaba data or model output.",
  "=".repeat(72),
].join("\n");

it("prints synthetic sourcing runs", async () => {
  const pipeline = createSyntheticSourcingPipeline();

  for (const reference of [MOCK_REFERENCE_IMAGES.chair, MOCK_REFERENCE_IMAGES.table]) {
    const summary = summarizeSourcingRun(await pipeline.run({ reference }));
    expect(summary.containsSyntheticData).toBe(true);
    console.log(`${BANNER}\n${JSON.stringify(summary, null, 2)}\n`);
  }
});
