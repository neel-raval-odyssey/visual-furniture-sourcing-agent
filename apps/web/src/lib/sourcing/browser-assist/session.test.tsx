import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as browserGET, POST as browserPOST } from "../../../app/api/sourcing/browser/[caseId]/route";
import { BrowserAssistant } from "../../../components/sourcing/intake/browser-assistant";
import { PROVIDERS } from "../discovery/authorization";
import { candidateManifestSchema } from "../discovery/curated/manifest";
import { makePng } from "../verification/openai/test-fixtures";
import { getRun } from "../ui/data";
import { completeIntake, getIntakeState, publishedManifestPath, readSession } from "../ui/intake/intake";
import { analysedUploadReference, fakeSiglip } from "../ui/intake/test-fixtures";
import { startOfflineRun } from "../ui/offline-run";
import { localRequest, makeUiRepo } from "../ui/test-fixtures";
import { NulFramer, pipeConnection, type CdpConnection } from "./cdp";
import { ChromeDriver, profileDir, type BrowserDriver, type BrowserLauncher, type BrowserPage, type CapturedPicture } from "./chrome-driver";
import { setLauncherForTests } from "./launcher";
import {
  AssistProblem,
  browserAssistView,
  captureProduct,
  classifyPage,
  closeBrowserSession,
  confirmCapture,
  discardCapture,
  LIMITS,
  listBrowserSessions,
  listOpenProducts,
  readBrowserSession,
  resetActiveForTests,
  startBrowserSession,
  tidyTitle,
} from "./session";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

/** Product ids no real listing uses; titles marked [TEST]. */
const listing = (n: number, query = "") => `https://www.alibaba.com/product-detail/TEST-Nesting-Table-${n}_90000000000${n}.html${query}`;
const tab = (id: string, url: string, title = `[TEST] Nesting table ${id} - Buy Nesting Table Product on Alibaba.com`): BrowserPage => ({ targetId: id, url, title });

/** A stand-in for the dedicated Chrome window: no process, no network. */
function fakeBrowser(pages: BrowserPage[], picture: (targetId: string) => CapturedPicture | null = (id) => ({ bytes: new Uint8Array(makePng(320, 240, id.length * 7)), width: 320, height: 240 })) {
  const calls: string[] = [];
  let launches = 0;
  let open = false;
  const driver: BrowserDriver = {
    get open() {
      return open;
    },
    async listPages() {
      calls.push("listPages");
      return pages;
    },
    async captureMainPicture(targetId) {
      calls.push(`capture:${targetId}`);
      return picture(targetId);
    },
    async close() {
      calls.push("close");
      open = false;
    },
  };
  const launcher: BrowserLauncher & { launches: () => number; startUrls: string[] } = {
    startUrls: [],
    launches: () => launches,
    availability: () => ({ ok: true }),
    async launch(startUrl) {
      launches += 1;
      this.startUrls.push(startUrl);
      open = true;
      return driver;
    },
  };
  return { driver, launcher, calls, pages };
}

const fetchSpy = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let caseId: string;
let existingManifest: string;

beforeEach(async () => {
  resetActiveForTests();
  ctx = await makeUiRepo({ run: false });
  existingManifest = await readFile(join(ctx.paths.candidates, `${ctx.caseId}.json`), "utf8");
  ({ caseId } = await analysedUploadReference(ctx.paths));
  vi.stubGlobal("fetch", fetchSpy); // no Alibaba.com, Apify, Exa or OpenAI request may happen
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  setLauncherForTests(null);
  resetActiveForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(ctx.root, { recursive: true, force: true });
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof AssistProblem) return error.code;
    throw error;
  }
};

const fields = (n: number) => ({ title: `[TEST] Nesting table ${n}`, supplierName: "[TEST] Supplier One", priceMin: "120", priceMax: "150", currency: "usd", priceUnit: "set", moqQuantity: "2", moqUnit: "sets", notes: null });

