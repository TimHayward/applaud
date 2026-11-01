# Plaud write-back extension

|             |                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**  | Spike complete (GO, Appendix A). Phases 1 and 2 verified by the owner on the Portainer host and in Edge against Plaud. Phase 3 built, not yet verified against Plaud; Phase 4 not started. |
| **Updated** | 2026-11-01                                                                                                                                                                                                                                               |
| **Owner**   | Tim Hayward                                                                                                                                                                                                                                              |
| **Context** | Picks up "Write-back to Plaud" from [speaker-identification.md](speaker-identification.md) section 11. Automated server-side write-back was rejected; a browser extension acting in the user's own signed-in Plaud session is the option being explored. |

## Why

Confirmed speaker names have to reach Plaud so that Plaud AI (Ask Plaud) reviews conversations with the right people attributed. Names held only in Applaud's `-Applaud` transcript do not achieve that.

The goal is less overhead, not more. Every principle below is tested against that.

## Inputs

| Category   | Item                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Known      | Names must be in Plaud for use with Plaud AI.                                                                                                |
| Known      | Chromium browsers first; development and testing on Microsoft Edge.                                                                          |
| Known      | Single user initially; the code is open source and will be usable by other Applaud users.                                                    |
| Known      | A feasibility spike comes before any architecture is fixed.                                                                                  |
| Evidenced  | Applaud already protects `/api` and `/media` with a LAN token and a host check (`server/src/index.ts`, `server/src/security/host-check.ts`). |
| Evidenced  | The workspace has `shared`, `server` and `web` packages (`pnpm-workspace.yaml`).                                                             |
| Assumption | Volume is a handful of recordings a week, so one confirmation per batch is acceptable but per-recording navigation is not.                   |
| Unknown    | Whether Plaud's web app exposes a rename request the extension can call, and in what form.                                                   |
| Unknown    | Whether a speaker rename in Plaud changes what Plaud AI sees for that recording.                                                             |
| Unknown    | Whether Plaud's terms permit this kind of tool.                                                                                              |

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

_Why:_ logic in one place, covered by the existing server tests, and no extension release when a rule changes.
_Trade-off:_ the extension works only while Applaud is reachable. That is accepted.

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

| Requirement                           | Principles |
| ------------------------------------- | ---------- |
| Names reach Plaud AI                  | P1 (4)     |
| Reduce overhead                       | P2, P3, P4 |
| Do not damage Plaud data              | P5, P6     |
| Protect the Plaud account and Applaud | P4, P7, P9 |
| Same repo, companion to Applaud       | P8         |
| Open source for other users           | P8, P9     |

## 1. Plan summary

Applaud works out which speaker names Plaud is missing and builds the exact documents to write. A Manifest V3 extension for Chromium browsers carries them out from inside the Plaud web app, using the user's own session, after a dry run the user approves. Plaud's server refuses any write whose document changed since it was read, and Applaud keeps the previous versions so a write-back can be undone.

