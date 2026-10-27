import { describe, expect, it } from "vitest";
import { buildProviderManifest, normalizeRunRows } from "../providers/apify/normalize";
import { keywordRows } from "../providers/apify/test-fixtures";
import { CandidateAssociationError, candidateSetTag, importCuratedCandidates } from "./curated-alibaba-adapter";
import { candidateManifestSchema } from "./manifest";
import { liveShapedManifest, syntheticManifest } from "./test-fixtures";

function providerManifest() {
  const n = normalizeRunRows({ mode: "keyword", providerRunId: "RunKeyword0000001", capturedAt: "2026-10-27T10:01:00.000Z", items: keywordRows("live-shaped") }, "live");
  return buildProviderManifest({
    caseId: "test-live-bed",
    referenceImageId: "ref-test-live",
    fingerprintId: "fp-test-live",
    dataSource: "live",
    capturedAt: "2026-10-27T10:05:00.000Z",
    runs: [{ mode: "keyword", providerRunId: "RunKeyword0000001", status: "succeeded", startedAt: null, finishedAt: null, chargedUsd: 0.002 }],
    normalized: [n],
    queries: ["dark brown panel bed arched headboard"],
    notes: "[TEST]",
  }).manifest;
}

const issues = (value: unknown) => {
  const r = candidateManifestSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("provider_api manifests", () => {
  it("validate alongside unchanged operator-assisted manifests", () => {
    expect(issues(providerManifest())).toEqual([]);
    expect(issues(liveShapedManifest())).toEqual([]);
    expect(issues(syntheticManifest())).toEqual([]);
  });

  it("require provider details and keep the two methods apart", () => {
    const m = providerManifest();
    expect(issues({ ...m, capture: { ...m.capture, provider: null } })).toContain('Required when method is "provider_api"');
    expect(issues({ ...m, capture: { ...m.capture, tools: ["alibaba_lens"] } })).toContain("provider_api manifests may only list provider_* tools");
    const operator = liveShapedManifest();
    expect(issues({ ...operator, capture: { ...operator.capture, provider: m.capture.provider } })).toContain('Only allowed when method is "provider_api"');
    expect(issues({ ...operator, capture: { ...operator.capture, tools: ["provider_keyword_search"] } })).toContain('provider_* tools require method "provider_api"');
    const badSource = { ...m, candidates: m.candidates.map((c) => ({ ...c, discoverySources: [{ ...c.discoverySources![0], providerRunId: "RunUnknown" }] })) };
    expect(issues(badSource)).toContain("Not one of capture.provider.runs");
  });

  it("cannot be combined with operator-assisted manifests in one import", () => {
    expect(() => importCuratedCandidates([providerManifest(), candidateManifestSchema.parse(liveShapedManifest())])).toThrow(CandidateAssociationError);
  });

  it("tags automated sets so their reports never replace the control set's", () => {
    expect(candidateSetTag(importCuratedCandidates([providerManifest()]))).toBe("-auto-RunKeyword0000001");
    expect(candidateSetTag(importCuratedCandidates([candidateManifestSchema.parse(liveShapedManifest())]))).toBe("");
  });
});
