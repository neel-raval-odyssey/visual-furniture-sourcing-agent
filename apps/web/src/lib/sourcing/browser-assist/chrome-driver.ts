import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpError, pipeConnection, type CdpConnection } from "./cdp";

/**
 * The dedicated, visible Chrome window used by the supervised browser
 * assistant, and the only things the application ever does with it:
 *
 * - open it on Alibaba.com's home page when the person asks;
 * - list the addresses and titles of its open tabs (browser metadata, no
 *   page content and no network request);
 * - on the person's explicit "Add this product" for one tab, find the largest
 *   picture currently shown on screen in that tab and take a screenshot of
 *   that area (rendered pixels; nothing is downloaded);
 * - close it.
 *
 * It never clicks, types, scrolls, navigates, uploads or reads cookies on
 * Alibaba.com. The person does all searching, signing in and browsing.
 * Chrome is started without automation flags and nothing tries to hide that
 * a debugging connection exists; if Alibaba.com asks for a check, the person
 * answers it.
 *
 * The browser profile (and therefore any sign-in) lives outside the project,
 * in a folder only this window uses; its location and contents are never
 * written to project records.
 */

export interface BrowserPage {
  targetId: string;
  url: string;
  title: string;
}

export interface CapturedPicture {
  bytes: Uint8Array;
  /** The on-screen area that was captured, in CSS pixels. */
  width: number;
  height: number;
}

export interface BrowserDriver {
  readonly open: boolean;
  listPages(): Promise<BrowserPage[]>;
  /** Screenshot of the largest picture visible in the tab's current view, or null when none is shown. */
  captureMainPicture(targetId: string): Promise<CapturedPicture | null>;
  close(): Promise<void>;
}

export type Availability = { ok: true } | { ok: false; reason: string };

export interface BrowserLauncher {
  availability(): Availability;
  launch(startUrl: string): Promise<BrowserDriver>;
}

export const ALIBABA_HOME = "https://www.alibaba.com/";

const CHROME_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
};

export function findChrome(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string | null {
  if (env.VFSA_CHROME_PATH) return existsSync(env.VFSA_CHROME_PATH) ? env.VFSA_CHROME_PATH : null;
  return (CHROME_PATHS[platform] ?? []).find((p) => existsSync(p)) ?? null;
}

/** The dedicated profile folder: outside the project, so cookies can never end up in project files. */
export function profileDir(repoRoot: string, env: Record<string, string | undefined> = process.env): { ok: true; dir: string } | { ok: false; reason: string } {
  const dir = env.VFSA_BROWSER_PROFILE_DIR ? resolve(env.VFSA_BROWSER_PROFILE_DIR) : join(homedir(), ".vfsa", "alibaba-browser-profile");
  const rel = relative(resolve(repoRoot), dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return { ok: false, reason: "The browser profile folder must be outside the project, so sign-in data never enters project files." };
  }
  return { ok: true, dir };
}

/** Runs inside an isolated script world of the page: reads only picture positions, changes nothing. */
const LARGEST_VISIBLE_PICTURE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  let best = null;
  for (const img of document.images) {
    if (!img.complete || img.naturalWidth < 200 || img.naturalHeight < 200) continue;
    const s = getComputedStyle(img);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
    const r = img.getBoundingClientRect();
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const w = Math.min(vw, r.right) - x, h = Math.min(vh, r.bottom) - y;
    if (w < 150 || h < 150) continue;
    if (!best || w * h > best.w * best.h) best = { x, y, w, h };
  }
  if (!best) return null;
  const v = window.visualViewport;
  return { x: best.x + (v ? v.pageLeft : scrollX), y: best.y + (v ? v.pageTop : scrollY), width: Math.floor(best.w), height: Math.floor(best.h) };
})()`;

export class ChromeDriver implements BrowserDriver {
  constructor(
    private readonly cdp: CdpConnection,
    private readonly kill: () => void,
  ) {}

  get open() {
    return !this.cdp.closed;
  }

  async listPages(): Promise<BrowserPage[]> {
    const { targetInfos } = await this.cdp.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page").map((t) => ({ targetId: t.targetId, url: t.url, title: t.title }));
  }

  async captureMainPicture(targetId: string): Promise<CapturedPicture | null> {
    // Show the chosen tab in the dedicated window: a hidden tab is not painted, so it cannot be captured.
    await this.cdp.send("Target.activateTarget", { targetId });
    const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    try {
      const { frameTree } = await this.cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId);
      const { executionContextId } = await this.cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "vfsa-picture-locator", grantUniveralAccess: false }, sessionId);
      const evaluated = await this.cdp.send<{ result: { value?: { x: number; y: number; width: number; height: number } | null } }>(
        "Runtime.evaluate",
        { expression: LARGEST_VISIBLE_PICTURE, contextId: executionContextId, returnByValue: true },
        sessionId,
      );
      const area = evaluated.result.value;
      if (!area) return null;
      const shot = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...area, scale: 1 } }, sessionId, 20_000);
      return { bytes: new Uint8Array(Buffer.from(shot.data, "base64")), width: area.width, height: area.height };
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.open) return;
    await this.cdp.send("Browser.close", {}, undefined, 5_000).catch(() => undefined);
    this.cdp.close();
    this.kill();
  }
}

export function chromeLauncher(repoRoot: string, env: Record<string, string | undefined> = process.env): BrowserLauncher {
  return {
    availability() {
      if (!findChrome(env)) return { ok: false, reason: "Google Chrome was not found on this computer (set VFSA_CHROME_PATH to its location)." };
      const profile = profileDir(repoRoot, env);
      return profile.ok ? { ok: true } : profile;
    },
    async launch(startUrl: string) {
      const chrome = findChrome(env);
      const profile = profileDir(repoRoot, env);
      if (!chrome) throw new CdpError("Google Chrome was not found on this computer.");
      if (!profile.ok) throw new CdpError(profile.reason);
      await mkdir(/* turbopackIgnore: true */ profile.dir, { recursive: true, mode: 0o700 }); // outside the project by design
      const child = spawn(/* turbopackIgnore: true */ chrome, ["--remote-debugging-pipe", `--user-data-dir=${profile.dir}`, "--no-first-run", "--no-default-browser-check", "--new-window", startUrl], {
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
        detached: false,
      });
      const toChrome = child.stdio[3] as Writable;
      const fromChrome = child.stdio[4] as Readable;
      const cdp = pipeConnection({
        write: (chunk) => toChrome.write(chunk),
        onData: (listener) => fromChrome.on("data", listener),
        onClose: (listener) => {
          child.once("exit", listener);
          fromChrome.once("close", listener);
        },
        end: () => toChrome.end(),
      });
      child.once("error", () => cdp.close());
      const driver = new ChromeDriver(cdp, () => {
        if (child.exitCode === null) child.kill();
      });
      try {
        await cdp.send("Browser.getVersion", {}, undefined, 20_000);
      } catch (error) {
        await driver.close();
        throw error;
      }
      return driver;
    },
  };
}
