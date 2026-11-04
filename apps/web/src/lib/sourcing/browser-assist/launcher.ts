import { chromeLauncher, type BrowserLauncher } from "./chrome-driver";

const KEY = Symbol.for("vfsa.browserAssist.launcher");
type Holder = { [KEY]?: BrowserLauncher | null };

/** The launcher the routes and pages use: real Chrome, unless a test replaced it. */
export function currentLauncher(repoRoot: string): BrowserLauncher {
  return (globalThis as Holder)[KEY] ?? chromeLauncher(repoRoot);
}

/** TEST-ONLY: substitute a fake browser (null restores the real one). */
export function setLauncherForTests(launcher: BrowserLauncher | null) {
  (globalThis as Holder)[KEY] = launcher;
}