The Applaud half ships first and is useful alone: a "Names to send to Plaud" list the user can work through by hand (P3).

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                     | Basis                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| W1  | **Applaud builds the new documents.** The extension reads the current transcript, polished transcript and summary from Plaud, sends them to Applaud, and gets back the documents to write with a human-readable diff. The extension holds no naming logic.                                                   | P2. Logic tested once, in the server suite; no extension release when a rule changes.                                     |
| W2  | **Names written per segment, from Applaud's named transcript** (`buildApplaudTranscript`), keyed by `segment_uid`, so per-segment corrections reach Plaud too. The polished transcript shares the `segment_uid`s (Evidenced, A.9) and gets the same names.                                                   | Evidenced: segment uids identical across the two transcripts in the capture.                                              |
| W3  | **Only confirmed names are sent**: confirmed labels, segment overrides and the Plaud owner. Automatic matches are not sent until confirmed in Applaud. Unknown, suggested and ignored labels leave Plaud's value untouched.                                                                                  | Speaker plan D6: guesses never leave Applaud. One confirmation per recording in Applaud is the accepted cost.             |
| W4  | **Summary: whole-word replacement of a Plaud label** (`Speaker 2`, not `Speaker 20`) and only when every segment of that label has the same confirmed name. A label split across people by overrides is left as it is in the summary. Pronouns are not touched. Outline and other note tabs are not written. | Mirrors the web app (A.8), made safer.                                                                                    |
| W5  | **Order and partial failure: roll forward, never roll back automatically.** Writes go transcript, polished transcript, summary, as the web app does. If one fails the batch stops; the next run reads Plaud afresh, finds the documents already written produce no change, and completes the rest.           | Idempotent by construction (W1 recomputes from a fresh read); an automatic rollback is a second write that can also fail. |
| W6  | **`origin_version` is the precondition guard.** A conflict (`status` `-1800313`) skips the recording and reports it; no automatic retry. Success is `status: 0` in the body, never HTTP 200 alone.                                                                                                           | Evidenced, A.10.                                                                                                          |
| W7  | **Applaud's sync is the independent check.** A recording is "in Plaud" only when Applaud's next sync, through the official API, shows the names. Until then it is "sent, awaiting sync".                                                                                                                     | Verifies the write through a second channel.                                                                              |
| W8  | **Plaud calls run in a content script on `web.plaud.ai`; Applaud calls run in the service worker.** The content script reads the session token from `pld_tokenstr` when it needs it, never stores it and never passes it to the service worker or Applaud.                                                   | P7. CORS on Plaud's API admits only `web.plaud.ai` (A.8).                                                                 |
| W9  | **Applaud is reached with an optional host permission** granted at pairing for the user's own Applaud address, so no CORS change is needed in Applaud.                                                                                                                                                       | P7. Chromium exempts extension service-worker requests from CORS when the extension holds the host permission.            |
| W10 | **A separate extension token**, issued in Applaud Settings by a one-time pairing code, stored hashed, revocable, and accepted only on `/api/plaud-writeback/*`.                                                                                                                                              | P7. The LAN token stays with the web UI.                                                                                  |
| W11 | **Undo log in Applaud**: for each write, the previous content, its version and the new version, kept for 30 days. Undo is a write like any other: it goes through the extension and is refused if Plaud's document has changed since.                                                                        | P5.                                                                                                                       |
| W12 | **Off by default, kill switch in Applaud.** Settings → Speakers → "Send names to Plaud" (off). Turning it off makes the plan endpoint refuse at once, whatever the extension's state.                                                                                                                        | P5, P6.                                                                                                                   |
| W13 | **Protocol version** in every extension request. Applaud refuses a mismatch with a message naming the release to install.                                                                                                                                                                                    | P6.                                                                                                                       |

## 3. Data flow

1. Applaud marks a recording **pending** when its confirmed names (W3) differ from the `speaker` values in its latest synced `transcript.json`.
2. The user opens Plaud in Edge and clicks the extension. The popup lists pending recordings from `GET /api/plaud-writeback/pending`.
3. **Dry run.** For each recording, the content script calls `GET /file-app/v4/files/detail/<id>`, takes the `TRANSCRIPT`, `POLISHED_TRANSCRIPT` and `SUMMARY` objects (id, content id, version, signed URL), and downloads each document. The service worker sends them to `POST /api/plaud-writeback/plan`, which returns the new documents, their versions, and a diff ("Speaker 2 → Mollie Sutton, 79 segments; summary: 14 replacements").
4. The popup shows the diff. The user clicks **Apply** (once per batch).
5. **Write.** The content script sends each changed document with `PATCH /file-app/v4/files/update/content/<id>` and its `origin_version`, one recording at a time, with a pause between requests.
6. **Report.** Each outcome (applied with new version, conflict, error, skipped) goes to `POST /api/plaud-writeback/results`, which records it and the undo entry.
7. Applaud's next sync confirms (W7) and clears the pending mark.

## 4. Applaud changes

| Area      | Change                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database  | Migration 6: `plaud_writeback` (one row per recording: state, last attempt, last error) and `plaud_writeback_log` (per document: kind, content id, previous content, previous and new version, outcome, created, undone). Pruned after 30 days. |
| Pending   | Computed after each sync and after each label change, from `buildApplaudTranscript` and the synced transcript.                                                                                                                                  |
| Transform | `server/src/plaud-writeback/transform.ts`: pure functions for W2 and W4, with fixtures built from synthetic documents shaped like the capture (never real transcripts).                                                                         |
| Routes    | `/api/plaud-writeback/pending`, `/plan`, `/results`, `/undo/:recordingId` (returns the documents to restore), `/status` (enabled, protocol version). Extension-token guard only.                                                                |
| Pairing   | Settings → Speakers → Browser extension: generate a pairing code (10 minutes, single use), list paired extensions, revoke.                                                                                                                      |
| UI        | Dashboard mark "Names to send to Plaud"; on the recording page, a panel listing exactly what would change, with copy buttons for manual entry (P3), the write-back history and Undo.                                                            |
| Docs      | `docs/api.md`, README section with the unofficial-use statement, `docs/portainer.md` note that nothing changes for the container.                                                                                                               |

