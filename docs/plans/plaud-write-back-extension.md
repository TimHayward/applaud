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
