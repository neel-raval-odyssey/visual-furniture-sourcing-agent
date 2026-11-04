import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { candidateIdentity } from "../discovery/curated/manifest";
import { checkMarketplaceUrl, productIdFromListingUrl } from "../discovery/curated/marketplace-urls";
import { writeExclusive, writeReplace } from "../ui/analysis/attempts";
import { withFileLock } from "../ui/analysis/register";
import { CASE_ID, type Paths } from "../ui/data";
import { readConfined } from "../ui/evidence";
import { getIntakeState, IntakeProblem, loadIntakeReference, MAX_ENTRIES, readSession, saveEntry, startIntake, validateProductImage, type EntryInput } from "../ui/intake/intake";
import { startRevision } from "../ui/intake/revision";
import { ALIBABA_HOME, type BrowserDriver, type BrowserLauncher } from "./chrome-driver";

/**
 * Supervised Alibaba.com browser assistant.
 *
 * The person searches Alibaba.com themselves in a dedicated, visible Chrome
 * window (native camera/image search with their photo, sign-in, any checks
 * Alibaba.com shows). The application only:
 *
 * 1. opens that window when asked;
 * 2. lists which of its tabs are Alibaba.com product pages;
 * 3. when the person presses "Add this product" for one tab, records that
 *    tab's address and a screenshot of the main picture on screen, as a
 *    capture awaiting review (one at a time);
 * 4. after the person checks the details and confirms, adds it to the
 *    existing product-list draft (operator-assisted intake), from which the
 *    usual comparison (SigLIP 2, then Sol) runs.
 *
 * Nothing is retained without confirmation: discarded or unreviewed captures
 * are deleted. Every action is recorded in a journal under
 * evals/local/browser-sessions/<case>/<session>/ (git-ignored), with no
 * cookies, passwords or profile location. Prices, MOQ and supplier details are
 * typed or checked by the person; the page text is not read.
 */

export const LIMITS = {
  /** Products that can be added in one session (the product list holds the same number). */
  maxCaptures: MAX_ENTRIES,
  /** Journaled actions per session (captures, confirmations, discards, failures). */
  maxActions: 120,
  /** Captures awaiting review: one at a time, so each product is confirmed individually. */
  maxPending: 1,
} as const;

export const SESSION_ID = /^bs-[0-9tz-]+-[0-9a-f]{8}$/;
const CAPTURE_ID = /^c\d{2}$/;

const actionSchema = z.strictObject({
  at: z.string(),
  kind: z.enum(["opened", "open_failed", "captured", "capture_refused", "confirmed", "discarded", "closed", "interrupted"]),
  captureId: z.string().nullable(),
  detail: z.string().max(300).nullable(),
});