## 5. Extension

| Item           | Choice                                                                                                                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location       | `extension/` workspace package; types from `@applaud/shared`.                                                                                                                                                                                                                                                     |
| Build          | Vite in library mode, one bundle each for service worker, content script and popup. Output `extension/dist`, zipped into the GitHub release.                                                                                                                                                                      |
| Manifest       | MV3. `permissions`: `storage`. `host_permissions`: `https://web.plaud.ai/*`. `optional_host_permissions`: `http://*/*`, `https://*/*`, requested for the single Applaud origin at pairing. Content script on `https://web.plaud.ai/*` only. A fixed `key` so the extension id is stable across unpacked installs. |
| Plaud API host | Taken from the web app at run time, not hard-coded: the capture used `api-euc1`, and other regions use other hosts. How the page exposes it is open question Q1.                                                                                                                                                  |
| Storage        | Applaud address and extension token in `chrome.storage.local`. Nothing from Plaud is stored.                                                                                                                                                                                                                      |
| Popup          | Paired state, pending count, dry-run diff, Apply, per-recording results, link to the recording in Applaud.                                                                                                                                                                                                        |
| Browsers       | Edge is the reference. Standard Chromium APIs only, so Chrome and Brave should work unchanged; not tested until a user asks.                                                                                                                                                                                      |

## 6. Phases

| Phase                       | Scope                                                                                                                                                | Exit check                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Applaud side**         | Migration, pending computation, transform, routes behind the setting (off), pairing, "Names to send to Plaud" panel with copy buttons. No extension. | Unit and route tests; the panel's list matches what a manual rename in Plaud needs for three real recordings; release as a minor version.                                         |
| **2. Extension, read only** | Package, build, pairing, popup, content script reads Plaud documents, plan endpoint returns the diff. No `PATCH` in the code.                        | On Edge: pairing, dry run for three recordings, diffs correct; works after a Plaud sign-out and sign-in; refuses when Applaud's setting is off.                                   |
| **3. Writes**               | `PATCH`, results, undo, rate limit, conflict handling. First release limited to one recording per Apply.                                             | On Edge, against test recordings: apply, conflict (edit in Plaud between dry run and apply), partial failure then re-run, undo. Plaud AI uses the names. Applaud's sync confirms. |
| **4. Batch and release**    | Several recordings per Apply; release zip; README and install guide.                                                                                 | One week of normal use without a manual correction in Plaud.                                                                                                                      |

### 6.1 Phase 1 record

Built 2026-11-01 on branch `claude/festive-clarke-b4rw0t`.

| Item | State |
| ---- | ----- |
| Migration 6 (`plaud_writeback`, `plaud_writeback_log`, `plaud_writeback_clients`) | Done |
| Pending computation, refreshed wherever the `-Applaud` transcript is rebuilt (analysis, label and people changes, transcript resync) | Done, with route tests |
| Transform (W2 to W5) in `server/src/plaud-writeback/transform.ts` | Done, with unit tests on synthetic documents |
| Routes, extension-token guard, protocol check, kill switch, pairing and revoking | Done, with route tests |
| Settings toggle and pairing; recording panel with copy buttons and history; dashboard mark | Done; checked in a browser against a seeded install |
| Exit check: the panel's list matches what a manual rename in Plaud needs, for three real recordings | Passed (owner, 2026-11-01) |

Differences from the plan above:

- **Segments are addressed by `segment_uid` only.** A segment without one, or with a uid Plaud repeats, is never written; it stays as Plaud has it.
- **A recording is either written whole or not at all at plan time.** Any refusal in any document (a renamed or missing segment, a changed label, an unexpected shape) makes the whole recording `stale` until the next sync, rather than writing the parts that pass.
- **The summary placeholder is taken from the label** (`Speaker 2`) as well as from the name being replaced, so a re-run after a partial write still fixes the summary (W5).
- **Undo restores Plaud's previous content but not Applaud's labels.** After an undo the recording shows as having names to send again until the label is changed in Applaud.

### 6.2 Phase 2 record

