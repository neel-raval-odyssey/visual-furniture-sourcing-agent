import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SimpleResultsView } from "@/components/sourcing/simple/results";
import { getRun } from "@/lib/sourcing/ui/data";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";

export const metadata: Metadata = { title: "Similar furniture" };

export default async function SimpleResultsPage({ params }: { params: Promise<{ caseId: string; runId: string }> }) {
  if (!(await localPageAllowed())) return null;
  const { caseId, runId } = await params;
  const run = await getRun(localPaths(), caseId, runId);
  if (!run) notFound();
  return <SimpleResultsView caseId={caseId} runId={runId} result={run.result} />;
}
