# Plaud write-back extension: principles

|             |                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**  | Principles agreed for planning. No design yet: a feasibility spike (P1) comes first.                                                   |
| **Updated** | 2026-11-01                                                                                                                            |
| **Owner**   | Tim Hayward                                                                                                                           |
| **Context** | Picks up "Write-back to Plaud" from [speaker-identification.md](speaker-identification.md) section 11. Automated server-side write-back was rejected; a browser extension acting in the user's own signed-in Plaud session is the option being explored. |

## Why

Confirmed speaker names have to reach Plaud so that Plaud AI (Ask Plaud) reviews conversations with the right people attributed. Names held only in Applaud's `-Applaud` transcript do not achieve that.

The goal is less overhead, not more. Every principle below is tested against that.

## Inputs

| Category   | Item                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| Known      | Names must be in Plaud for use with Plaud AI.                                                            |
| Known      | Chromium browsers first; development and testing on Microsoft Edge.                                      |
| Known      | Single user initially; the code is open source and will be usable by other Applaud users.                |
| Known      | A feasibility spike comes before any architecture is fixed.                                              |
| Evidenced  | Applaud already protects `/api` and `/media` with a LAN token and a host check (`server/src/index.ts`, `server/src/security/host-check.ts`). |
| Evidenced  | The workspace has `shared`, `server` and `web` packages (`pnpm-workspace.yaml`).                         |
| Assumption | Volume is a handful of recordings a week, so one confirmation per batch is acceptable but per-recording navigation is not. |
| Unknown    | Whether Plaud's web app exposes a rename request the extension can call, and in what form.              |
| Unknown    | Whether a speaker rename in Plaud changes what Plaud AI sees for that recording.                         |
| Unknown    | Whether Plaud's terms permit this kind of tool.                                                          |

## Principles

### P1. Prove it before building it

A time-boxed spike answers, with evidence recorded in this document:

1. The request the Plaud web app sends to rename a speaker (endpoint, method, body, any anti-forgery or anti-bot token).
2. Whether that request can be replayed from an extension context in the user's session, or only from the page.
3. Whether a speaker can be addressed by Plaud's `original_speaker` (D8 in the speaker plan), not only by its current display name.
4. **Whether Plaud AI uses the renamed speaker afterwards**, on both a new question and an existing chat. If it does not, the extension does not meet its purpose and the work stops here.
5. What Plaud's terms say about automated or third-party access.

**Stop criteria:** stop if (4) fails, if the only route is driving the page UI (DOM automation), or if the terms prohibit it. The fallback is the assisted manual list (P3).

### P2. Applaud decides, the extension carries out

Applaud stays the single source of truth for who each speaker is, which names are confirmed and what is pending. The extension holds no matching, naming or conflict logic. It fetches a list of pending renames, applies them, and reports each outcome back.

*Why:* logic in one place, covered by the existing server tests, and no extension release when a rule changes.
*Trade-off:* the extension works only while Applaud is reachable. That is accepted.

### P3. Optional, separable and useful without the extension

Applaud runs exactly as it does today without the extension. The "pending names" list it serves is also shown in the Applaud UI, which is the assisted manual option. Build that first: it has value even if the spike fails, and the extension then becomes an executor for something that already exists.

### P4. Low touch, user initiated

- At most one confirmation per batch, from the extension popup or the Plaud tab. No navigating to recordings one at a time.
- The extension acts only when the user starts it, or when the user has Plaud open and has opted in to applying pending names automatically.
- No background polling of Plaud and no unattended runs. This keeps request volume close to normal use and limits account risk.

### P5. Safe writes

Carried over from the deferred write-back design:

- Off by default, both in Applaud (a setting) and in the extension.
- A dry run that shows exactly what will change before anything is written.
- Precondition guards (`expectedPlaudLabel`, `expectedName`) checked against a fresh read immediately before each write. A speaker changed in Plaud since Applaud last saw it is skipped, never overwritten.
- Each write is idempotent and recorded in an undo log held by Applaud, with the previous value.
- One mutating call per speaker, rate limited.

