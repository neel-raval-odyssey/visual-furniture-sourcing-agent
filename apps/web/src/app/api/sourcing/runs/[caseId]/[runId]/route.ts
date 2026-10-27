import { getRun } from "@/lib/sourcing/ui/data";
import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";

export const runtime = "nodejs";

/** Run status for bounded polling: stage states only, from the run journal. */
export async function GET(request: Request, ctx: { params: Promise<{ caseId: string; runId: string }> }) {
  const denied = denyUnlessLocal(request);
  if (denied) return denied;
  const { caseId, runId } = await ctx.params;
  const run = await getRun(localPaths(), caseId, runId);
  if (!run) return Response.json({ error: "not_found", message: "No such run" }, { status: 404 });
  return Response.json(
    { status: run.summary.status, updatedAt: run.summary.updatedAt, stages: run.stages.map((s) => ({ name: s.name, state: s.state })), resultAvailable: run.result !== null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