describe("page addresses", () => {
  it("accepts only Alibaba.com product pages, without tracking parameters", () => {
    expect(classifyPage(listing(1, "?spm=a2700.galleryofferlist.0.0&s=p#gallery"))).toEqual({ kind: "product", listingUrl: listing(1), marketplaceProductId: "900000000001" });
    expect(classifyPage("https://www.alibaba.com/picture/search.htm?imageAddress=x").kind).toBe("alibaba_other");
    expect(classifyPage("https://www.alibaba.com/").kind).toBe("alibaba_other");
    for (const other of [
      "https://www.aliexpress.com/item/1005001234567890.html",
      "https://detail.1688.com/offer/900000000001.html",
      "https://www.alibaba.com.example.net/product-detail/x_900000000001.html",
      "http://www.alibaba.com/product-detail/x_900000000001.html",
      "chrome://newtab/",
      "not a url",
    ]) {
      expect(classifyPage(other).kind).toBe("other");
    }
  });

  it("recognises sign-in and check pages, so the person can deal with them", () => {
    expect(classifyPage("https://login.alibaba.com/newlogin/icbuLogin.htm").kind).toBe("needs_person");
    expect(classifyPage("https://passport.alibaba.com/ac/password_reset.htm").kind).toBe("needs_person");
    expect(classifyPage("https://www.alibaba.com/product-detail/x_900000000001.html/_____tmd_____/punish?x5secdata=abc").kind).toBe("needs_person");
  });

  it("tidies tab titles but never invents one", () => {
    expect(tidyTitle("[TEST] Oval Nesting Tables Set - Buy Nesting Tables,Coffee Table Product on Alibaba.com")).toBe("[TEST] Oval Nesting Tables Set");
    expect(tidyTitle("[TEST] Walnut Bed | Alibaba.com")).toBe("[TEST] Walnut Bed");
    expect(tidyTitle("   ")).toBeNull();
  });
});

describe("browser connection", () => {
  it("frames DevTools messages across arbitrary chunk boundaries", () => {
    const f = new NulFramer();
    expect(f.push('{"id":1}\0{"id"')).toEqual(['{"id":1}']);
    expect(f.push(':2}\0\0{"id":3}')).toEqual(['{"id":2}']);
    expect(f.push("\0")).toEqual(['{"id":3}']);
  });

  it("answers commands by id, reports refusals, and fails pending commands when the window closes", async () => {
    let onData: (c: string) => void = () => undefined;
    let onClose: () => void = () => undefined;
    const written: string[] = [];
    const cdp = pipeConnection({ write: (c) => written.push(c), onData: (l) => (onData = l), onClose: (l) => (onClose = l), end: () => undefined });
    const a = cdp.send("Target.getTargets");
    const b = cdp.send("Page.captureScreenshot", {}, "S1");
    expect(written.map((w) => JSON.parse(w.slice(0, -1)))).toEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      { id: 2, method: "Page.captureScreenshot", params: {}, sessionId: "S1" },
    ]);
    onData('{"method":"Target.targetCreated"}\0{"id":1,"result":{"targetInfos":[]}}\0{"id":2,"error":{"message":"No target"}}\0');
    await expect(a).resolves.toEqual({ targetInfos: [] });
    await expect(b).rejects.toThrow("No target");
    const c = cdp.send("Target.getTargets");
    onClose();
    await expect(c).rejects.toThrow("closed");
    await expect(cdp.send("Target.getTargets")).rejects.toThrow("closed");
  });

  it("sends only the read and screenshot commands it needs: no input, navigation, cookies or network", async () => {
    const sent: string[] = [];
    const replies: Record<string, unknown> = {
      "Target.getTargets": { targetInfos: [{ targetId: "T1", type: "page", url: listing(1), title: "t" }, { targetId: "W1", type: "service_worker", url: "https://www.alibaba.com/sw.js", title: "" }] },
      "Target.attachToTarget": { sessionId: "S1" },
      "Page.getFrameTree": { frameTree: { frame: { id: "F1" } } },
      "Page.createIsolatedWorld": { executionContextId: 7 },
      "Runtime.evaluate": { result: { value: { x: 10, y: 400, width: 500, height: 500 } } },
      "Page.captureScreenshot": { data: makePng(500, 500, 3).toString("base64") },
    };
    let closed = false;
    const cdp: CdpConnection = {
      get closed() {
        return closed;
      },
      async send<T>(method: string) {
        sent.push(method);
        return (replies[method] ?? {}) as T;
      },
      close: () => {
        closed = true;
      },
    };
    let killed = false;
    const driver = new ChromeDriver(cdp, () => (killed = true));
    expect(await driver.listPages()).toEqual([{ targetId: "T1", url: listing(1), title: "t" }]);
    const pic = await driver.captureMainPicture("T1");
    expect(pic).toMatchObject({ width: 500, height: 500 });
    await driver.close();
    expect(killed).toBe(true);
    const allowed = new Set(["Target.getTargets", "Target.activateTarget", "Target.attachToTarget", "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate", "Page.captureScreenshot", "Target.detachFromTarget", "Browser.close"]);
    expect(sent.filter((m) => !allowed.has(m))).toEqual([]);
    expect(sent.some((m) => /^(Input|Network|Storage|Fetch|DOM\.setFileInputFiles|Page\.navigate)/.test(m))).toBe(false);
  });

  it("keeps the browser profile (and any sign-in) outside the project", () => {
    expect(profileDir("/repo", { VFSA_BROWSER_PROFILE_DIR: "/repo/evals/local/profile" })).toMatchObject({ ok: false });
    expect(profileDir("/repo", { VFSA_BROWSER_PROFILE_DIR: "/repo" })).toMatchObject({ ok: false });
    expect(profileDir("/repo", { VFSA_BROWSER_PROFILE_DIR: "/elsewhere/profile" })).toEqual({ ok: true, dir: "/elsewhere/profile" });
    expect(profileDir("/repo", {})).toEqual({ ok: true, dir: join(homedir(), ".vfsa", "alibaba-browser-profile") });
  });
});

