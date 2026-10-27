# Analysing a newly uploaded photo

How the local web app turns a newly uploaded furniture photo into a saved, reusable reference with one explicitly confirmed GPT-6 Luna request. Written for P1-007 on 2026-10-27.

**Status:** implemented and tested offline with mocked provider responses. No real request has been made through the web app yet; section 16 describes the first authorized live test.

## 1. User flow

```
/sourcing  "Upload your own photo" ─→ POST /api/sourcing/uploads ─→ /sourcing/uploads/<upload id>
   A. Photo saved successfully ─ "Analyze this photo"
   B. Confirmation dialog ─ Cancel | Confirm and analyze          (opening or cancelling sends nothing)
   C. Analyzing furniture details                                  (recovered from the journal after a refresh)
   D. Your furniture has been analyzed ─ type, distinctive details, structure, colour/materials, not visible
   E. Ready for product discovery                                  (no products searched or matched)
   or: not identified · failed · uncertain · saving not finished
```

The new reference also appears in the advanced workspace (`/sourcing/workspace`, `/sourcing/references/<case>`) with its full fingerprint and "No candidates collected".

## 2. Staged uploads

Unchanged from P1-006. `evals/local/uploads/<upload id>/` holds:
- `image.<ext>`: the original bytes, never modified;
- `upload.json`: id, time, SHA-256, type, size, dimensions, and a sanitized original name used for display only. It is never rewritten; its `awaiting_image_understanding` status is the staging status.

Analysis adds `analysis/attempt-<n>.json` (the journal) and `analysis/attempt-<n>.record.json` (the standard run record of a request that was sent) in the same folder.

## 3. Authorization

- **The button only opens a dialog.** The dialog says, in plain words:
  - one photo is sent to OpenAI and analysed by GPT-6 Luna (`gpt-6-luna`);
  - it is a paid API request on the configured account, and the cost depends on image size and answer length, so it isn't known in advance (with a link to the model's pricing page);
  - the result is saved privately as a furniture reference;
  - it won't search Alibaba or anywhere else, and creates no product matches.
- **No price is shown.** A defensible estimate isn't possible without knowing image tokens and output length, and `max_output_tokens` is not a cost cap.
- **Opening, closing or cancelling the dialog makes no request of any kind.**
- **Confirm and analyze** sends `POST /api/sourcing/uploads/<id>/analysis` with `{"action":"analyze","attemptKey":"<key>"}`. The key comes from the page and identifies exactly what was shown: upload id, image SHA-256, model, instructions version, image detail, reasoning effort, output-token limit and timeout. The server recomputes it, and a mismatch (changed photo or settings) is refused (409).

## 4. Model and instruction reuse

The web app uses the existing P0-005 path unchanged:
- `OpenAIImageUnderstandingService`, through `OpenAIVisionClient.fromApiKey`;
- `FURNITURE_UNDERSTANDING_INSTRUCTIONS` (version `2026-10-24.1`);
- raw-response validation, `mapRawAnalysisToFingerprint`, and `furnitureFingerprintSchema`.

**Request settings** are the CLI's `DEFAULT_VISION_REQUEST_SETTINGS`:

| Setting | Value |
|---|---|
| Model | `gpt-6-luna` (fixed for the web; `OPENAI_IMAGE_UNDERSTANDING_MODEL` is ignored here) |
| API | Responses API with Structured Outputs |
| Image detail | `high` |
| Reasoning effort | `low` (the active setting; it was not changed) |
| Max output tokens | `4096` |
| Store | `false` |
| Tools | none |
| Retries | `maxRetries: 0` on the client and on the call |
| Timeout | 60 s |

No other model is ever used as a fallback. The browser cannot choose a model: a `model` field in the request body is ignored.

## 5. API key configuration

- **Where it comes from:** `OPENAI_API_KEY` from the server environment. `pnpm dev:local` (Next.js) loads `apps/web/.env.local` automatically, the same file the CLI uses.
- **Where it never goes:** the key is never sent to the browser, put in HTML, logged, or written to a journal.
- **If it's missing:** the upload page says analysis isn't set up and how to enable it, and no button is offered. The API returns 503. Checking for the key makes no network request.

## 6. Image validation

Preflight runs before every reservation and on each status read. It never touches the network.
- **The upload:** it must exist, and the id must match `upl-<timestamp>-<8 hex>`.
- **The file is re-read through the evidence route's confined reader:**
  - it must be inside its upload folder, with symlinks and escapes refused;
  - it must be 10 MB or less;
  - its SHA-256 must equal the value recorded at upload ("changed" otherwise).
