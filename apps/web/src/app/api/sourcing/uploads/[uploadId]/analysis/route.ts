import { analyzeUpload, finishPendingRegistration, getAnalysisStatus, type AnalysisStatus } from "@/lib/sourcing/ui/analysis/analyze-upload";
import type { AnalysisAttempt } from "@/lib/sourcing/ui/analysis/attempts";
import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";
import { UPLOAD_ID } from "@/lib/sourcing/ui/uploads";

export const runtime = "nodejs";

type Params = { params: Promise<{ uploadId: string }> };

const noStore = { "Cache-Control": "no-store" };

/** What the browser may see of an attempt: states and outcomes, never paths, keys or payloads. */
const publicAttempt = (a: AnalysisAttempt | null | undefined) =>
  a ? { attempt: a.attempt, state: a.state, reservedAt: a.reservedAt, finishedAt: a.finishedAt, outcome: a.outcome ? { kind: a.outcome.kind, modelOutcome: a.outcome.modelOutcome, errorCategory: a.outcome.errorCategory } : null } : null;

function publicStatus(s: AnalysisStatus) {
  if (s.state === "ready") return { state: s.state, attemptKey: s.attemptKey, model: s.request.model };
  if (s.state === "unavailable") return { state: s.state, problem: s.problem, message: s.message };
  if (s.state === "blocked") return { state: s.state, message: s.message };
  return { state: s.state, attempt: publicAttempt(s.attempt) };
}

/** Read-only analysis state of one staged upload, for polling. Never contacts OpenAI. */
export async function GET(request: Request, { params }: Params) {
  const denied = denyUnlessLocal(request);
  if (denied) return denied;
  const { uploadId } = await params;
  if (!UPLOAD_ID.test(uploadId)) return Response.json({ error: "invalid_upload_id" }, { status: 400 });
  return Response.json(publicStatus(await getAnalysisStatus(localPaths(), uploadId)), { headers: noStore });
}

/**
 * {"action":"analyze","attemptKey":"…"}: one explicitly confirmed GPT-6 Luna
 * analysis of this upload (the key is the one the confirmation dialog showed).
 * {"action":"finish-saving"}: register an already-paid result; no request.
 * No model, path or key is ever taken from the request.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = denyUnlessLocal(request, { mutation: true });
  if (denied) return denied;
  const { uploadId } = await params;
  if (!UPLOAD_ID.test(uploadId)) return Response.json({ error: "invalid_upload_id" }, { status: 400 });
  let body: { action?: unknown; attemptKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request", message: "Send a JSON body." }, { status: 400 });
  }
  const paths = localPaths();
  let outcome;
  if (body.action === "analyze" && typeof body.attemptKey === "string" && /^[0-9a-f]{64}$/.test(body.attemptKey)) {
    // Not tied to request.signal: if the browser goes away, the one request still completes and is recorded.
    outcome = await analyzeUpload(paths, uploadId, body.attemptKey);
  } else if (body.action === "finish-saving") {
    outcome = await finishPendingRegistration(paths, uploadId);
  } else {
    return Response.json({ error: "invalid_request", message: "Unsupported action. An analysis needs an explicit confirmation." }, { status: 400 });
  }
  if (outcome.ok) return Response.json({ ok: true, attempt: publicAttempt(outcome.attempt) }, { status: 200, headers: noStore });
  return Response.json({ ok: false, error: outcome.code, message: outcome.message, attempt: publicAttempt(outcome.attempt) }, { status: outcome.status, headers: noStore });
}