describe("supervised Alibaba.com session", () => {
  it("adds only products the person confirms, then the normal comparison runs on them", async () => {
    const b = fakeBrowser([
      tab("T1", listing(1, "?spm=tracking")),
      tab("T2", listing(1, "?other=1")), // the same product in a second tab
      tab("T3", listing(2)),
      tab("T4", "https://www.alibaba.com/picture/search.htm"),
      tab("T5", "https://login.alibaba.com/newlogin/icbuLogin.htm"),
    ]);
    const { session, reused } = await startBrowserSession(ctx.paths, caseId, { launcher: b.launcher });
    expect(reused).toBe(false);
    expect(b.launcher.startUrls).toEqual(["https://www.alibaba.com/"]);
    // A product-list draft was opened for the confirmed products.
    const state = await getIntakeState(ctx.paths, caseId);
    expect(state.draft?.intakeId).toBe(session.intakeId);
    // Opening again returns the same window.
    expect((await startBrowserSession(ctx.paths, caseId, { launcher: b.launcher })).reused).toBe(true);
    expect(b.launcher.launches()).toBe(1);

    const tabs = await listOpenProducts(ctx.paths, caseId, session.sessionId);
    expect(tabs.products.map((t) => [t.targetId, t.listingUrl, t.title, t.added])).toEqual([
      ["T1", listing(1), "[TEST] Nesting table T1", false],
      ["T3", listing(2), "[TEST] Nesting table T3", false],
    ]);
    expect(tabs).toMatchObject({ otherTabs: 2, needsPerson: true });
    expect(b.calls.filter((c) => c.startsWith("capture"))).toEqual([]); // listing tabs captures nothing

    const capture = await captureProduct(ctx.paths, caseId, session.sessionId, "T1");
    expect(capture).toMatchObject({ captureId: "c01", status: "pending", listingUrl: listing(1), marketplaceProductId: "900000000001", pageTitle: "[TEST] Nesting table T1", image: { width: 320, height: 240 } });
    const captureFile = join(ctx.paths.browserSessions, caseId, session.sessionId, capture.image!.file);
    expect(existsSync(captureFile)).toBe(true);
    // One product at a time; nothing is in the product list yet.
    expect(await code(captureProduct(ctx.paths, caseId, session.sessionId, "T3"))).toBe("pending_review");
    expect((await readSession(ctx.paths, caseId, session.intakeId))!.entries).toEqual([]);

    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "1");
    vi.stubEnv("VFSA_REPO_ROOT", ctx.root);
    const picture = await browserGET(localRequest(`/api/sourcing/browser/${caseId}?session=${session.sessionId}&capture=c01`), { params: Promise.resolve({ caseId }) });
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/png");

    const added = await confirmCapture(ctx.paths, caseId, session.sessionId, "c01", fields(1), true);
    expect(added).toEqual({ entryId: "p01", photoKept: true });
    const draft = (await readSession(ctx.paths, caseId, session.intakeId))!;
    expect(draft.entries).toHaveLength(1);
    const entry = draft.entries[0];
    expect(entry).toMatchObject({ listingUrl: listing(1), marketplaceProductId: "900000000001", title: "[TEST] Nesting table 1", supplierName: "[TEST] Supplier One", foundWith: "alibaba_image_search", price: { min: 120, max: 150, currency: "USD", unit: "set" }, minimumOrder: { quantity: 2, unit: "sets" } });
    expect(entry.image?.sha256).toBe(capture.image!.sha256);
    expect(entry.notes).toContain(`supervised browser assistant (session ${session.sessionId}, c01)`);
    expect(entry.notes).toContain("screenshot of the picture shown on that page, not a download");
    expect(existsSync(captureFile)).toBe(false); // the list keeps its own copy

    // The same product cannot be added twice, from any tab.
    expect((await listOpenProducts(ctx.paths, caseId, session.sessionId)).products.find((t) => t.targetId === "T1")?.added).toBe(true);
    b.pages.push(tab("T6", listing(1, "?again=1")));
    expect(await code(captureProduct(ctx.paths, caseId, session.sessionId, "T6"))).toBe("duplicate");
    // Non-product tabs and vanished tabs are refused.
    expect(await code(captureProduct(ctx.paths, caseId, session.sessionId, "T4"))).toBe("not_product");
    expect(await code(captureProduct(ctx.paths, caseId, session.sessionId, "T9"))).toBe("not_found");

    // A product whose picture is not on screen can be added without a photo, or discarded.
    const noPicture = fakeBrowser([], () => null);
    b.driver.captureMainPicture = noPicture.driver.captureMainPicture;
    const second = await captureProduct(ctx.paths, caseId, session.sessionId, "T3");
    expect(second).toMatchObject({ image: null, imageProblem: expect.stringContaining("No product picture was visible") });
    await discardCapture(ctx.paths, caseId, session.sessionId, second.captureId);
    expect((await readSession(ctx.paths, caseId, session.intakeId))!.entries).toHaveLength(1);

    await closeBrowserSession(ctx.paths, caseId, session.sessionId);
    expect(b.calls).toContain("close");
    const journal = (await readBrowserSession(ctx.paths, caseId, session.sessionId))!;
    expect(journal.status).toBe("closed");
    expect(journal.actions.map((a) => a.kind)).toEqual(["opened", "captured", "capture_refused", "confirmed", "capture_refused", "capture_refused", "capture_refused", "captured", "discarded", "closed"]);
    const text = await readFile(join(ctx.paths.browserSessions, caseId, session.sessionId, "session.json"), "utf8");
    expect(text).not.toMatch(/cookie|password|token|alibaba-browser-profile|user-data-dir/i);
    expect(await readdir(join(ctx.paths.browserSessions, caseId, session.sessionId, "captures"))).toEqual([]);
    expect(await code(listOpenProducts(ctx.paths, caseId, session.sessionId))).toBe("not_open");

    // The confirmed product goes through the existing list and comparison, unchanged.
    const { summary } = await completeIntake(ctx.paths, caseId, session.intakeId);
    expect(summary).toMatchObject({ products: 1, withImage: 1 });
    const manifest = candidateManifestSchema.parse(JSON.parse(await readFile(publishedManifestPath(ctx.paths, caseId), "utf8")));
    expect(manifest.capture).toMatchObject({ method: "operator_assisted", tools: ["alibaba_image_search"] });
    expect(manifest.candidates[0]).toMatchObject({ listingUrl: listing(1), marketplaceProductId: "900000000001" });
    const siglip = fakeSiglip();
    const outcome = await startOfflineRun(ctx.paths, caseId, { runner: siglip });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(siglip.requests).toHaveLength(1);
    const run = await getRun(ctx.paths, caseId, outcome.runId);
    expect(run!.result!.counts.shortlisted).toBe(1);
    expect(run!.result!.counts.verified).toBe(0); // Sol is never started by this workflow
  });

  it("adds to a new version of an existing product list, leaving the saved list unchanged", async () => {
    const b = fakeBrowser([tab("T1", listing(7))]);
    const { session } = await startBrowserSession(ctx.paths, ctx.caseId, { launcher: b.launcher });
    const draft = (await readSession(ctx.paths, ctx.caseId, session.intakeId))!;
    expect(draft.basedOn).toBeTruthy();
    const before = draft.entries.length;
    await captureProduct(ctx.paths, ctx.caseId, session.sessionId, "T1");
    await confirmCapture(ctx.paths, ctx.caseId, session.sessionId, "c01", fields(7), true);
    expect((await readSession(ctx.paths, ctx.caseId, session.intakeId))!.entries).toHaveLength(before + 1);
    expect(await readFile(join(ctx.paths.candidates, `${ctx.caseId}.json`), "utf8")).toBe(existingManifest);
    await closeBrowserSession(ctx.paths, ctx.caseId, session.sessionId);
  });

  it("keeps field mistakes with the person: the product waits for correction", async () => {
    const b = fakeBrowser([tab("T1", listing(1))]);
    const { session } = await startBrowserSession(ctx.paths, caseId, { launcher: b.launcher });
    await captureProduct(ctx.paths, caseId, session.sessionId, "T1");
    await expect(confirmCapture(ctx.paths, caseId, session.sessionId, "c01", { ...fields(1), title: "  " }, true)).rejects.toMatchObject({ code: "invalid_field", field: "title" });
    expect((await readBrowserSession(ctx.paths, caseId, session.sessionId))!.captures[0].status).toBe("pending");
    expect((await confirmCapture(ctx.paths, caseId, session.sessionId, "c01", fields(1), false)).photoKept).toBe(false);
    expect((await readSession(ctx.paths, caseId, session.intakeId))!.entries[0].image).toBeNull();
  });

  it("refuses a capture whose picture changed on disk before confirmation", async () => {
    const b = fakeBrowser([tab("T1", listing(1))]);
    const { session } = await startBrowserSession(ctx.paths, caseId, { launcher: b.launcher });
    const c = await captureProduct(ctx.paths, caseId, session.sessionId, "T1");
    await writeFile(join(ctx.paths.browserSessions, caseId, session.sessionId, c.image!.file), makePng(320, 240, 99));
    expect(await code(confirmCapture(ctx.paths, caseId, session.sessionId, "c01", fields(1), true))).toBe("not_found");
    expect((await readSession(ctx.paths, caseId, session.intakeId))!.entries).toEqual([]);
  });

  it("stops at the product limit", async () => {
    const pages = Array.from({ length: LIMITS.maxCaptures + 1 }, (_, i) => tab(`T${i + 1}`, `https://www.alibaba.com/product-detail/TEST-Item_8${String(i + 1).padStart(11, "0")}.html`));
    const b = fakeBrowser(pages, () => null);
    const { session } = await startBrowserSession(ctx.paths, caseId, { launcher: b.launcher });
    for (let i = 1; i <= LIMITS.maxCaptures; i++) {
      const c = await captureProduct(ctx.paths, caseId, session.sessionId, `T${i}`);
      await confirmCapture(ctx.paths, caseId, session.sessionId, c.captureId, fields(i), false);
    }
    expect(await code(captureProduct(ctx.paths, caseId, session.sessionId, `T${LIMITS.maxCaptures + 1}`))).toBe("limit");
  });

  it("allows one window at a time and settles a window lost with a server restart", async () => {
    const b = fakeBrowser([tab("T1", listing(1))]);
    const { session } = await startBrowserSession(ctx.paths, caseId, { launcher: b.launcher });
    expect(await code(startBrowserSession(ctx.paths, ctx.caseId, { launcher: b.launcher }))).toBe("busy");
    const c = await captureProduct(ctx.paths, caseId, session.sessionId, "T1");
    resetActiveForTests(); // the server restarted; the window handle is gone
    expect(await code(captureProduct(ctx.paths, caseId, session.sessionId, "T1"))).toBe("not_open");
    const again = await startBrowserSession(ctx.paths, caseId, { launcher: b.launcher });
    expect(again.session.sessionId).not.toBe(session.sessionId);
    expect(again.session.intakeId).toBe(session.intakeId); // same product list
    const old = (await readBrowserSession(ctx.paths, caseId, session.sessionId))!;
    expect(old.status).toBe("interrupted");
    expect(old.captures[0].status).toBe("discarded");
    expect(existsSync(join(ctx.paths.browserSessions, caseId, session.sessionId, c.image!.file))).toBe(false);
  });

  it("reports an unavailable or failed browser honestly", async () => {
    const unavailable: BrowserLauncher = { availability: () => ({ ok: false, reason: "Google Chrome was not found on this computer." }), launch: vi.fn() };
    expect(await code(startBrowserSession(ctx.paths, caseId, { launcher: unavailable }))).toBe("unavailable");
    expect(unavailable.launch).not.toHaveBeenCalled();
    const failing: BrowserLauncher = { availability: () => ({ ok: true }), launch: async () => Promise.reject(new Error("profile in use")) };
    expect(await code(startBrowserSession(ctx.paths, caseId, { launcher: failing }))).toBe("browser_error");
    const [journal] = await listBrowserSessions(ctx.paths, caseId);
    expect(journal).toMatchObject({ status: "failed", actions: [{ kind: "open_failed", detail: "profile in use" }] });
    // A synthetic or unanalysed photo is refused before any window opens.
    expect(await code(startBrowserSession(ctx.paths, "no-such-photo", { launcher: failing }))).toBe("unavailable");
  });

  it("is not a marketplace provider: the automatic-search authorization gate is unchanged", () => {
    expect(Object.keys(PROVIDERS).some((k) => /browser|cua/i.test(k))).toBe(false);
  });
});