### P6. Fail closed and say so

- If a Plaud response does not match the expected shape, stop the whole batch, not just the one item.
- Every outcome (applied, skipped, failed, with reason) is reported to Applaud and visible there.
- A kill switch in Applaud settings blocks write-back immediately, whatever the extension's state.
- The Plaud request and response shapes are pinned by fixtures from the spike and covered by contract tests, so a Plaud change shows up as a failing test or a clean stop, not a bad write.
- Applaud and the extension exchange a protocol version. A mismatch disables writing until both sides are updated.

### P7. Least privilege

- Host permissions only for the Plaud web origin and the user's configured Applaud origin. No `<all_urls>`, and no permissions beyond what the spike shows are needed.
- The extension pairs with Applaud using its own scoped, revocable token. That token reaches only the pending-names and results endpoints, never the LAN token or general `/api` access.
- Applaud allows the extension's origin explicitly (CORS), and only for those endpoints.
- The extension never reads, stores or sends Plaud credentials. It uses the browser's existing session.
- No remote code. Manifest V3 forbids it, and the extension must be reviewable as shipped.

### P8. Same repo, same release

- A new `extension` workspace package beside `shared`, `server` and `web`. It reuses types from `shared` and follows the same lint, typecheck and test setup.
- It is versioned and released with Applaud and built in the same CI, with the built extension attached to the release.
- Standard Chromium Manifest V3 APIs only, nothing specific to Edge, so Chrome and other Chromium browsers work without a fork. Edge is the reference browser for testing.

### P9. Open source from the start, distributed cautiously

- Loaded unpacked (developer mode) to begin with. Store publication (Edge Add-ons, Chrome Web Store) is a separate decision once the extension has proved reliable, because an unofficial tool that writes to a third party's service carries review and takedown risk.
- The README states clearly that this is unofficial and not affiliated with Plaud, as the main README does for the API integration, and that it acts on the user's own account.
- Install, pairing and removal are documented, and so is how to roll back using the undo log.
- Other users get the same defaults as the owner: off, dry run first, kill switch.

## Traceability

| Requirement                         | Principles      |
| ----------------------------------- | --------------- |
| Names reach Plaud AI                | P1 (4)          |
| Reduce overhead                     | P2, P3, P4      |
| Do not damage Plaud data            | P5, P6          |
| Protect the Plaud account and Applaud | P4, P7, P9    |
| Same repo, companion to Applaud     | P8              |
| Open source for other users         | P8, P9          |

## Next step

Run the spike in P1 and record the results here. Plan the extension only if the spike passes.

## Appendix A. Spike capture checklist

Covers P1 questions 1, 3, 4 and 5 by hand in Edge. Question 2 (replay from an extension context) needs a throwaway unpacked extension and is a separate step once A.3 shows a usable request.

**Handling secrets.** Cookies, bearer tokens and device ids from these captures never go into the repo, an issue or a chat. Keep raw captures in a local folder outside the repo; only redacted fixtures are committed.

### A.1 Prepare

- [ ] Choose a short, low-value test recording with at least two speakers, one of them still generic (`Speaker 2` or similar).
- [ ] Note its Plaud id (the last 8 characters are in the Applaud folder name) and the current name of every speaker.
- [ ] In Applaud, open its `transcript.json` and note the `speaker` and `original_speaker` for the speaker you will rename.
- [ ] **Plaud AI baseline.** Ask Plaud AI a question about the recording whose answer depends on who said what, for example "What did Speaker 2 say about X?" and "List the speakers in this recording." Screenshot the answers. Keep this chat open: it is the "existing chat" for A.4.
- [ ] Open the Plaud web app in Edge, signed in, in your normal profile.
- [ ] Open DevTools (F12) → **Network**. Tick **Preserve log** and **Disable cache**, filter to **Fetch/XHR**, then clear the log.

### A.2 Capture the rename