- **Format and size:** the real format is checked again from the bytes and must match the recorded MIME type, and the dimensions are re-inspected and must match the record.
- **Rejections:** missing, changed, symlinked, mislabelled, oversized, corrupted or resized files are refused with a plain message. Nothing is reserved and nothing is sent.

## 7. Reference registration

**Identity:** the reference id (case id) is the upload id in lower case, e.g. `upl-2026-10-27t10-40-01z-e47b6dfd`.
- It matches the case-id rules of the run record, the image mapping and the web data layer, and it can't collide with the benchmark's names.
- It is still checked: if a prediction or mapping entry already uses it, analysis is refused before any request.
- Display names are never used as keys. In the workspace such references are titled "Uploaded photo · 27 Oct 2026 (e47b6dfd)".

**After a successful analysis, in this order:**
1. The standard run record (`buildRunRecord`) is written to the attempt folder (exclusive create). This keeps the paid result whatever happens next.
2. The same record is written to `evals/local/predictions/<case>.json` with an exclusive create. An identical file is accepted, and a different one is a collision; nothing is ever overwritten.
3. `evals/local/images.json` gets `"<case>": "uploads/<upload id>/image.<ext>"`. The path is relative to the mapping, which the existing resolver already supports, so the photo is not copied.
   - The update holds a cross-process lock file (`images.json.lock`, exclusive create; a lock untouched for 30 s is treated as abandoned).
   - It re-reads and validates the mapping, refuses a conflicting entry, and writes a temporary file renamed over the original. Every existing entry is preserved.
4. The reference is read back with `loadSavedFingerprint` and `resolveReferenceImage`, exactly as Ettrick is.
5. Only then does the journal say `analyzed`.

**If step 2–4 fails:** the journal says `registration_pending`, with the reason. The page offers **Finish saving (no new request)**, which repeats steps 2–5 from the saved record. A mapping is only written after its fingerprint exists, and an invalid mapping is left untouched.

## 8. Saved-record compatibility

The prediction is an ordinary `image_understanding_run` record. It is validated with `runRecordSchema`, and its fingerprint with `furnitureFingerprintSchema`. It contains:
- `caseId`;
- `dataSource: "live"`;
- the image SHA-256, type and size;
- `referenceId` (the existing content-derived `ref-local-<sha>` id);
- the request settings and instructions version;
- the API-reported response id, model and token usage;
- `durationMs`.

**Readers:**
- `loadSavedFingerprint` (proved in tests and in the registration read-back);
- the web data layer's `listReferences` / `getReference`, so the reference appears in the workspace with "No candidates collected" and no runs;
- the evidence route (`reference/<case>`);
- the sourcing CLIs (`source:candidates`, `shortlist:images`, `verify:visual`, `source:auto`) read the same `evals/local/predictions/<case>.json` file. P1-007 didn't run them against an upload reference.

**Known side effect:** `pnpm eval:images` reads every file in the predictions folder, so each analysed upload is listed there as "caseId is not in the dataset". This is an association note, not an error: benchmark metrics are unchanged and the exit code stays 0.

## 9. Durable attempt tracking

Each attempt has a journal, `analysis/attempt-<n>.json` (`recordType: "upload_analysis_attempt"`).

**What it records:** the attempt key, case and reference ids, image hash, type, size and dimensions, the request settings, the state and timestamps (reserved, send started, finished), the response id, model, usage and duration, the outcome (category, model outcome, untrusted model reason truncated to 300 characters, status, OpenAI request id), and the record and prediction paths.

**What it never contains:** image bytes, base64 data, keys or provider payloads.

**States:**

| State | Meaning |
|---|---|
| `reserved` | Reserved before any request |
| `sending` | Written immediately before the single SDK call |
| `analyzed` | Saved and registered |
| `registration_pending` | Paid result saved, registration not finished |
| `not_identified` | The model found no single furniture object |
| `failed` | OpenAI answered with an error or an unusable response |
| `uncertain` | No answer received; the request may have been charged |
| `not_sent` | Failed before anything left this computer |

**Updates** are validated and written with an atomic rename. Journals are never deleted.

## 10. Duplicate-request prevention