describe("browser route and panel", () => {
  const post = (body: unknown, init: { origin?: string | null; host?: string } = {}) =>
    browserPOST(localRequest(`/api/sourcing/browser/${caseId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init }), { params: Promise.resolve({ caseId }) });

  it("answers only same-origin local requests", async () => {
    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "1");
    const b = fakeBrowser([tab("T1", listing(1))]);
    setLauncherForTests(b.launcher);
    expect((await post({ action: "start" }, { host: "sourcing.example.com" })).status).toBe(403);
    expect((await post({ action: "start" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ action: "start" }, { origin: null })).status).toBe(403);
    expect(b.launcher.launches()).toBe(0);
    const res = await browserPOST(localRequest(`/api/sourcing/browser/${caseId}`, { method: "POST", body: "action=start" }), { params: Promise.resolve({ caseId }) });
    expect(res.status).toBe(415);
  });

  it("runs the whole review through the route, ignoring any address sent by the page", async () => {
    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "1");
    vi.stubEnv("VFSA_REPO_ROOT", ctx.root);
    const b = fakeBrowser([tab("T1", listing(1))]);
    setLauncherForTests(b.launcher);
    const started = await post({ action: "start" });
    expect(started.status).toBe(201);
    const { sessionId, intakeId } = (await started.json()) as { sessionId: string; intakeId: string };
    const tabs = (await (await post({ action: "tabs", sessionId })).json()) as { products: { targetId: string }[] };
    expect(tabs.products).toHaveLength(1);
    expect((await post({ action: "capture", sessionId, targetId: "T1" })).status).toBe(200);
    const confirmed = await post({ action: "confirm", sessionId, captureId: "c01", keepPhoto: true, fields: { ...fields(1), listingUrl: "https://www.alibaba.com/product-detail/Other_900000000099.html" } });
    expect(confirmed.status).toBe(200);
    expect((await readSession(ctx.paths, caseId, intakeId))!.entries[0].listingUrl).toBe(listing(1));
    expect((await post({ action: "capture", sessionId, targetId: "T1" })).status).toBe(409);
    expect((await post({ action: "close", sessionId })).status).toBe(200);
    expect((await post({ action: "tabs", sessionId })).status).toBe(409);
  });

  it("explains who does what, and never offers a window it cannot open", async () => {
    const closed = renderToStaticMarkup(<BrowserAssistant caseId={caseId} photoPath="/photos/ref.png" view={{ available: true, unavailableReason: null, session: null, busyElsewhere: false }} />);
    expect(closed).toContain("Open Alibaba.com in a separate window");
    expect(closed).toContain("This app never clicks, types or scrolls on Alibaba.com, and keeps nothing until you confirm each product.");
    const missing = renderToStaticMarkup(<BrowserAssistant caseId={caseId} photoPath={null} view={{ available: false, unavailableReason: "Google Chrome was not found on this computer.", session: null, busyElsewhere: false }} />);
    expect(missing).toContain("Google Chrome was not found");
    expect(missing).not.toContain("Open Alibaba.com in a separate window");
    const b = fakeBrowser([]);
    const { session } = await startBrowserSession(ctx.paths, caseId, { launcher: b.launcher });
    const view = await browserAssistView(ctx.paths, caseId, b.launcher);
    expect(view.session?.sessionId).toBe(session.sessionId);
    const open = renderToStaticMarkup(<BrowserAssistant caseId={caseId} photoPath="/photos/ref.png" view={view} />);
    expect(open).toContain("Check open product pages");
    expect(open).toContain("/photos/ref.png");
    expect((await browserAssistView(ctx.paths, ctx.caseId, b.launcher)).busyElsewhere).toBe(true);
  });
});
