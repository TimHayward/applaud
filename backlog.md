# Applaud — Improvement Backlog

Active, open work only. Completed items are archived in [backlog-completed.md](backlog-completed.md); user-facing release notes live in [CHANGELOG.md](CHANGELOG.md).

Add a new item under the matching category below with a `- [ ]` checkbox and a **Pn** priority, citing the file(s) involved (e.g. `server/src/foo.ts:42`) so it can be picked up directly. When an item ships, move it — with its remediation note — into the archive.

**Priority scheme**

| Priority | Meaning |
| --- | --- |
| **P0** | Fix now — bugs, broken behavior, security gaps |
| **P1** | High value — quick wins with big usability payoff |
| **P2** | Enhancements — features and quality-of-life |
| **P3** | Nice to have — longer-term / polish |

> Populated from a full code review on 2026-07-21 (server security, sync/correctness, and web frontend). The highest-severity items were verified first-hand against the running app; the rest are cited to `file:line` for direct pickup.

---

## 1. Bugs & correctness

_All items remediated — see [backlog-completed.md](backlog-completed.md) §1 (2026-07-23 pass)._

## 2. Security

_All items remediated — see [backlog-completed.md](backlog-completed.md) §2 (2026-07-27 pass)._

## 3. Usability & UI

- [ ] **P2 — Detail page keeps stale state across recordings.** `/recordings/:id` reuses the same element, so navigating A→B carries A's playhead, an open rename box, and any resync error until events overwrite them. Add `key={id}` to force a remount. (`web/src/routes/RecordingDetail.tsx`, `web/src/App.tsx:46`)
- [ ] **P2 — List collapses to a skeleton on every search/page change.** No `placeholderData: keepPreviousData`, so `list.data` drops to `undefined` and the total/pagination footer flickers away and back on each keystroke and page turn. (`web/src/routes/Dashboard.tsx:121`, `web/src/routes/Trash.tsx:15`)
- [ ] **P2 — Background config refetch silently wipes unsaved Settings edits.** The reset effect reruns on any `cfg.data` reference change (the always-mounted sync badge keeps `["config"]` alive and several mutations invalidate it); a refetch mid-edit clobbers the form. Guard "don't reset while dirty." (`web/src/routes/Settings.tsx:40-55`)
- [ ] **P2 — Waveform arrow-key seek is broken by a double handler.** The slider's `onKeyDown` (±5%) and the document-level AudioPlayer handler (∓10s/+30s) both fire with no `stopPropagation`, and the global one wins, so the documented waveform arrow behavior never happens. (`web/src/components/Waveform.tsx:192-210`, `web/src/components/AudioPlayer.tsx:101-118`)
- [ ] **P2 — Transcript click-to-seek is not keyboard-accessible.** Seek is a bare `<div onClick>` with no `role`/`tabIndex`/`onKeyDown`, so keyboard and screen-reader users can't seek from the transcript. Make each block a `<button>` (or add `role="button"` + Enter/Space). (`web/src/components/TranscriptCard.tsx:293-300`)
- [ ] **P2 — Dialogs/overlays don't restore focus on close.** `ConfirmDialog`, `SummaryPanel`, and the transcript-search close drop focus to `<body>` (the trap, Escape, and initial focus are all correct). Capture `document.activeElement` on open and refocus it on close. (`web/src/components/ConfirmDialog.tsx`, `web/src/components/SummaryPanel.tsx`, `web/src/components/TranscriptCard.tsx:151,267`)
- [ ] **P3 — Error toasts announce weakly, auto-dismiss too fast, and re-announce siblings.** Use `role="alert"`/`aria-live="assertive"` for errors, don't fixed-5s-dismiss long error messages, and move `aria-atomic` off the whole list so adding one toast doesn't re-announce all of them. (`web/src/components/Toast.tsx:41,56-63`)
- [ ] **P3 — Ctrl/Cmd+F transcript search requires mouse hover.** The shortcut only binds while hovering, so a keyboard-only user who has tabbed into the transcript can never open in-card search. Also enable it on focus-within. (`web/src/components/TranscriptCard.tsx:137-148`)
- [ ] **P3 — Stale per-row resync errors persist across filter/sort/page changes.** The error map is keyed by id and only cleared on the next resync of that row, so a reappearing row shows an old error. (`web/src/routes/Dashboard.tsx:136,153`)
- [ ] **P3 — Settings health dot conveys state by color only.** Pair the dot with a text/icon cue for color-blind users. (`web/src/routes/Settings.tsx:164`)
- [ ] **P3 — Summary-markdown external links lack `rel="noopener noreferrer"`.** Links open in-tab with `window.opener` intact. (`web/src/components/SummaryPanel.tsx`)