Built 2026-11-01 on branch `claude/festive-clarke-b4rw0t`.

| Item | State |
| ---- | ----- |
| `extension/` workspace package: Manifest V3, esbuild (the version already in the lockfile), service worker, content script, popup | Done |
| Pairing: address and code in the popup, host permission for that one origin asked on the click, token in `chrome.storage.local` | Done |
| Content script reads `files/detail` and the three documents in the Plaud tab with the tab's token; the token is never stored or passed on | Done, with unit tests on synthetic responses |
| Dry run: `POST /api/plaud-writeback/plan` with `dryRun: true`, which records nothing and returns no plan id | Done, with a route test |
| No write code in the extension | Done; a test fails if `PATCH`, `update/content` or `origin_version` appears in its source |
| End to end in Chromium: built extension, real Applaud server, mock Plaud site shaped like the capture | Done: pairing, pending list, dry run, the tab check; the token went only to the API host, storage links carried no credentials, and Applaud recorded nothing |
| Exit checks on Edge against real Plaud: three recordings, after sign-out and sign-in, refusal while Applaud's setting is off | Passed (owner, 2026-11-01) |

Open questions, as far as Phase 2 can take them:

- **Q1 (API host and headers).** The host is taken from the requests the Plaud page has made (`performance` entries), else from any storage value naming an `api…plaud.ai` host. Reads send `authorization`, `app-platform`, `edit-from` and `app-language` only. Whether Plaud also needs `x-scope-id` or `x-device-id` is to be seen on real Plaud; **Check the Plaud tab** lists the names of storage keys that may hold them.
- **Q2 (storage CORS).** The signed links are fetched from the content script without credentials, as the page does. Confirmed against the mock only.
- **Q3 (several documents of a kind).** A kind Plaud has more than one of is left out and reported as a warning.

Differences from the plan above:

- **No fixed extension `key`.** The extension reaches Applaud through a host permission (W9), so its id does not need to be stable; this can be added when the extension is published.
- **The build is not part of `pnpm build`**, so the Docker image is unchanged. `pnpm build:extension` builds it.

### 6.3 Phase 3 record

Built 2026-11-01 on branch `claude/festive-clarke-b4rw0t`.

**Q1 answered on real Plaud (Phase 2):** reads work with `authorization`, `app-platform`, `edit-from` and `app-language` alone. The tab's storage holds `pld_plaud_user_api_domain`, `pld_DEVICE_ID` and `pld_session.workspace`. The extension now takes the API host from the first, and sends `x-device-id`, `x-scope-id` and `x-scope-type: workspace` from the other two, as the web app does (A.8). Writes have not yet been tried without them.

| Item | State |
| ---- | ----- |
| `writeDocuments` in `extension/src/plaud.ts`: the web app's `PATCH`, one document at a time in order, with a pause, `relation_content_ids` carried over for the summary | Done, with unit tests |
| Version checked against a fresh `files/detail` before each write, as well as by Plaud on the write (W6) | Done, with unit tests |
| Success only on `status: 0` with a new version; Plaud's conflict and any other status stop the run; a lost reply is reported as failed, never applied | Done, with unit tests |
| Send and undo sequence (`extension/src/send.ts`), results reported to Applaud, kept and retried when Applaud can't be reached | Done, with unit tests |
| Popup: **Send to Plaud** after a dry run, **Undo** with a second confirmation, **Recently sent** list (`GET /api/plaud-writeback/undoable`) | Done |
| One recording per send; a second send while one runs is refused | Done |
| The only `PATCH` in the extension is in `plaud.ts` | Enforced by a test |
| End to end in Chromium against a mock Plaud that enforces `origin_version`: send, undo (all three documents restored byte for byte), partial write then a second send that writes only what was missing | Done |
| Exit checks on Edge against real Plaud: apply, conflict (edit in Plaud between dry run and send), partial then re-run, undo; Plaud AI uses the names; Applaud's sync confirms | **Open** |

Differences from the plan above:

- **Undo walks back one send at a time.** Each undo restores the most recent send still in force; after a partial send and its completion, two undos restore the original.
- **A lost reply is reported as failed.** Plaud may have applied it; the next send reads Plaud afresh, so the work completes either way, but that one write is missing from the undo log.

## 7. Testing

