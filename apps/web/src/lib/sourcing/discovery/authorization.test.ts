import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSourceEligibility, discoveryReadiness, imageRetrievalAllowed, loadAccessRecord, PROVIDERS, rawRetentionAllowed, type AccessRecordLoad, type MarketplaceAccessRecord } from "./authorization";
import { EXA_PROVIDER_ID } from "./providers/exa/exa-api";
import { APIFY_PROVIDER_ID } from "./providers/apify/actor-input";

const fetchSpy = vi.fn();
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // eligibility is computed offline
  vi.unstubAllGlobals();
  delete PROVIDERS["test-official"];
});

/** A hypothetical official API, registered only inside these tests. */
function registerOfficial() {
  vi.stubGlobal("fetch", fetchSpy);
  PROVIDERS["test-official"] = { id: "test-official", label: "[TEST] official API", acquisition: "official_api", implemented: true, modes: ["image", "keyword", "hybrid"], credentialEnv: "TEST_OFFICIAL_KEY", docs: "-", sends: "reference_photo_and_text" };
}

const record = (entry: Partial<MarketplaceAccessRecord["providers"][string]> = {}, id = "test-official"): AccessRecordLoad => ({
  state: "ok",
  record: {
    schemaVersion: 1,
    providers: {
      [id]: {
        accessBasis: "official_api_agreement",
        agreementReference: "[TEST] agreement on file",
        reviewedBy: "developer",
        reviewedAt: "2026-10-27",
        permittedModes: ["image", "keyword", "hybrid"],
        imageTransferApproved: true,
        liveEnabled: true,
        maxResultsPerRun: 10,
        maxCostUsdPerRun: 1,
        ...entry,
      },
    },
  },
});

const blockedBy = (e: ReturnType<typeof checkSourceEligibility>) => e.checks.filter((c) => !c.ok).map((c) => c.key);

describe("source eligibility", () => {
  it("accepts an official source only when every documented prerequisite is recorded", () => {
    registerOfficial();
    const ok = checkSourceEligibility({ providerId: "test-official", mode: "image", env: { TEST_OFFICIAL_KEY: "k" }, access: record() });
    expect(ok).toMatchObject({ eligible: true, blocker: null, limits: { maxResults: 10, maxCostUsd: 1 } });
    expect(blockedBy(checkSourceEligibility({ providerId: "test-official", mode: "image", env: {}, access: record() }))).toEqual(["credentials"]);
    expect(blockedBy(checkSourceEligibility({ providerId: "test-official", mode: "image", env: { TEST_OFFICIAL_KEY: "k" }, access: { state: "missing" } }))).toEqual(["access_record", "image_transfer", "live_enabled"]);
    expect(blockedBy(checkSourceEligibility({ providerId: "test-official", mode: "image", env: { TEST_OFFICIAL_KEY: "k" }, access: record({ imageTransferApproved: false }) }))).toEqual(["image_transfer"]);
    expect(checkSourceEligibility({ providerId: "test-official", mode: "keyword", env: { TEST_OFFICIAL_KEY: "k" }, access: record({ imageTransferApproved: false }) }).eligible).toBe(true);
    expect(blockedBy(checkSourceEligibility({ providerId: "test-official", mode: "image", env: { TEST_OFFICIAL_KEY: "k" }, access: record({ liveEnabled: false }) }))).toEqual(["live_enabled"]);
    expect(blockedBy(checkSourceEligibility({ providerId: "test-official", mode: "hybrid", env: { TEST_OFFICIAL_KEY: "k" }, access: record({ permittedModes: ["keyword"] }) }))).toContain("access_record");
  });

  it("blocks the implemented scraper by project policy, whatever is configured or recorded", () => {
    vi.stubGlobal("fetch", fetchSpy);
    const e = checkSourceEligibility({ providerId: APIFY_PROVIDER_ID, mode: "keyword", env: { APIFY_TOKEN: "apify-test" }, access: record({}, APIFY_PROVIDER_ID) });
    expect(e.eligible).toBe(false);
    expect(blockedBy(e)).toEqual(["policy"]);
    expect(e.blocker).toMatch(/only an official API or an approved partner/);
    expect(discoveryReadiness("image", { APIFY_TOKEN: "apify-test" }, record({}, APIFY_PROVIDER_ID)).some((r) => r.eligible)).toBe(false);
    expect(checkSourceEligibility({ providerId: "unknown", mode: "image", env: {}, access: { state: "missing" } }).eligible).toBe(false);
  });

  it("blocks Exa (an external search index, not an official API or partner) by project policy, even fully recorded", () => {
    vi.stubGlobal("fetch", fetchSpy);
    const full = record({ accessBasis: "search_index_terms_review", permittedModes: ["keyword"], productImageRetrievalApproved: true, retainRawResponses: true }, EXA_PROVIDER_ID);
    const e = checkSourceEligibility({ providerId: EXA_PROVIDER_ID, mode: "keyword", env: { EXA_API_KEY: "exa-test" }, access: full });
    expect(e.eligible).toBe(false);
    expect(blockedBy(e)).toEqual(["policy"]);
    expect(e.blocker).toMatch(/external web search index/);
    expect(PROVIDERS[EXA_PROVIDER_ID]).toMatchObject({ acquisition: "external_search_index", modes: ["keyword"], sends: "text_only" });
    // Image search is not something Exa offers; it is never claimed.
    expect(blockedBy(checkSourceEligibility({ providerId: EXA_PROVIDER_ID, mode: "image", env: { EXA_API_KEY: "exa-test" }, access: full }))).toContain("implemented");
    // Image retrieval needs an eligible source and its own approval.
    expect(imageRetrievalAllowed(e, full).allowed).toBe(false);
    expect(rawRetentionAllowed(EXA_PROVIDER_ID, full)).toBe(true);
    expect(rawRetentionAllowed(EXA_PROVIDER_ID, { state: "missing" })).toBe(false);
  });

  it("image retrieval is separate from search permission", () => {
    registerOfficial();
    const ok = checkSourceEligibility({ providerId: "test-official", mode: "keyword", env: { TEST_OFFICIAL_KEY: "k" }, access: record() });
    expect(imageRetrievalAllowed(ok, record()).allowed).toBe(false);
    expect(imageRetrievalAllowed(ok, record({ productImageRetrievalApproved: true })).allowed).toBe(true);
  });

  it("reads the private access record strictly: missing, invalid and unknown fields are not permission", async () => {
    vi.stubGlobal("fetch", fetchSpy);
    const dir = await mkdtemp(join(tmpdir(), "vfsa-access-"));
    try {
      const path = join(dir, "marketplace-access.json");
      expect(await loadAccessRecord(path)).toEqual({ state: "missing" });
      await writeFile(path, "{ nope");
      expect((await loadAccessRecord(path)).state).toBe("invalid");
      await writeFile(path, JSON.stringify({ schemaVersion: 1, providers: { x: { liveEnabled: true, dataUseReviewed: true } } }));
      expect((await loadAccessRecord(path)).state).toBe("invalid");
      const valid = record();
      await writeFile(path, JSON.stringify(valid.state === "ok" ? valid.record : null));
      expect((await loadAccessRecord(path)).state).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
