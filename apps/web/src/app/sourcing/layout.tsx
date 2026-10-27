import Link from "next/link";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Icon, Notice } from "@/components/sourcing/primitives";
import { isLoopbackHost, LOCAL_UI_FLAG, localSourcingEnabled } from "@/lib/sourcing/ui/local-access";

/**
 * Shell of the local sourcing experience. Private records are only rendered
 * when local sourcing is enabled and the request arrives on a loopback host.
 */
export default async function SourcingLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const host = (await headers()).get("host");
  const enabled = localSourcingEnabled();
  const local = isLoopbackHost(host);

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-paper focus:px-4 focus:py-2 focus:shadow">
        Skip to content
      </a>
      <header className="border-b border-line bg-ivory/90 backdrop-blur supports-[backdrop-filter]:bg-ivory/75">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/sourcing" className="flex items-baseline gap-2">
            <span className="font-serif text-xl text-ink">Visual Furniture Sourcing</span>
            <span className="hidden text-xs font-medium uppercase tracking-[0.14em] text-muted sm:inline">Workspace</span>
          </Link>
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-paper px-3 py-1 text-xs text-muted">
            <Icon name="lock" className="h-3.5 w-3.5" />
            Local · offline
          </span>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {!enabled ? (
          <div className="mx-auto max-w-2xl">
            <Notice tone="neutral" title="Local sourcing data is disabled">
              This workspace reads private photographs, listings and model outputs and has no sign-in yet, so it only runs in local development. Start it with{" "}
              <code className="rounded bg-sand px-1">{LOCAL_UI_FLAG}=1</code> using <code className="rounded bg-sand px-1">pnpm dev:local</code>. It is never served by a production build.
            </Notice>
          </div>
        ) : !local ? (
          <div className="mx-auto max-w-2xl">
            <Notice tone="bad" title="Not available on this address">
              Private sourcing data is only served to this computer (localhost). Open it at http://localhost:3000.
            </Notice>
          </div>
        ) : (
          children
        )}
      </main>
      <footer className="border-t border-line">
        <p className="mx-auto max-w-7xl px-4 py-6 text-xs text-muted sm:px-6 lg:px-8">
          Design assessments are model judgements, not manufacturer or product identity. Listing and supplier details are as reported by the marketplace and are not independently verified. Not affiliated with Alibaba.com.
        </p>
      </footer>
    </div>
  );
}
