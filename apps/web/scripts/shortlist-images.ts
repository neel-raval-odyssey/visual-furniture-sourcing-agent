/**
 * Visual shortlist with local SigLIP 2 embeddings: `pnpm shortlist:images`.
 * Reads local files and runs the Python component in services/vision; it does
 * not load env files, contact any service or download model weights.
 */
import { resolve } from "node:path";
import { runShortlistImagesCli } from "../src/lib/sourcing/cli/shortlist-images";

runShortlistImagesCli(process.argv.slice(2), {
  // pnpm runs workspace scripts from apps/web; resolve paths from where the user ran pnpm.
  cwd: process.env.INIT_CWD ?? process.cwd(),
  repoRoot: resolve(__dirname, "../../.."),
  io: { out: (line) => console.log(line), err: (line) => console.error(line) },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Unexpected failure: ${error instanceof Error ? error.name : "unknown error"}`);
    process.exitCode = 1;
  },
);
