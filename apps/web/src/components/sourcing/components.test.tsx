import { rm } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SourcingResult } from "@/lib/sourcing/orchestration/assemble";
import { getRun, type RunDetail } from "@/lib/sourcing/ui/data";
import { makeUiRepo } from "@/lib/sourcing/ui/test-fixtures";
import { CandidateCard } from "./candidate-card";
import { EvidenceSections, keyDifferences } from "./evidence-sections";
import { ProductDetails } from "./product-details";
import { StageTimeline } from "./stage-timeline";
import { precheckFile } from "./upload-dropzone";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

let root: string;
let result: SourcingResult;
let stages: RunDetail["stages"];

beforeAll(async () => {
  const ctx = await makeUiRepo();
  root = ctx.root;
  const run = await getRun(ctx.paths, ctx.caseId, ctx.runId!);
  result = run!.result!;
  stages = run!.stages;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("sourcing components", () => {
  it("shows a verified card with its index, the actual title, source link and key differences", () => {
    const e = result.verified[0];
    const html = renderToStaticMarkup(<CandidateCard entry={e} imageUrl="/api/x" href="/compare" />);
    expect(html).toContain(e.title);
    expect(html).toContain(`href="${e.listingUrl}"`);
    expect(text(html)).toContain("79");
    expect(text(html)).toContain("Close variant");
    expect(text(html)).toContain("Partial difference: Headboard Arch Count");
    expect(text(html)).toContain("SigLIP retrieval rank 2");
  });

  it("never shows an index or classification for an unverified candidate", () => {
    const e = result.unverified[0];
    const html = text(renderToStaticMarkup(<CandidateCard entry={e} imageUrl={null} href="/compare" />));
    expect(html).toContain("Not visually verified: no usable image");
    expect(html).not.toMatch(/Design index|Close variant|Similar alternative|\b0\/100/);
    expect(html).toContain("No image available for comparison.");
  });

  it("keeps partial structural differences as their own group, separate from matches and mismatches", () => {
    const v = result.verified[0].verification;
    const html = text(renderToStaticMarkup(<EvidenceSections v={v} />));
    const partial = html.indexOf("Partial structural differences (1)");
    expect(partial).toBeGreaterThan(html.indexOf("Matching features"));
    expect(html.slice(partial)).toContain("Headboard Arch Count");
    expect(html).toContain("[TEST] seven narrow arches");
    expect(html).toContain("[TEST] six narrow arches");
    expect(html).toContain("Structural mismatches (1)");
    expect(html).toContain("Visibility limitations");
    expect(keyDifferences(v)[0]).toEqual({ text: "Headboard Arch Count: [TEST] six narrow arches", kind: "partial" });
  });

  it("labels listing data as marketplace-reported and never invents verification", () => {
    const withSupplier = text(renderToStaticMarkup(<ProductDetails entry={result.verified[0]} />));
    expect(withSupplier).toContain("Marketplace-reported information");
    expect(withSupplier).toContain("INR 1,200.5–1,500 per piece");
    expect(withSupplier).toContain("None recorded (unknown, not “unverified”)");
    const noPrice = text(renderToStaticMarkup(<ProductDetails entry={result.verified[1]} />));
    expect(noPrice).toContain("Listed price Not provided");
    expect(noPrice).not.toMatch(/verified supplier/i);
  });

  it("renders recorded stage states in plain language without a progress percentage", () => {
    const html = text(renderToStaticMarkup(<StageTimeline stages={stages} />));
    expect(html).toContain("SigLIP 2 shortlisting Reused saved result");
    expect(html).toContain("Image evidence validation Partial");
    expect(html).not.toMatch(/\d+%/);
  });

  it("pre-checks upload type and size on the client", () => {
    expect(precheckFile({ name: "a.png", type: "image/png", size: 1000 })).toBeNull();
    expect(precheckFile({ name: "a.gif", type: "image/gif", size: 1000 })).toMatch(/PNG, JPEG or WebP/);
    expect(precheckFile({ name: "a.png", type: "image/png", size: 11 * 1024 * 1024 })).toMatch(/larger than 10 MB/);
    expect(precheckFile({ name: "a.png", type: "image/png", size: 0 })).toMatch(/empty/);
  });
});
