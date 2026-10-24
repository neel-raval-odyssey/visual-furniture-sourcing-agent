import type { z } from "zod";

const MAX_LISTED_ISSUES = 5;

/** e.g. ["listings", 0, "price", "min"] → "listings[0].price.min". */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((segment, i) =>
      typeof segment === "number" ? `[${segment}]` : `${i === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}

/**
 * Concise, payload-free summary: field paths, issue codes and Zod's generic
 * messages, which describe expectations ("expected number") rather than
 * echoing the received value. Zod 4 does not include raw input in issues.
 */
export function summarizeIssues(error: z.ZodError): string {
  const listed = error.issues
    .slice(0, MAX_LISTED_ISSUES)
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.code} (${issue.message})`);
  const remaining = error.issues.length - listed.length;
  return remaining > 0 ? `${listed.join("; ")}; +${remaining} more` : listed.join("; ");
}
