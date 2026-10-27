import { headers } from "next/headers";
import { connection } from "next/server";
import { isLoopbackHost, localSourcingEnabled } from "./local-access";

/**
 * For pages: true only when local sourcing is enabled and the request uses a
 * loopback host. Pages check this themselves before reading any record (the
 * layout shows the explanation), so no private data is loaded otherwise.
 */
export async function localPageAllowed(): Promise<boolean> {
  await connection();
  return localSourcingEnabled() && isLoopbackHost((await headers()).get("host"));
}