- **Server:** Vitest for the transform (labels, overrides, owner, split labels, `Speaker 2` against `Speaker 20`, missing polished transcript or summary), pending computation, routes, token guard, kill switch and protocol check.
- **Extension:** Vitest with mocked `fetch` and `chrome.*` for the content script's read and write sequence, including the conflict and `status` handling.
- **Contract fixtures:** synthetic documents and responses with the captured shapes, so a change in Plaud's format fails a test rather than a write.
- **Manual:** a checklist per phase on Edge (section 6), run against recordings chosen for the purpose.

## 8. Risks

| Risk                                                     | Likelihood    | Impact | Mitigation                                                                                                              |
| -------------------------------------------------------- | ------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Plaud changes the web API or content format              | Medium        | Medium | Shape checks before every write (P6), contract fixtures, protocol version, kill switch; Phase 1 still works by hand.    |
| Plaud blocks or objects to the extension                 | Low to medium | Medium | Low request volume, user-initiated only (P4); no store listing at first (P9); the manual list remains.                  |
| Partial write leaves Plaud inconsistent                  | Low           | Low    | W5: the next run completes it; the panel shows the state.                                                               |
| Wrong name sent                                          | Low           | Medium | Confirmed names only (W3), dry run, undo (W11).                                                                         |
| Plaud session token exposed                              | Low           | High   | Read only in the content script, never stored or sent to Applaud (W8).                                                  |
| Summary wording reads oddly after replacement (pronouns) | Medium        | Low    | Accepted; Plaud does the same. Regenerating the summary in Plaud remains the user's choice.                             |
| Extension token leaked                                   | Low           | Medium | Scoped to write-back routes (W10), hashed, revocable; it cannot read audio or transcripts beyond what write-back needs. |

## 9. Open questions

| #   | Question                                                                                                                                | Resolve in                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Q1  | Where the web app keeps the regional API host, and the minimum set of headers a write needs (`x-scope-id`, `x-device-id`, `edit-from`). | Phase 2, by reading from the page and trying a read with fewer headers. |
| Q2  | Whether a content-script fetch of the signed content URLs is accepted by the storage host's CORS policy, as the page's own fetch is.    | Phase 2.                                                                |
| Q3  | Recordings with no polished transcript, no summary, or more than one summary (`relation_content_ids`).                                  | Phase 1 tests with synthetic cases; Phase 2 against real recordings.    |
| Q4  | Whether Plaud's "recently used names" list should be updated too. Not needed for Plaud AI; left alone unless it proves useful.          | After Phase 3.                                                          |

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
- [ ] **Authentication:** header _names_ only (for example `Authorization`, `x-…-token`, `x-device-id`, an app version). Is it a bearer token, a cookie, or both? In **Application** → Local storage / Cookies, note the _key name_ the token lives under, not its value.
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

