import { evidenceResponse, resolveEvidence } from "@/lib/sourcing/ui/evidence";
import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";

export const runtime = "nodejs";

/** Local-only image evidence, resolved through trusted sourcing records (never a path from the URL). */
export async function GET(request: Request, ctx: { params: Promise<{ parts: string[] }> }) {
  const denied = denyUnlessLocal(request);
  if (denied) return denied;
  const { parts } = await ctx.params;
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return Response.json({ error: "invalid_evidence_id", message: "Unknown evidence id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  return evidenceResponse(await resolveEvidence(localPaths(), decoded));
}
