import { CASE_ID } from "@/lib/sourcing/ui/data";
import { startCatalogueSearch } from "@/lib/sourcing/ui/discovery/catalogue-search";
import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";

export const runtime = "nodejs";
// The local SigLIP 2 comparison runs inside the request (first model load can take a minute).
export const maxDuration = 300;

type Params = { params: Promise<{ caseId: string }> };

/**
 * Search saved catalogue (JSON { action: "search" }): searches the product
 * records saved on this computer for this photo, then compares the selected
 * products that have a photo locally. Local only, same-origin, POST only. No
 * marketplace search, image download or paid AI request is possible here.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = denyUnlessLocal(request, { mutation: true });
  if (denied) return denied;
  const { caseId } = await params;
  if (!CASE_ID.test(caseId)) return Response.json({ error: "invalid_case" }, { status: 400 });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return Response.json({ error: "invalid_request", message: "Expected JSON." }, { status: 415 });
  }
  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request", message: "Expected JSON." }, { status: 400 });
  }
  if (body.action !== "search") return Response.json({ error: "invalid_request", message: 'Expected { action: "search" }.' }, { status: 400 });
  const outcome = await startCatalogueSearch(localPaths(), caseId);
  if (!outcome.ok) return Response.json({ error: outcome.code, message: outcome.message }, { status: outcome.status, headers: { "Cache-Control": "no-store" } });
  const { discoveryId, reusedSearch, products, withPhoto, runId, reusedRun, runStatus } = outcome;
  return Response.json({ discoveryId, reusedSearch, products, withPhoto, runId, reusedRun, runStatus, externalRequests: 0 }, { status: outcome.reusedSearch && (outcome.reusedRun || !outcome.runId) ? 200 : 201, headers: { "Cache-Control": "no-store" } });
}