| Item                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rename request: method, host, path                        | **No rename endpoint.** The web app rewrites the content client-side and sends three `PATCH https://api-euc1.plaud.ai/file-app/v4/files/update/content/<file_id>` requests, one each for the transcript, the polished transcript and the summary. Host is regional (`api-euc1`).                                                                                                                                                                                                 |
| Request body                                              | `{ object_id, content_id, content, origin_version }`, plus `relation_content_ids` on the summary. `content` is the **whole document** as a string: the full segment array (about 55 KB) for each transcript, and the full markdown for the summary.                                                                                                                                                                                                                              |
| What changed                                              | Transcripts: only `speaker` on the 79 segments whose `speaker` was `Speaker 2`; nothing else differs. Summary: a plain text replacement of `Speaker 2` with the name (14 occurrences); pronouns left as they were. Outline and other tabs not written.                                                                                                                                                                                                                           |
| Concurrency                                               | Each write sends `origin_version` (a millisecond version of the content being replaced); the response returns a new `version_ms`. **Plaud enforces it**: a write with a stale `origin_version` is refused with HTTP 200 and `{"status":-1800313,"msg":"version conflict, re-fetch and retry"}` (test A.10). Failures are reported in the body's `status`, not the HTTP status.                                                                                                   |
| Authentication mechanism (names only)                     | Bearer `authorization` header (named in the CORS preflight; stripped from the sanitised HAR). The web app keeps it in `localStorage` under `pld_tokenstr`, value prefixed `bearer `. No cookies are sent. A malformed token gives HTTP 401 `unauthorized`. Other headers: `app-language`, `app-platform`, `edit-from`, `traceparent`, `x-device-id`, `x-request-id`, `x-scope-id`, `x-scope-type`, `x-timezone-iana`. CORS allows only `https://web.plaud.ai`, with credentials. |
| Anti-bot or anti-forgery measures                         | None seen: no signature, nonce, CAPTCHA or challenge request. `x-request-id` is a random UUID.                                                                                                                                                                                                                                                                                                                                                                                   |
| Speaker addressed by                                      | Not addressed at all by the server: the client edits `speaker` values in the documents.                                                                                                                                                                                                                                                                                                                                                                                          |
| UI scope options offered                                  | To be recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `original_speaker` unchanged after rename                 | **Yes**, in the PATCH bodies and in Applaud's next sync: `transcript.json` and `transcript_polished.json` both show `original_speaker` `Speaker 2` with the new `speaker`, and `summary.md` carries the name. Applaud's key (D8) maps directly.                                                                                                                                                                                                                                  |
| How Plaud AI reads transcripts                            | Ask Plaud's retriever returns transcript chunks formatted `[start-end] [Speaker name]` followed by the text (`contextos-dproxy/v4/context/resource`). Whether those chunks are rebuilt after a rename is the open question below.                                                                                                                                                                                                                                                |
| Plaud AI uses the new name: new chat (and delay)          | Not separately tested; the existing-chat result makes a failure unlikely.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Plaud AI uses the new name: existing chat (and delay)     | **Yes.** Before the rename it answered with `Speaker 2`; within minutes afterwards, the same question in the same chat answered with the name (and inferred a pronoun).                                                                                                                                                                                                                                                                                                          |
| Replay from page console accepted                         | Passed. A replay from the page console with the token from `pld_tokenstr` is accepted; with a stale `origin_version` it is refused (A.10).                                                                                                                                                                                                                                                                                                                                       |
| Terms of service position                                 | Checked by the owner on 2026-11-01: no reference to automated access or to using the interface other than as provided.                                                                                                                                                                                                                                                                                                                                                           |
| **Decision:** continue to extension-context test, or stop | **Continue.** The P1 stop criterion (Plaud AI ignores the name) is not met. A.10 passed; terms checked. Spike closed.                                                                                                                                                                                                                                                                                                                                                            |

### A.9 Consequences for the design (provisional)

- **The extension must reproduce the web app's edit.** It reads the current transcript, polished transcript and summary, changes `speaker` where `original_speaker` matches, replaces the label in the summary, and writes all three back whole. This is the "whole-transcript write" risk in A.3; P5 and P6 carry the weight.
- **`origin_version` is the precondition guard** (P5). Plaud enforces it, so a document changed since the extension read it is refused by the server, not merely detected by the client. On a conflict the extension skips that recording and reports it; it does not re-fetch and retry automatically.
- **Success is `status: 0` in the body.** HTTP 200 alone does not mean the write was applied.
- **Run requests from the Plaud page, not the service worker.** The token is a bearer token held by the page in `localStorage` (`pld_tokenstr`), and CORS admits only `web.plaud.ai`. A content script that runs the edit in the page's context avoids handling the token in the extension's own storage (P7), at the cost of needing a Plaud tab open (consistent with P4).
- **The summary replacement is naive.** A whole-word match is needed so `Speaker 2` does not also match `Speaker 20`, and pronouns stay as Plaud wrote them.
- **The write is three requests, not one.** A failure part-way leaves Plaud inconsistent; the undo log must hold all three previous documents and their versions.

### A.10 Stale-version test

Settles whether `origin_version` can serve as the precondition guard (P5). It sends content identical to what Plaud already holds, so it cannot change the recording whatever the outcome.

1. Open the recording in the Plaud tab, with DevTools open on the Console.
2. From the earlier capture, take the **transcript** PATCH (the first of the three) as copied fetch. Its body carries the `origin_version` from _before_ the rename, which is now stale. The `content` already contains the name, so it matches Plaud's current transcript.
3. Run it in the Console and record the HTTP status and the response JSON (`status`, any message).
4. **Refused** (non-zero `status` or an HTTP error mentioning a version or conflict): Plaud enforces it, and it becomes the P5 guard.
   **Accepted:** Plaud does not enforce it. The extension must do its own fresh read and comparison immediately before each write, and the race window, though small, cannot be closed.

**Result (2026-11-01):** refused, HTTP 200 with `{"status":-1800313,"msg":"version conflict, re-fetch and retry"}`. Plaud enforces `origin_version`.
