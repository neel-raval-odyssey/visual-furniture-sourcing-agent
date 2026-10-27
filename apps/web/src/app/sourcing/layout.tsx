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
          <Link href="/sourcing" className="font-serif text-xl text-ink">
            Visual Furniture Sourcing
          </Link>
          <div className="flex shrink-0 items-center gap-3">
            <Link href="/sourcing/workspace" className="hidden min-h-10 content-center text-xs text-muted underline-offset-4 hover:text-ink hover:underline sm:block">
              Advanced workspace
            </Link>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-paper px-3 py-1 text-xs text-muted">
              <Icon name="lock" className="h-3.5 w-3.5" />
              Private preview
            </span>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {!enabled ? (
          <div className="mx-auto max-w-2xl">
            <Notice tone="neutral" title="Local sourcing data is disabled">
              This preview reads private photographs, listings and model outputs and has no sign-in yet, so it only runs in local development. Start it with{" "}
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
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs text-muted sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:px-6 lg:px-8">
          <p>
            Similarity notes are automated judgements from photos, not proof of the same product or maker. Listing and supplier details are shown as listed on Alibaba.com and are not independently checked. Not affiliated with Alibaba.com.
          </p>
          <Link href="/sourcing/workspace" className="min-h-10 shrink-0 content-center underline-offset-4 hover:text-ink hover:underline sm:min-h-0">
            Advanced workspace
          </Link>
        </div>
      </footer>
    </div>
  );
}
