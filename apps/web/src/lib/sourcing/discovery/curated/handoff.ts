import type { SavedFingerprint } from "../../understanding/saved/saved-fingerprint";

/**
 * Offline search handoff for the operator. It lists what to search for and
 * where; it never contacts Alibaba.com and does not build search URLs.
 */

/** Public, user-facing Alibaba.com entry points. */
export const ALIBABA_ENTRY_POINTS = {
  website: "https://www.alibaba.com/",
  lens: "https://sale.alibaba.com/p/lens/",
} as const;

const EXAMPLE_CANDIDATE = `{
  "listingUrl": "<paste the https://www.alibaba.com/product-detail/... URL>",
  "marketplaceProductId": null,
  "title": "<listing title exactly as shown>",
  "category": null,
  "images": [{ "url": "<image URL shown on the listing>", "role": "primary" }],
  "attributes": { "<attribute as shown>": "<value as shown>" },
  "price": null,
  "minimumOrder": null,
  "supplierRef": "supplier-1",
  "foundWith": "alibaba_lens",
  "notes": null
}`;

const EXAMPLE_SUPPLIER = `{
  "ref": "supplier-1",
  "name": "<supplier name as shown>",
  "profileUrl": "<https://<supplier>.en.alibaba.com/ if shown>",
  "countryCode": null,
  "location": null,
  "classification": null,
  "verifications": null,
  "platformTenureYears": null,
  "tradeAssurance": null,
  "responsiveness": null
}`;

export function renderSearchHandoff(saved: SavedFingerprint, manifestPath: string, caseId: string): string {
  const fp = saved.fingerprint;
  const synthetic = fp.source.dataSource === "mock";
  const lines: string[] = [];
  lines.push(`# Alibaba.com search handoff: ${caseId}${synthetic ? " (SYNTHETIC reference; practice only)" : ""}`);
  lines.push("");
  lines.push("This command searched nothing. Use Alibaba.com's own tools, then record what you find.");
  lines.push("");
  lines.push("## Reference");
  lines.push(`- Reference image id: ${saved.reference.id}`);
  lines.push(`- Fingerprint: ${fp.id} (${fp.source.kind}, ${fp.source.dataSource}${fp.source.modelId ? `, ${fp.source.modelId}` : ""}; saved ${saved.record.recordedAt})`);
  lines.push(`- Image SHA-256: ${saved.record.image.sha256}`);
  lines.push(`- Category: ${fp.category}${fp.subtype ? ` / ${fp.subtype}` : ""}`);
  lines.push("");
  lines.push("## Distinctive features (from the saved fingerprint)");
  for (const f of fp.distinctiveFeatures) {
    lines.push(`- [${f.certainty}] ${f.attribute}${f.certainty === "unknown" ? "" : `: ${f.value}`}`);
  }
  if (fp.distinctiveFeatures.length === 0) lines.push("- (none recorded)");
  lines.push("");
  lines.push("## Saved search queries (unchanged)");
  for (const q of fp.searchQueries) lines.push(`- ${q}`);
  if (fp.searchQueries.length === 0) lines.push("- (none recorded)");
  lines.push("");
  lines.push("## Where to search");
  lines.push(`- Alibaba Lens, Alibaba.com's browser extension: ${ALIBABA_ENTRY_POINTS.lens}`);
  lines.push(`- Alibaba.com: ${ALIBABA_ENTRY_POINTS.website} (search by image if the site offers it, or type the queries above)`);
  lines.push("");
  lines.push("## Steps");
  lines.push("1. Open your own copy of the reference photograph. Check its SHA-256 matches the one above.");
  lines.push("2. Search with Alibaba Lens or Alibaba.com's image search. Optionally also type one or more of the saved queries.");
  lines.push("3. Open a small number of plausible listings (around 5–15). Do not bulk-download galleries or collect supplier lists.");
  lines.push("4. For each listing, copy only what the page shows. Leave anything not shown as null. Never guess.");
  lines.push("5. Record supplier badges only as displayed, with reportedBy (e.g. \"alibaba.com\"). These are marketplace claims, not our verification.");
  lines.push("6. Optionally save a screenshot of the listing under the candidates folder and reference it as { \"localPath\": \"<case>/<file>.png\" }.");
  lines.push('7. Set capture.status to "completed", capture.capturedAt to when you searched, capture.tools and capture.queriesTyped.');
  lines.push(`8. Validate, then run: pnpm source:candidates --case ${caseId} --validate, then --run.`);
  lines.push("");
  lines.push(`## Manifest to fill in: ${manifestPath}`);
  lines.push("");
  lines.push("Candidate entry (add to \"candidates\"; placeholders in <> must be replaced or the entry removed):");
  lines.push("```json");
  lines.push(EXAMPLE_CANDIDATE);
  lines.push("```");
  lines.push('If shown, price is { "min": <number>, "max": <number>, "currency": "<ISO 4217, e.g. USD>", "unit": "<as shown>" } and minimumOrder is { "quantity": <whole number>, "unit": "<as shown>" }.');
  lines.push("Supplier entry (add to \"suppliers\"; a name is required, everything else optional):");
  lines.push("```json");
  lines.push(EXAMPLE_SUPPLIER);
  lines.push("```");
  lines.push("No candidates found? Leave \"candidates\" empty and still set status \"completed\": that records a real empty search.");
  return lines.join("\n");
}