- **Reservation:** a journal is created by writing a temporary file and hard-linking it to `attempt-<n>.json`. This is atomic and exclusive across processes, and readers never see a partial file. If two confirmations race, exactly one link succeeds and the other gets 409 `in_progress`.
- **When a new attempt is possible:** only when there is no attempt, or the latest one is `not_sent` (or `reserved` and stale, meaning it never reached `sending`). Every other state blocks new attempts: repeated clicks, refreshes, other tabs and other processes all get 409. An unreadable journal blocks everything.
- **One call per attempt:** the provider is wrapped so it can be called only once, and writes `sending` before the call leaves.
- **Double clicks:** a per-process guard also refuses them immediately. It is only a fast path; the durable reservation is what guarantees one request.
- **Refreshes:** the page and the status endpoint only read journals.
- **The browser going away:** the POST handler doesn't pass the request's abort signal to OpenAI, so the one request finishes and is recorded.

## 11. Timeouts and uncertain outcomes

- **No retries:** the SDK client has `maxRetries: 0`, there is a 60 s timeout, and nothing retries automatically anywhere.
- **Outcome classification:**
  - **Sent, no response** (timeout, connection failure, unexpected error): `uncertain`. The page says: "The analysis couldn't be confirmed. A request may already have been sent. Review the attempt before trying again."
  - **Sent, error response** (401, 403, 404, 429, 400, 5xx) **or an unusable response** (refusal, incomplete, malformed, missing output): `failed`.
  - **Failed before sending** (for example, the client couldn't be created): `not_sent`. A new confirmed attempt is allowed.
- **Restarts:** a `sending` journal that outlives the timeout by 2 minutes is shown as `uncertain` and is never re-sent.
- **Rerunning deliberately:** there is no Retry button. To try again after `failed`, `uncertain` or `not_identified`, upload the photo again; that is a new upload and a new, separately confirmed request. The page says it may be charged again.

## 12. Non-furniture results

The existing outcome types are reused unchanged:

| Outcome | Page title |
|---|---|
| `no_furniture` | "We couldn't identify a clear furniture item in this photo." |
| `ambiguous_target` (several pieces, none primary) | "This photo shows several pieces, and none stands out as the main one." |
| `unreadable_image` | "The photo was too unclear to analyze." |

- **What is kept:** the photo and the outcome, in the journal and the attempt's run record. The model's reason is available only under Technical details, marked untrusted.
- **What is not created:** no prediction or mapping entry, no category, and no "ready for discovery" state.
- **Errors:** model refusals and malformed or truncated responses are `failed`, with a short message. Technical detail is under the disclosure.

## 13. API cost and usage visibility

- **In the dialog:** that this is a paid request, the model, that the image is sent, that cost depends on processing, and that no marketplace search happens. No amount is shown (section 3).
- **After a request:** the API-reported input, output, reasoning and total tokens, response id, model and duration are saved in the journal and the run record. They are shown under **Technical details** on the upload page. The main view never shows tokens, hashes, response ids, case ids or instruction versions.

## 14. Security boundaries

- **Routes:** the routes use the same local-only guard as P1-006: `VFSA_LOCAL_SOURCING_UI=1`, never when `NODE_ENV=production`, loopback `Host` only, and a same-origin loopback `Origin` for the POST.
  - The upload id is validated by pattern before anything is read.
  - The request body can only name an action and the confirmed key. It can never carry a path, model, key or settings. There is no generic model endpoint.
  - The status endpoint (`GET`) is read-only and returns states and outcome categories only: no paths, keys or payloads.
- **The photo is untrusted content.** The provider call has no tools, `store: false`, and fixed instructions. Model output is data only:
  - It is validated by the raw schema, mapped, and validated again as a fingerprint.
  - The application assigns the case id, reference id, fingerprint id, timestamps, file paths and provenance, and the API-reported model.
  - Text inside the image cannot start searches, write files, or trigger further requests, because nothing in the flow acts on model text.
- **Storage:** everything stays under the git-ignored `evals/local/`. Nothing goes in `public/`, and the photo is served only through the hash-checked evidence route.

## 15. Testing

All tests use synthetic images and a fake `responses.parse`, wrapped by the real `OpenAIVisionClient`. They make no network calls: `fetch` is stubbed and asserted unused.

| File | Covers |
|---|---|
| `apps/web/src/lib/sourcing/ui/analysis/analysis.test.ts` | Preflight, the single request, failure outcomes, registration, the route, and the end-to-end path below |
| `apps/web/src/components/sourcing/analysis/analysis-view.test.tsx` | The page states |

`analysis.test.ts` checks:
- **Preflight:**
  - accepts a valid photo;
  - rejects an unknown or invalid id, a missing key, and a changed, missing, symlinked, mislabelled, resized, corrupted or oversized file.
- **The single request:**
  - the model, instructions and version, the exact image bytes as a data URL, `detail: high`, 4096 output tokens, reasoning `low`, `store: false`, no tools, and `{maxRetries: 0, timeout: 60000}`;
  - the saved record loads with `loadSavedFingerprint`, with the right hash, provenance and usage;
  - the mapping keeps every entry and points at the staged photo;
  - the journal links the upload to the attempt, the reference and the record, and holds no secrets.
- **Duplicates:**
  - repeats and concurrent confirmations during and after a request make one call;
  - a restart leaves `sending`, which becomes `uncertain` and is never re-sent;
  - a mismatched confirmation key is refused;
  - a failure before sending becomes `not_sent` and allows exactly one new attempt.
- **Outcomes:** no furniture, a refusal, a truncated response, an invalid structure, a rejected key, a timeout and a dropped connection each get the right state and category. None saves a reference, and none is retried.
- **Registration:**
  - a case collision is refused before any request;
  - 12 concurrent mapping updates keep every entry;
  - a conflicting entry is refused;
  - an invalid mapping is left untouched, the state is `registration_pending`, and **Finish saving** completes it without a new request;
  - an unreadable journal blocks new attempts.
- **The route:** non-loopback, cross-origin, missing-origin and production requests are refused, as are disabled mode, an invalid id and a missing confirmation. A model in the body is ignored. A missing key gives 503 with no call. Status reads make no request and expose no secrets or paths.

**The end-to-end test** (through the route handlers):
1. upload, then preflight shows "ready";
2. one confirmed (mocked) request;
3. the status becomes "analyzed";
4. `listReferences` shows the new case as `furniture_identified`, "No candidates collected", photo available, no runs and no assessments;
5. `getReference` returns its fingerprint;
6. no candidate, shortlist, verification or sourcing-run files exist for it;
7. a second confirmation gets 409, and there is still only one call.

`analysis-view.test.tsx` checks the page states:
- **Ready:** the photo, the action, and every dialog statement, with no price.
- **Missing key:** a setup explanation.
- **Analyzing:** a truthful message with no percentages.
- **Analyzed:** plain-English details from the saved fingerprint and the next step. No technical terms, ids, tokens, products or scores appear in the main view; the response id and usage are under Technical details.
- **Not identified:** says so, with no category.
- **Uncertain:** the warning, and no retry button.

## 16. First authorized live test (human only)

Not run during implementation. A developer who chooses to make the first paid web request:

1. **Key:** make sure `apps/web/.env.local` contains `OPENAI_API_KEY=…`. The same key is used for `pnpm analyze:image --live`.
2. **Restart the server:** stop any running dev server, then start `pnpm dev:local`. A server started before these changes may serve stale modules.
3. **Upload:** open http://localhost:3000/sourcing, select **Upload your own photo**, choose a photo of one piece of furniture (PNG, JPEG or WebP, up to 10 MB), and select **Save photo**.
4. **Review:** on the photo's page, select **Analyze this photo** and read the dialog.
5. **Confirm once:** select **Confirm and analyze**. The page shows "Analyzing furniture details" and then the result, usually within a minute. Don't click again; if you refresh, the page recovers the recorded state.
6. **Check the result:**
   - the furniture type, distinctive details, structure, colours and materials, and anything not visible;
   - **Technical details**, for the response id, the model and the reported token usage.
7. **Check the workspace:**
   - **Advanced details** (or `/sourcing/workspace`) shows the new reference ("Uploaded photo · <date> (<id>)") with "No candidates collected" and the full fingerprint;
   - `evals/local/predictions/<case>.json` exists, and `evals/local/images.json` has the new entry, with all existing entries unchanged.
8. **If the page says the outcome couldn't be confirmed:** check the OpenAI usage dashboard before uploading the photo again.

## 17. Remaining marketplace-discovery limitations

An analysed photo stops at "Ready for product discovery". Getting genuine candidates for it still needs one of the following:
- **Authorized automated discovery:** P1-004's provider is implemented but not authorized for live use. Image search would also need an approved way to give the provider the photo.
- **Operator-assisted intake:** a person records candidates (`pnpm source:candidates --case <case> --prepare` / `--run`). The command reads the same saved record, but it hasn't been tried with an upload reference, and it isn't exposed in the web app.

After candidates exist, SigLIP shortlisting and Sol verification (paid, explicitly capped) and `source:auto` work as they do for Ettrick. None of them run as a result of analysing a photo.