const captureSchema = z.strictObject({
  captureId: z.string().regex(CAPTURE_ID),
  capturedAt: z.string(),
  status: z.enum(["pending", "added", "discarded"]),
  listingUrl: z.string(),
  marketplaceProductId: z.string().nullable(),
  /** The tab title as the browser reported it, tidied; a suggestion the person confirms or edits. */
  pageTitle: z.string().max(300).nullable(),
  /** Screenshot of the main picture shown on the page; deleted once added (the product list keeps its own copy) or discarded. */
  image: z.strictObject({ file: z.string().regex(/^captures\/c\d{2}\.png$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.int().positive(), width: z.int().positive(), height: z.int().positive() }).nullable(),
  imageProblem: z.string().max(200).nullable(),
  /** Set once added to the product list. */
  entryId: z.string().nullable(),
  photoKept: z.boolean().nullable(),
});

export const browserSessionSchema = z.strictObject({
  recordType: z.literal("supervised_browser_session"),
  schemaVersion: z.literal(1),
  sessionId: z.string().regex(SESSION_ID),
  caseId: z.string().regex(CASE_ID),
  /** The product-list draft that confirmed products are added to. */
  intakeId: z.string(),
  referenceSha256: z.string(),
  site: z.literal("alibaba.com"),
  browser: z.literal("dedicated_visible_chrome_window"),
  status: z.enum(["open", "closed", "interrupted", "failed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  limits: z.strictObject({ maxCaptures: z.int(), maxActions: z.int(), maxPending: z.int() }),
  actions: z.array(actionSchema),
  captures: z.array(captureSchema),
});
export type BrowserSession = z.output<typeof browserSessionSchema>;
export type BrowserCapture = z.output<typeof captureSchema>;

export type AssistProblemCode = "invalid_request" | "not_found" | "unavailable" | "busy" | "not_open" | "not_product" | "duplicate" | "limit" | "pending_review" | "browser_error";

export class AssistProblem extends Error {
  constructor(
    readonly code: AssistProblemCode,
    message: string,
  ) {
    super(message);
    this.name = "AssistProblem";
  }
}

// ---------------------------------------------------------------- pages

export type PageKind =
  | { kind: "product"; listingUrl: string; marketplaceProductId: string }
  /** Alibaba.com is asking the person to sign in or complete a check: the assistant waits for them. */
  | { kind: "needs_person" }
  | { kind: "alibaba_other" }
  | { kind: "other" };

/** Classifies a tab address offline (parsed, never fetched). Product addresses lose tracking parameters. */
export function classifyPage(value: string): PageKind {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "other" };
  }
  if (checkMarketplaceUrl(value, "listing", "live") !== null) return { kind: "other" };
  const host = url.hostname.toLowerCase();
  if (/^(login|passport|accounts)\./.test(host) || /\/(punish|newlogin|login)\b/i.test(url.pathname) || url.searchParams.has("x5secdata")) return { kind: "needs_person" };
  const listingUrl = `https://${host}${url.pathname}`;
  const id = productIdFromListingUrl(listingUrl);
  return id ? { kind: "product", listingUrl, marketplaceProductId: id } : { kind: "alibaba_other" };
}

/** Removes the marketplace's own suffixes from a tab title ("… - Buy … Product on Alibaba.com"). */
export function tidyTitle(title: string): string | null {
  const t = title
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*Buy\s.*\sProduct on Alibaba\.com\s*$/i, "")
    .replace(/\s*[-|–]\s*Alibaba\.com\s*$/i, "")
    .trim();
  return t ? t.slice(0, 300) : null;
}

// ---------------------------------------------------------------- live window registry

interface Active {
  caseId: string;
  sessionId: string;
  driver: BrowserDriver;
}
const REGISTRY = Symbol.for("vfsa.browserAssist.active");
type Holder = { [REGISTRY]?: Active | null };
const holder = globalThis as Holder;
const active = () => {
  const a = holder[REGISTRY] ?? null;
  return a && a.driver.open ? a : null;
};
/** TEST-ONLY: forget the open window without closing it. */
export const resetActiveForTests = () => {
  holder[REGISTRY] = null;
};

// ---------------------------------------------------------------- journal

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const caseFolder = (paths: Paths, caseId: string) => join(paths.browserSessions, caseId);
export const sessionFolder = (paths: Paths, caseId: string, sessionId: string) => join(caseFolder(paths, caseId), sessionId);
const journalFile = (paths: Paths, caseId: string, sessionId: string) => join(sessionFolder(paths, caseId, sessionId), "session.json");
const newSessionId = (now: Date) => `bs-${now.toISOString().toLowerCase().replace(/[:.]/g, "-").replace(/-\d{3}z$/, "z")}-${randomUUID().slice(0, 8)}`;