## 4. Feature enhancements

- [ ] **P2 — Automatic webhook re-delivery / retry queue.** Pairs with the Bugs §2 item: drive undelivered `*_fired_at IS NULL` rows on each poll instead of relying on the manual Redeliver button, so deliveries lost after the in-process backoff window recover on their own. (`server/src/sync/poller.ts`, `server/src/webhook/post.ts`)
- [ ] **P2 — Signed short-lived media URLs.** Replace the raw `lanToken` in `?token=` (used by `<audio>`/`<a>` elements) with an expiring signed URL, so bearer credentials stop leaking into logs, history, and `Referer`. (`server/src/routes/media.ts`, `web/src/api.ts`)
- [ ] **P3 — HTTP caching headers on `/media`.** No `ETag`/`Last-Modified`/`Cache-Control`, so audio (and the waveform's full-file decode fetch) re-downloads on every visit. (`server/src/routes/media.ts`)

## 5. Code quality & refactoring

- [ ] **P2 — Avoid downloading the full audio twice per detail-page open.** `<audio preload="metadata">` plus `useAudioPeaks` unconditionally `fetch`ing the entire file to decode peaks (for anything under 20 min), even if the user never presses play. Decode from the already-fetched media or gate the decode on first play. (`web/src/components/AudioPlayer.tsx:191`, `web/src/components/Waveform.tsx:97`)
- [ ] **P3 — Migrations swallow all errors; no `user_version` gate.** Each `ALTER TABLE` is wrapped in `catch {}` that ignores the whole error class, so a genuinely failed migration (locked DB, disk full) is silent and surfaces later as a "no such column" runtime error, and backfill scans re-run on every boot. Add `PRAGMA user_version` versioning and narrow the catch to "duplicate column." (`server/src/db.ts:83-198`)
- [ ] **P3 — No SQLite `busy_timeout`.** WAL is enabled but no busy timeout is set; combined with the Docker no-PID-lock path, two containers on one mounted volume would both open the DB and hit immediate `SQLITE_BUSY`. (`server/src/db.ts:24-26`)
- [ ] **P3 — Unbounded module-level `peaksCache` never evicts.** ~160 numbers per entry, but it grows for the tab's lifetime across every recording visited. Add an LRU cap. (`web/src/components/Waveform.tsx:27`)
- [ ] **P3 — Fragile webhook-secret sentinel protocol.** The `"***REDACTED***"` magic string means "keep existing," so a real secret equal to it silently won't save. Use an explicit omit-field/boolean protocol. (`web/src/routes/Settings.tsx:70`)
- [ ] **P3 — Streamed-OGG `1e101` duration hack can yank the playhead to 0.** The `durationchange` reset fires on any `currentTime > duration` overshoot; guard it to fire only for the hack sentinel value. (`web/src/components/AudioPlayer.tsx:62,74`)

## 6. Testing

- [ ] **P2 — Add regression tests for the correctness bugs above.** Highest value: suffix byte-range serving (`server/src/routes/media.ts`), resync double-fire (`server/src/routes/recordings.ts`), fetch-timeout/hang recovery (`server/src/sync/poller.ts`), and the non-atomic `saveConfig` corrupt-fallback path (`server/src/config.ts`). The `auth`/`config`/`sync` route handlers and `auth/{chrome-leveldb,profiles,browser-watch}.ts` also remain untested (carried over from the prior review).

## 7. Infra, tooling & docs

- [ ] **P3 — `install.ps1` / README fork mismatch.** The README's PowerShell one-liner fetches `install.ps1` from `rsteckler/applaud@v0.5.11`, but the script clones `TimHayward/applaud` and its header comment references `TimHayward/.../main`. Reconcile the source of truth. (`install.ps1:4,16`, `README.md:38`)
- [ ] **P3 — `docker-compose.yml` contradicts the README.** The committed file has `build: .` active with no `image:` line, but README §"Docker Compose" tells users to "uncomment `build: .` (and comment out `image:`)" to build from source. Align the file with the documented pull-by-default flow, or update the docs. (`docker-compose.yml`, `README.md:221-229`)
- [ ] **P3 — Stale nested `applaud/` checkout on disk.** A gitignored duplicate copy (from 2026-05-01) sits in the repo root; harmless but confusing. Remove it. (`applaud/`)
