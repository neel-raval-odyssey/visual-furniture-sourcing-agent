import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";
import { startOfflineRun } from "@/lib/sourcing/ui/offline-run";

export const runtime = "nodejs";

/**
 * Starts an offline sourcing run from saved evidence ({ caseId, mode:
 * "offline-saved-evidence" }). Uses the P1-005 orchestrator; no marketplace,
 * image-download or paid model request is possible through this route.
 */
export async function POST(request: Request) {
  const denied = denyUnlessLocal(request, { mutation: true });
  if (denied) return denied;
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return Response.json({ error: "invalid_request", message: "Expected JSON." }, { status: 415 });
  }
  let body: { caseId?: unknown; mode?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request", message: "Expected JSON." }, { status: 400 });
  }
  if (body.mode !== "offline-saved-evidence" || typeof body.caseId !== "string") {
    return Response.json({ error: "invalid_request", message: 'Only { caseId, mode: "offline-saved-evidence" } is supported.' }, { status: 400 });
  }
  const outcome = await startOfflineRun(localPaths(), body.caseId);
  if (!outcome.ok) return Response.json({ error: outcome.code, message: outcome.message }, { status: outcome.status });
  return Response.json({ runId: outcome.runId, status: outcome.status, externalRequests: 0 }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
