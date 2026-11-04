import { AssistProblem, captureProduct, closeBrowserSession, confirmCapture, discardCapture, listOpenProducts, readCapturePicture, startBrowserSession, type ConfirmFields } from "@/lib/sourcing/browser-assist/session";
import { currentLauncher } from "@/lib/sourcing/browser-assist/launcher";
import { CASE_ID } from "@/lib/sourcing/ui/data";
import { evidenceResponse } from "@/lib/sourcing/ui/evidence";
import { IntakeProblem } from "@/lib/sourcing/ui/intake/intake";
import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";

export const runtime = "nodejs";

type Params = { params: Promise<{ caseId: string }> };

const STATUS: Record<AssistProblem["code"], number> = {
  invalid_request: 400,
  not_found: 404,
  unavailable: 409,
  busy: 409,
  not_open: 409,
  not_product: 422,
  duplicate: 409,
  limit: 409,
  pending_review: 409,
  browser_error: 502,
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Supervised Alibaba.com browser assistant (JSON): action = start | tabs |
 * capture | confirm | discard | close. Local only, same-origin. The person
 * searches Alibaba.com in the dedicated window; these actions only open and
 * close it, list its product tabs, capture one chosen tab for review, and add
 * a reviewed product to the product list.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = denyUnlessLocal(request, { mutation: true });
  if (denied) return denied;
  const { caseId } = await params;
  if (!CASE_ID.test(caseId)) return Response.json({ error: "invalid_case" }, { status: 400 });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return Response.json({ error: "invalid_request", message: "Expected JSON." }, { status: 415 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return Response.json({ error: "invalid_request", message: "Expected JSON." }, { status: 400 });
  }
  const paths = localPaths();
  const sessionId = str(body.sessionId) ?? "";
  try {
    switch (body.action) {
      case "start": {
        const { session, reused } = await startBrowserSession(paths, caseId, { launcher: currentLauncher(paths.root) });
        return Response.json({ ok: true, sessionId: session.sessionId, intakeId: session.intakeId, reused }, { status: reused ? 200 : 201 });
      }
      case "tabs":
        return Response.json({ ok: true, ...(await listOpenProducts(paths, caseId, sessionId)) });
      case "capture": {
        const capture = await captureProduct(paths, caseId, sessionId, str(body.targetId) ?? "");
        return Response.json({ ok: true, capture });
      }
      case "confirm": {
        const f = (body.fields ?? {}) as Record<string, unknown>;
        const fields: ConfirmFields = {
          title: str(f.title) ?? "",
          supplierName: str(f.supplierName),
          supplierProfileUrl: str(f.supplierProfileUrl),
          priceMin: str(f.priceMin),
          priceMax: str(f.priceMax),
          currency: str(f.currency),
          priceUnit: str(f.priceUnit),
          moqQuantity: str(f.moqQuantity),
          moqUnit: str(f.moqUnit),
          foundWith: str(f.foundWith),
          queryUsed: str(f.queryUsed),
          notes: str(f.notes),
        };
        const out = await confirmCapture(paths, caseId, sessionId, str(body.captureId) ?? "", fields, body.keepPhoto === true);
        return Response.json({ ok: true, ...out });
      }
      case "discard":
        await discardCapture(paths, caseId, sessionId, str(body.captureId) ?? "");
        return Response.json({ ok: true });
      case "close":
        await closeBrowserSession(paths, caseId, sessionId);
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "invalid_request", message: "Unsupported action." }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof AssistProblem) return Response.json({ error: error.code, message: error.message }, { status: STATUS[error.code] });
    if (error instanceof IntakeProblem) return Response.json({ error: error.code, message: error.message, field: error.field }, { status: error.code === "invalid_field" ? 422 : 409 });
    throw error;
  }
}

/** A captured picture awaiting review: ?session=<id>&capture=<id>. */
export async function GET(request: Request, { params }: Params) {
  const denied = denyUnlessLocal(request);
  if (denied) return denied;
  const { caseId } = await params;
  const url = new URL(request.url);
  const result = await readCapturePicture(localPaths(), caseId, url.searchParams.get("session") ?? "", url.searchParams.get("capture") ?? "");
  if (!result) return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return evidenceResponse(result);
}
