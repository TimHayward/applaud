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
>
> **2026-10-13 foundation review** (ahead of upcoming major features): full read of `server/`, `shared/`, and the core `web/` routes/components. New items below are tagged _(2026-10-13)_. Two stale entries were dropped — automatic webhook re-delivery (already shipped as poller Phase 2b, see archive §1) and the nested `applaud/` checkout (no longer on disk, archived §7). Migrations and `busy_timeout` were raised P3 → P2 as prerequisites for schema-changing feature work.

---

## 1. Bugs & correctness

_All P0/P1/P2 items from the 2026-10-13 review except the deferred ones below are remediated — see [backlog-completed.md](backlog-completed.md) (2026-10-13 P0 pass and foundation pass)._

- [ ] **P3 — `errorsLast24h` miscounts.** _(2026-10-13)_ It only counts errored rows whose audio or transcript was downloaded in the last 24 h. Rows that never downloaded (the usual error case) are excluded, and old errors on recently downloaded rows are included. Track `last_error_at` instead. (`server/src/sync/state.ts:444-452`)
- [ ] **P3 — `/media` double-decodes the path.** _(2026-10-13)_ Express already decodes route params; `resolveSafe` calls `decodeURIComponent` again, so a filename containing `%` 500s (`URIError`) and `%25xx` names resolve to the wrong file. The traversal check still holds, and the `/media` ticket guard deliberately mirrors the double decode so a folder-scoped ticket can't be escaped with `%252e%252e` — fix both together. (`server/src/routes/media.ts:139`, `server/src/auth/lan-token.ts`)

## 2. Security

- [ ] **P2 — Rate limiting keys on the proxy's IP behind a reverse proxy.** _(2026-10-13)_ `trust proxy` is never set, so behind the documented `APPLAUD_ALLOWED_HOSTS` reverse-proxy setup all clients share one bucket. One client's failed tokens count against everyone's auth-failure limit, and the 600/min API cap is shared. Add an opt-in `APPLAUD_TRUST_PROXY`. (`server/src/security/rate-limit.ts:30-32`, `server/src/index.ts:175`)
- [ ] **P3 — Bind host can be set to a LAN interface without a token outside Docker.** _(2026-10-13)_ `POST /api/config` accepts any `bind.host` (e.g. `0.0.0.0`) with no `lanToken` check, which re-opens the unauthenticated-LAN exposure the container path now prevents. Refuse a non-loopback bind unless a token is set (or `APPLAUD_ALLOW_NO_AUTH=1`). (`server/src/routes/config.ts:66-71`, `server/src/index.ts:249`)

## 3. Usability & UI

_All items from earlier reviews remediated — see [backlog-completed.md](backlog-completed.md) §3 (2026-07-28 pass). The reconnect gap is tracked in §1 above._

## 4. Feature enhancements

- [ ] **P3 — HTTP caching headers on `/media`.** No `ETag`/`Last-Modified`/`Cache-Control`, so audio (and the waveform's full-file decode fetch) re-downloads on every visit. (`server/src/routes/media.ts`)
- [ ] **P3 — Remove the deprecated `?token=<lanToken>` on `/media`.** _(2026-10-13)_ The UI and webhook URLs now use signed tickets; the raw-token query form is kept only so existing automations (e.g. older n8n flows) don't break. Drop it after a release or two, with a changelog notice. (`server/src/auth/lan-token.ts`)
- [ ] **P3 — Full-text search won't scale.** _(2026-10-13)_ Search is `LIKE '%q%'` over `filename` and the full `transcript_text` column (table scan, `%`/`_` not escaped, and it ignores `display_name`). Move to an SQLite FTS5 table before adding search-heavy features. (`server/src/sync/state.ts:288-292`)

## 5. Code quality & refactoring

- [ ] **P2 — Avoid downloading the full audio twice per detail-page open.** `<audio preload="metadata">` plus `useAudioPeaks` unconditionally `fetch`ing the entire file to decode peaks (for anything under 20 min), even if the user never presses play. Decode from the already-fetched media or gate the decode on first play. (`web/src/components/AudioPlayer.tsx:215`, `web/src/components/Waveform.tsx:97`)
- [ ] **P2 — `webhook_log` grows without bound.** _(2026-10-13)_ Every attempt inserts a row and nothing prunes. Re-drive is now backed off and capped (2026-10-13 P0 pass), so growth is slow, but the log still never shrinks. Add retention (age or row cap) on startup/poll. (`server/src/webhook/post.ts:145-160`, `server/src/webhook/log.ts`)
- [ ] **P3 — Webhook requests send a stale `applaud/0.1.0` user-agent.** _(2026-10-13; the duplicated Plaud UA half was fixed in the foundation pass)_ Derive it from the package version. (`server/src/webhook/post.ts`)
- [ ] **P3 — `GET /api/recordings/:id` rewrites files on disk.** _(2026-10-13)_ A read endpoint calls `repairSummaryMarkdownFile`, which does a non-atomic `writeFileSync`. Move the repair into the sync path (or a one-off migration) and use `writeFileAtomic`. (`server/src/routes/recordings.ts:195`, `server/src/plaud/transcript.ts:221`)
- [ ] **P3 — Unbounded module-level `peaksCache` never evicts.** ~160 numbers per entry, but it grows for the tab's lifetime across every recording visited. Add an LRU cap. (`web/src/components/Waveform.tsx:27`)
- [ ] **P3 — Fragile webhook-secret sentinel protocol.** The `"***REDACTED***"` magic string means "keep existing," so a real secret equal to it silently won't save. Use an explicit omit-field/boolean protocol. (`web/src/routes/Settings.tsx:75`, `server/src/routes/config-helpers.ts:33-40`)
- [ ] **P3 — Streamed-OGG `1e101` duration hack can yank the playhead to 0.** The `durationchange` reset fires on any `currentTime > duration` overshoot; guard it to fire only for the hack sentinel value. (`web/src/components/AudioPlayer.tsx:83,95`)

## 6. Testing

- [ ] **P2 — Remaining test gaps.** The 2026-10-13 passes added coverage for everything they touched (migrations, tickets, `/media` streaming, `routes/auth`, re-drive, watchdog, `is_trans`, region redirects, stale-workspace recovery). Still untested: `routes/sync.ts`, `routes/webhooks.ts`, `auth/{chrome-leveldb,profiles,browser-watch}.ts`, and the `saveConfig` corrupt-JSON fallback (`server/src/config.ts`). The web UI has no component/browser tests at all — the Settings reconnect panel and ticketed media were verified by typecheck, build, and a live API smoke test only.

## 7. Infra, tooling & docs

- [ ] **P3 — `install.ps1` / README fork mismatch.** The README's PowerShell one-liner fetches `install.ps1` from `rsteckler/applaud@v0.5.11`, but the script clones `TimHayward/applaud` and its header comment references `TimHayward/.../main`. Reconcile the source of truth. (`install.ps1:4,16`, `README.md:38`)
- [ ] **P3 — `docker-compose.yml` contradicts the README.** The committed file has `build: .` active with no `image:` line, but README §"Docker Compose" tells users to "uncomment `build: .` (and comment out `image:`)" to build from source. Align the file with the documented pull-by-default flow, or update the docs. (`docker-compose.yml:3`, `README.md:229`)
