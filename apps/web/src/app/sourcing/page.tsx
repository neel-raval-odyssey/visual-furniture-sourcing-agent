import { SimpleStart } from "@/components/sourcing/simple/start";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";
import { getFeaturedExample } from "@/lib/sourcing/ui/simple";

export default async function SourcingStart() {
  if (!(await localPageAllowed())) return null;
  return <SimpleStart example={await getFeaturedExample(localPaths())} />;
}