- [ ] Open the test recording and rename the generic speaker to a distinctive test name, for example `Spike Test Alice`.
- [ ] Note every option the UI offers (this segment only, all of this speaker in this recording, across recordings) and which one you chose. Choose "all of this speaker in this recording" if offered.
- [ ] Save, then stop and look at the requests that appeared.
- [ ] Export the log: right-click in the request list → **Save all as HAR (sanitized)** if Edge offers it, otherwise **Save all as HAR**. Store it outside the repo.

### A.3 Record the request

For the request that performed the rename (usually `POST`, `PUT` or `PATCH`), and for any request just before it that looks like a token or challenge:

- [ ] Method, full URL and host (note whether the API host differs from the web app's host, or is regional).
- [ ] Status code.
- [ ] **Authentication:** header *names* only (for example `Authorization`, `x-…-token`, `x-device-id`, an app version). Is it a bearer token, a cookie, or both? In **Application** → Local storage / Cookies, note the *key name* the token lives under, not its value.
- [ ] **Anti-bot or anti-forgery:** any CAPTCHA, Turnstile, signature, nonce or timestamp-hash header, or a request fetching one first. This is the main stop risk.
- [ ] **Body:** how the speaker is addressed (`original_speaker`, display name, segment ids, a speaker id). Does the body carry only the change, or the **whole transcript**? A whole-transcript write is a serious risk and must be written down.
- [ ] **Response body:** its shape, and whether it returns the updated speaker or transcript.
- [ ] Right-click the request → **Copy** → **Copy as fetch** and keep it with the HAR (it contains secrets).

### A.4 Check the effect

- [ ] Reload the Plaud recording: the new name shows on every segment you expected and no others.
- [ ] Run a sync in Applaud (or wait for the next one). In `transcript.json`, check that `speaker` changed and `original_speaker` did **not** (D8).
- [ ] **Plaud AI, new chat:** ask the baseline questions again. Does it use `Spike Test Alice`?
- [ ] **Plaud AI, existing chat:** ask again in the baseline chat. Same question.
- [ ] If either does not use the name, try again after about 15 minutes and again the next day, in case Plaud AI indexes later. Record the times.

### A.5 Replay from the page

This shows whether a scripted request is accepted at all. It runs in the page, so it does not yet prove the extension context (P1 question 2).

- [ ] In the Plaud tab, open DevTools → **Console**. Paste the copied fetch, change only the name back to the original, and run it.
- [ ] Note the status and response. Reload the recording and confirm the original name is restored.
- [ ] Note anything that failed or needed a fresh token or challenge.

### A.6 Terms

- [ ] Read Plaud's current terms of service for clauses on automated access, scripts, reverse engineering or third-party tools. Note the clause text, the URL and the date read.

### A.7 Tidy up

- [ ] The test speaker is back to its original name in Plaud, and Applaud shows the same after a sync.
- [ ] Raw captures are stored outside the repo or deleted. If a token was exposed anywhere it should not be, sign out of the Plaud web app to invalidate the session.

### A.8 Results

First capture: 2026-11-01, Edge, web app build `prod-261030-050226`, one speaker renamed from `Speaker 2` to a real name on a 25-minute recording with 230 segments. Evidence is a sanitised HAR held outside the repo.

| Item                                                          | Result |
| ------------------------------------------------------------- | ------ |
| Rename request: method, host, path                            | **No rename endpoint.** The web app rewrites the content client-side and sends three `PATCH https://api-euc1.plaud.ai/file-app/v4/files/update/content/<file_id>` requests, one each for the transcript, the polished transcript and the summary. Host is regional (`api-euc1`). |
| Request body                                                  | `{ object_id, content_id, content, origin_version }`, plus `relation_content_ids` on the summary. `content` is the **whole document** as a string: the full segment array (about 55 KB) for each transcript, and the full markdown for the summary. |
| What changed                                                  | Transcripts: only `speaker` on the 79 segments whose `speaker` was `Speaker 2`; nothing else differs. Summary: a plain text replacement of `Speaker 2` with the name (14 occurrences); pronouns left as they were. Outline and other tabs not written. |
| Concurrency                                                   | Each write sends `origin_version` (a millisecond version of the content being replaced); the response returns a new `version_ms`. Whether Plaud **rejects** a stale `origin_version` is not yet known. |
| Authentication mechanism (names only)                         | Bearer `authorization` header (named in the CORS preflight; stripped from the sanitised HAR). No cookies are sent. Other headers: `app-language`, `app-platform`, `edit-from`, `traceparent`, `x-device-id`, `x-request-id`, `x-scope-id`, `x-scope-type`, `x-timezone-iana`. CORS allows only `https://web.plaud.ai`, with credentials. |
| Anti-bot or anti-forgery measures                             | None seen: no signature, nonce, CAPTCHA or challenge request. `x-request-id` is a random UUID. |
| Speaker addressed by                                          | Not addressed at all by the server: the client edits `speaker` values in the documents. |
| UI scope options offered                                      | To be recorded. |
| `original_speaker` unchanged after rename                     | **Yes**, in the PATCH bodies and in Applaud's next sync: `transcript.json` and `transcript_polished.json` both show `original_speaker` `Speaker 2` with the new `speaker`, and `summary.md` carries the name. Applaud's key (D8) maps directly. |
| How Plaud AI reads transcripts                                | Ask Plaud's retriever returns transcript chunks formatted `[start-end] [Speaker name]` followed by the text (`contextos-dproxy/v4/context/resource`). Whether those chunks are rebuilt after a rename is the open question below. |
| Plaud AI uses the new name: new chat (and delay)              | Not separately tested; the existing-chat result makes a failure unlikely. |
| Plaud AI uses the new name: existing chat (and delay)         | **Yes.** Before the rename it answered with `Speaker 2`; within minutes afterwards, the same question in the same chat answered with the name (and inferred a pronoun). |
| Replay from page console accepted                             | Reported as passed. Whether a **stale** `origin_version` is refused is unresolved: Applaud's files hold no version data. Test A.10 settles it. |
| Terms of service position                                     | Pending. |
| **Decision:** continue to extension-context test, or stop     | **Continue.** The P1 stop criterion (Plaud AI ignores the name) is not met. Remaining before planning: A.10 and the terms of service. |

### A.9 Consequences for the design (provisional)

- **The extension must reproduce the web app's edit.** It reads the current transcript, polished transcript and summary, changes `speaker` where `original_speaker` matches, replaces the label in the summary, and writes all three back whole. This is the "whole-transcript write" risk in A.3; P5 and P6 carry the weight.
- **`origin_version` is the natural precondition guard** (P5), but only if Plaud enforces it. Test: replay a write with a deliberately stale `origin_version` and confirm it is refused.
- **Run requests from the Plaud page, not the service worker.** The token is a bearer token held by the page, and CORS admits only `web.plaud.ai`. A content script that runs the edit in the page's context avoids handling the token in the extension's own storage (P7), at the cost of needing a Plaud tab open (consistent with P4).
- **The summary replacement is naive.** A whole-word match is needed so `Speaker 2` does not also match `Speaker 20`, and pronouns stay as Plaud wrote them.
- **The write is three requests, not one.** A failure part-way leaves Plaud inconsistent; the undo log must hold all three previous documents and their versions.

### A.10 Stale-version test

Settles whether `origin_version` can serve as the precondition guard (P5). It sends content identical to what Plaud already holds, so it cannot change the recording whatever the outcome.

1. In the Plaud tab, open the recording and capture a fresh rename-free baseline: DevTools → Network, then reload the page.
2. From the earlier capture, take the **transcript** PATCH (the first of the three) as copied fetch. Its body carries the `origin_version` from *before* the rename, which is now stale. The `content` already contains the name, so it matches Plaud's current transcript.
3. Run it in the Console and record the HTTP status and the response JSON (`status`, any message).
4. **Refused** (non-zero `status` or an HTTP error mentioning a version or conflict): Plaud enforces it, and it becomes the P5 guard.
   **Accepted:** Plaud does not enforce it. The extension must do its own fresh read and comparison immediately before each write, and the race window, though small, cannot be closed.
