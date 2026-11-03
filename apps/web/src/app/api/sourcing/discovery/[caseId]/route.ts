import { CASE_ID } from "@/lib/sourcing/ui/data";
import { fetchAutomaticSearchImages, startAutomaticSearch } from "@/lib/sourcing/ui/discovery/automatic-search";
import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";

export const runtime = "nodejs";
// One search sends at most four requests, each with a 30 s timeout.
export const maxDuration = 300;

type Params = { params: Promise<{ caseId: string }> };

/**
 * Automatic product search (JSON):
 *   { action: "start", requestKey, confirmed: true }   searches with the eligible source, once per request key
 *   { action: "images", discoveryId }                    caches the found listings' images, when approved
 * Local only, same-origin, POST only: loading or refreshing a page never sends
 * a search. Eligibility is checked on the server for every call; the provider
 * key stays on the server.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = denyUnlessLocal(request, { mutation: true });
  if (denied) return denied;
  const { caseId } = await params;
  if (!CASE_ID.test(caseId)) return Response.json({ error: "invalid_case" }, { status: 400 });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return Response.json({ error: "invalid_request", message: "Expected JSON." }, { status: 415 });
  }
  let body: { action?: unknown; requestKey?: unknown; confirmed?: unknown; discoveryId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request", message: "Expected JSON." }, { status: 400 });
  }
  const paths = localPaths();
  const outcome =
    body.action === "start" && typeof body.requestKey === "string"
      ? await startAutomaticSearch(paths, caseId, { requestKey: body.requestKey, confirmed: body.confirmed === true })
      : body.action === "images" && typeof body.discoveryId === "string"
        ? await fetchAutomaticSearchImages(paths, caseId, body.discoveryId)
        : ({ ok: false, status: 400, code: "invalid_request", message: 'Expected { action: "start", requestKey, confirmed } or { action: "images", discoveryId }.' } as const);
  if (!outcome.ok) return Response.json({ error: outcome.code, message: outcome.message }, { status: outcome.status, headers: { "Cache-Control": "no-store" } });
  return Response.json(
    { discoveryId: outcome.discoveryId, status: outcome.status, reused: outcome.reused },
    { status: outcome.reused ? 200 : 201, headers: { "Cache-Control": "no-store" } },
  );
}