export async function readBrowserSession(paths: Paths, caseId: string, sessionId: string): Promise<BrowserSession | null> {
  if (!CASE_ID.test(caseId) || !SESSION_ID.test(sessionId)) return null;
  try {
    const parsed = browserSessionSchema.safeParse(JSON.parse(await readFile(journalFile(paths, caseId, sessionId), "utf8")));
    return parsed.success && parsed.data.caseId === caseId && parsed.data.sessionId === sessionId ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function listBrowserSessions(paths: Paths, caseId: string): Promise<BrowserSession[]> {
  if (!CASE_ID.test(caseId)) return [];
  const names = (await readdir(caseFolder(paths, caseId)).catch(() => [] as string[])).filter((n) => SESSION_ID.test(n));
  const sessions = (await Promise.all(names.map((n) => readBrowserSession(paths, caseId, n)))).filter((s): s is BrowserSession => s !== null);
  return sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function mutate<T>(paths: Paths, caseId: string, sessionId: string, now: Date, change: (s: BrowserSession) => Promise<T>): Promise<{ session: BrowserSession; result: T }> {
  const file = journalFile(paths, caseId, sessionId);
  return withFileLock(file, async () => {
    const session = await readBrowserSession(paths, caseId, sessionId);
    if (!session) throw new AssistProblem("not_found", "This browser session doesn't exist.");
    const result = await change(session);
    const next = browserSessionSchema.parse({ ...session, updatedAt: now.toISOString() });
    await writeReplace(file, json(next));
    return { session: next, result };
  });
}

const act = (s: BrowserSession, now: Date, kind: BrowserSession["actions"][number]["kind"], captureId: string | null = null, detail: string | null = null) => {
  s.actions.push({ at: now.toISOString(), kind, captureId, detail: detail?.slice(0, 300) ?? null });
};

/** Deletes captures nobody confirmed; they were never retained. */
async function dropPending(paths: Paths, s: BrowserSession) {
  for (const c of s.captures.filter((x) => x.status === "pending")) {
    if (c.image) await rm(join(sessionFolder(paths, s.caseId, s.sessionId), c.image.file), { force: true });
    c.status = "discarded";
  }
}

/** Journals left "open" by a previous server process (window gone) are settled as interrupted. */
async function settleStale(paths: Paths, caseId: string, now: Date) {
  const live = active();
  for (const s of await listBrowserSessions(paths, caseId)) {
    if (s.status !== "open" || (live && live.sessionId === s.sessionId)) continue;
    await mutate(paths, caseId, s.sessionId, now, async (x) => {
      await dropPending(paths, x);
      x.status = "interrupted";
      x.closedAt = now.toISOString();
      act(x, now, "interrupted", null, "The browser window was no longer connected; unreviewed captures were deleted.");
    });
  }
}

// ---------------------------------------------------------------- actions

export interface AssistDeps {
  launcher: BrowserLauncher;
  now?: () => Date;
}

/** Opens the dedicated window on Alibaba.com for this photo (or returns the one already open), with a product-list draft to add to. */
export async function startBrowserSession(paths: Paths, caseId: string, deps: AssistDeps): Promise<{ session: BrowserSession; reused: boolean }> {
  const now = deps.now ?? (() => new Date());
  if (!CASE_ID.test(caseId)) throw new AssistProblem("invalid_request", "Invalid photo.");
  let saved;
  try {
    saved = await loadIntakeReference(paths, caseId);
  } catch (error) {
    if (error instanceof IntakeProblem) throw new AssistProblem("unavailable", error.message);
    throw error;
  }
  const live = active();
  if (live && live.caseId !== caseId) throw new AssistProblem("busy", "The Alibaba.com window is open for another photo. Close it there first.");
  if (live) {
    const session = await readBrowserSession(paths, caseId, live.sessionId);
    if (session?.status === "open") return { session, reused: true };
  }
  const availability = deps.launcher.availability();
  if (!availability.ok) throw new AssistProblem("unavailable", availability.reason);
  await mkdir(caseFolder(paths, caseId), { recursive: true });
  return withFileLock(join(caseFolder(paths, caseId), "start"), async () => {
    await settleStale(paths, caseId, now());
    // The product list the confirmed products go into: the open draft, or a new one (a new version when a list already exists).
    const state = await getIntakeState(paths, caseId);
    const draft = state.draft ?? (state.collectionExists ? await startRevision(paths, caseId, now()) : await startIntake(paths, caseId, now()));
    const at = now();
    const sessionId = newSessionId(at);
    const session: BrowserSession = browserSessionSchema.parse({
      recordType: "supervised_browser_session",
      schemaVersion: 1,
      sessionId,
      caseId,
      intakeId: draft.intakeId,
      referenceSha256: saved.record.image.sha256,
      site: "alibaba.com",
      browser: "dedicated_visible_chrome_window",
      status: "open",
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      closedAt: null,
      limits: { ...LIMITS },
      actions: [],
      captures: [],
    });
    await mkdir(join(sessionFolder(paths, caseId, sessionId), "captures"), { recursive: true });
    let driver: BrowserDriver;
    try {
      driver = await deps.launcher.launch(ALIBABA_HOME);
    } catch (error) {
      act(session, now(), "open_failed", null, error instanceof Error ? error.message : "The browser could not be started.");
      session.status = "failed";
      session.closedAt = now().toISOString();
      await writeExclusive(journalFile(paths, caseId, sessionId), json(session));
      throw new AssistProblem("browser_error", "Chrome could not be opened. Close any other window using the assistant's profile and try again.");
    }
    act(session, now(), "opened", null, "Dedicated Chrome window opened on Alibaba.com's home page; the person searches.");
    await writeExclusive(journalFile(paths, caseId, sessionId), json(session));
    holder[REGISTRY] = { caseId, sessionId, driver };
    return { session, reused: false };
  });
}

export interface OpenTab {
  targetId: string;
  title: string | null;
  listingUrl: string;
  marketplaceProductId: string;
  /** Already in the product list, or waiting for review. */
  added: boolean;
}

export interface TabOverview {
  products: OpenTab[];
  /** Tabs that are not product pages (search results, home page, other sites); never read. */
  otherTabs: number;
  /** Alibaba.com is asking for sign-in or a check in some tab: the person handles it. */
  needsPerson: boolean;
}

function requireLive(caseId: string, sessionId: string) {
  const live = active();
  if (!live || live.caseId !== caseId || live.sessionId !== sessionId) throw new AssistProblem("not_open", "The Alibaba.com window is not open. Open it again to add products.");
  return live;
}

async function draftIdentities(paths: Paths, caseId: string, intakeId: string) {
  const draft = await readSession(paths, caseId, intakeId);
  if (!draft || draft.status !== "draft") throw new AssistProblem("not_found", "The product list this session adds to is no longer open.");
  return new Set(draft.entries.map((e) => candidateIdentity(e)));
}

/** Product pages open in the window (addresses and titles only). */
export async function listOpenProducts(paths: Paths, caseId: string, sessionId: string): Promise<TabOverview> {
  const live = requireLive(caseId, sessionId);
  const session = await readBrowserSession(paths, caseId, sessionId);
  if (!session || session.status !== "open") throw new AssistProblem("not_open", "This browser session has ended.");
  const taken = await draftIdentities(paths, caseId, session.intakeId);
  for (const c of session.captures.filter((x) => x.status === "pending")) taken.add(candidateIdentity(c));
  let pages;
  try {
    pages = await live.driver.listPages();
  } catch {
    throw new AssistProblem("browser_error", "The Alibaba.com window did not respond.");
  }
  const overview: TabOverview = { products: [], otherTabs: 0, needsPerson: false };
  const seen = new Set<string>();
  for (const p of pages) {
    const kind = classifyPage(p.url);
    if (kind.kind === "needs_person") overview.needsPerson = true;
    if (kind.kind !== "product") {
      overview.otherTabs += 1;
      continue;
    }
    const identity = candidateIdentity(kind);
    if (seen.has(identity)) continue; // the same product open in two tabs is shown once
    seen.add(identity);
    overview.products.push({ targetId: p.targetId, title: tidyTitle(p.title), listingUrl: kind.listingUrl, marketplaceProductId: kind.marketplaceProductId, added: taken.has(identity) });
  }
  return overview;
}

/** "Add this product" for one tab: records its address and a screenshot of its main picture, for the person to review. */
export async function captureProduct(paths: Paths, caseId: string, sessionId: string, targetId: string, deps: { now?: () => Date } = {}): Promise<BrowserCapture> {
  const now = deps.now ?? (() => new Date());
  const live = requireLive(caseId, sessionId);
  if (typeof targetId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(targetId)) throw new AssistProblem("invalid_request", "Choose a product tab.");
  const { result } = await mutate<BrowserCapture | AssistProblem>(paths, caseId, sessionId, now(), async (s) => {
    if (s.status !== "open") throw new AssistProblem("not_open", "This browser session has ended.");
    // A refusal is journaled too, then reported once the journal is saved.
    const refuse = (code: AssistProblemCode, message: string) => {
      if (s.actions.length < LIMITS.maxActions) act(s, now(), "capture_refused", null, message);
      return new AssistProblem(code, message);
    };
    if (s.actions.length >= LIMITS.maxActions) throw new AssistProblem("limit", "This session has reached its action limit. Close the window and start a new session.");
    if (s.captures.filter((c) => c.status === "pending").length >= LIMITS.maxPending) return refuse("pending_review", "Finish reviewing the product you added before adding another.");
    if (s.captures.filter((c) => c.status !== "discarded").length >= LIMITS.maxCaptures) return refuse("limit", `A session can add up to ${LIMITS.maxCaptures} products.`);
    const page = (await live.driver.listPages().catch(() => [])).find((p) => p.targetId === targetId);
    if (!page) return refuse("not_found", "That tab is no longer open.");
    const kind = classifyPage(page.url);
    if (kind.kind !== "product") return refuse("not_product", "That tab is not an Alibaba.com product page.");
    const identity = candidateIdentity(kind);
    const taken = await draftIdentities(paths, caseId, s.intakeId);
    if (taken.has(identity) || s.captures.some((c) => c.status === "pending" && candidateIdentity(c) === identity)) return refuse("duplicate", "This product is already in the list.");

    const captureId = `c${String(s.captures.length + 1).padStart(2, "0")}`;
    let image: BrowserCapture["image"] = null;
    let imageProblem: string | null = null;
    try {
      const picture = await live.driver.captureMainPicture(targetId);
      if (!picture) imageProblem = "No product picture was visible on screen. Show the main photo in that tab and add it again, or attach a photo later.";
      else {
        const checked = validateProductImage(picture.bytes);
        const file = `captures/${captureId}.png`;
        if (checked.mimeType !== "image/png") throw new IntakeProblem("invalid_image", "Unexpected screenshot format.");
        if (!(await writeExclusive(join(sessionFolder(paths, caseId, sessionId), file), picture.bytes))) throw new AssistProblem("browser_error", "Could not save the picture; try again.");
        image = { file, sha256: sha256(picture.bytes), bytes: picture.bytes.length, width: checked.width, height: checked.height };
      }
    } catch (error) {
      if (error instanceof AssistProblem) throw error;
      imageProblem = error instanceof IntakeProblem ? "The picture on screen could not be used." : "The picture could not be captured from that tab.";
    }
    const capture: BrowserCapture = { captureId, capturedAt: now().toISOString(), status: "pending", listingUrl: kind.listingUrl, marketplaceProductId: kind.marketplaceProductId, pageTitle: tidyTitle(page.title), image, imageProblem, entryId: null, photoKept: null };
    s.captures.push(capture);
    act(s, now(), "captured", captureId, image ? `Address and on-screen picture recorded for review (${image.width}×${image.height}).` : `Address recorded for review; ${imageProblem}`);
    return capture;
  });
  if (result instanceof AssistProblem) throw result;
  return result;
}

export type ConfirmFields = Omit<EntryInput, "listingUrl" | "entryId" | "removeImage">;

/** The person checked the details: the product joins the product list. The address always comes from the capture. */
export async function confirmCapture(paths: Paths, caseId: string, sessionId: string, captureId: string, fields: ConfirmFields, keepPhoto: boolean, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  if (!CAPTURE_ID.test(captureId)) throw new AssistProblem("invalid_request", "Unknown product.");
  return (
    await mutate(paths, caseId, sessionId, now(), async (s) => {
      const c = s.captures.find((x) => x.captureId === captureId);
      if (!c || c.status !== "pending") throw new AssistProblem("not_found", "This product is no longer waiting for review.");
      if (s.actions.length >= LIMITS.maxActions) throw new AssistProblem("limit", "This session has reached its action limit.");
      let image: { bytes: Uint8Array; name: string } | null = null;
      if (keepPhoto && c.image) {
        const read = await readConfined(sessionFolder(paths, caseId, sessionId), c.image.file, c.image.sha256);
        if (!read.ok) throw new AssistProblem("not_found", "The captured picture changed or is missing; add the product again.");
        image = { bytes: new Uint8Array(read.bytes), name: `alibaba-screenshot-${c.marketplaceProductId ?? captureId}.png` };
      }
      const provenance = `Address${image ? " and product photo" : ""} recorded with the supervised browser assistant (session ${sessionId}, ${captureId}) from the Alibaba.com page the operator had open${image ? "; the photo is a screenshot of the picture shown on that page, not a download" : ""}. Details confirmed by the operator.`;
      const notes = [fields.notes?.trim(), provenance].filter(Boolean).join(" ");
      // Field problems (IntakeProblem) go back to the form; the capture stays pending.
      const { entry } = await saveEntry(paths, caseId, s.intakeId, { ...fields, foundWith: fields.foundWith ?? "alibaba_image_search", notes: notes.slice(0, 1000), listingUrl: c.listingUrl, entryId: null, removeImage: false }, image, now());
      const entryId = entry.id;
      if (c.image) await rm(join(sessionFolder(paths, caseId, sessionId), c.image.file), { force: true });
      c.status = "added";
      c.entryId = entryId;
      c.photoKept = Boolean(image);
      act(s, now(), "confirmed", captureId, `Added to the product list as ${entryId}${image ? " with its photo" : " without a photo"}.`);
      return { entryId, photoKept: Boolean(image) };
    })
  ).result;
}

export async function discardCapture(paths: Paths, caseId: string, sessionId: string, captureId: string, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  await mutate(paths, caseId, sessionId, now(), async (s) => {
    const c = s.captures.find((x) => x.captureId === captureId);
    if (!c || c.status !== "pending") throw new AssistProblem("not_found", "This product is no longer waiting for review.");
    if (c.image) await rm(join(sessionFolder(paths, caseId, sessionId), c.image.file), { force: true });
    c.status = "discarded";
    act(s, now(), "discarded", captureId, "Discarded by the operator; nothing kept.");
  });
}

/** Closes the window. Products not yet confirmed are deleted. */
export async function closeBrowserSession(paths: Paths, caseId: string, sessionId: string, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  const live = active();
  if (live && live.caseId === caseId && live.sessionId === sessionId) {
    await live.driver.close().catch(() => undefined);
    holder[REGISTRY] = null;
  }
  await mutate(paths, caseId, sessionId, now(), async (s) => {
    if (s.status !== "open") return;
    await dropPending(paths, s);
    s.status = "closed";
    s.closedAt = now().toISOString();
    act(s, now(), "closed", null, "Window closed by the operator.");
  });
}

/** A pending capture's picture for review, confined to its session folder and hash-checked. */
export async function readCapturePicture(paths: Paths, caseId: string, sessionId: string, captureId: string) {
  const s = await readBrowserSession(paths, caseId, sessionId);
  const c = s?.captures.find((x) => x.captureId === captureId && x.status === "pending");
  if (!s || !c?.image) return null;
  return readConfined(sessionFolder(paths, caseId, sessionId), c.image.file, c.image.sha256);
}

export interface AssistView {
  available: boolean;
  unavailableReason: string | null;
  /** The current session for this photo, when its window is open. */
  session: { sessionId: string; intakeId: string; added: number; pending: BrowserCapture | null } | null;
  /** The window is open for a different photo. */
  busyElsewhere: boolean;
}

/** State for the Find page. Reads files and the in-memory window handle only. */
export async function browserAssistView(paths: Paths, caseId: string, launcher: BrowserLauncher): Promise<AssistView> {
  const availability = launcher.availability();
  const live = active();
  const view: AssistView = { available: availability.ok, unavailableReason: availability.ok ? null : availability.reason, session: null, busyElsewhere: Boolean(live && live.caseId !== caseId) };
  if (live && live.caseId === caseId) {
    const s = await readBrowserSession(paths, caseId, live.sessionId);
    if (s?.status === "open") {
      view.session = { sessionId: s.sessionId, intakeId: s.intakeId, added: s.captures.filter((c) => c.status === "added").length, pending: s.captures.find((c) => c.status === "pending") ?? null };
    }
  }
  return view;
}
