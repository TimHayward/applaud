# Changelog

All notable changes to Applaud are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Plaud 4.0 moved accounts to a new web platform, and the browser-session sign-in Applaud relied on stopped working. This release moves Applaud to Plaud's official developer API. Start from a fresh install: existing libraries and settings are not carried over.

### Changed
- **Sign-in is now OAuth.** **Sign in with Plaud** opens Plaud's own sign-in page; Applaud never sees your password and no longer reads browser cookies or Local Storage. Applaud registers itself with the authorisation server Plaud runs for its MCP integration (`mcp.plaud.ai`, dynamic client registration with PKCE) and renews its access token automatically. Works the same on Windows, macOS, Linux and Docker. If the browser can't reach the address Plaud sends it back to, paste that address into the sign-in step instead.
- **Recordings come from Plaud's official API** (`platform.plaud.ai/developer/api`) instead of the undocumented web API. Audio, transcript, polished transcript, outline, highlights, summary and every other note tab are saved per recording; `metadata.json` holds the recording's record without its short-lived signed links.
- Recording folders end in the **last** 8 characters of the Plaud id (Plaud's new ids share a long time-ordered prefix).
- Plaud's in-app anchors (`[](plaud://…)`) are removed from summaries.
- Content is only downloaded over https from Plaud's storage hosts (`APPLAUD_PLAUD_CONTENT_HOSTS` extends the list).

### Added
- **History window** (setup wizard and **Settings → History window**, default 30 days): only recordings from that many days before setup onwards are downloaded in full, plus everything recorded afterwards. Older recordings are listed with their details only.
- **Download** on a details-only recording (dashboard row or detail page, `POST /api/recordings/:id/download`) fetches that one recording in full.
- `GET /api/auth/status`, `POST /api/auth/plaud/start`, `GET /api/auth/plaud/callback`, `POST /api/auth/plaud/complete`, `POST /api/auth/disconnect`.

### Removed
- Browser session detection, login watching, and pasted `tokenstr` / `pld_ut` / `pld_urt` credentials (`/api/auth/detect`, `/accept`, `/validate`, `/watch`).
- **Import recordings deleted in Plaud** and the Plaud-trash probes: the official API does not expose Plaud's trash. Applaud's own Trash is unchanged.
- `APPLAUD_PLAUD_USER_AGENT`, `APPLAUD_POLLER_PAGE_OVERLAP` and the `APPLAUD_TRASH_PROBE_*` variables.

### Known gaps
- Images attached to summaries and any documents attached to recordings are not downloaded: the official API does not expose them.
- Plaud documents its MCP authorisation server for AI assistants. If Plaud restricts it to those, sign-in will stop working until Plaud offers app registration.
- Plaud's access token lasts 24 hours and its refresh token 7 days; each renewal issues a fresh 7-day refresh token (measured 2026-10-26). Applaud stays signed in as long as it runs at least once a week.
- Plaud's authorisation server has no revocation endpoint, so **Disconnect** clears the session in Applaud only.

## [0.5.12] - 2026-10-13

### Changed
- **Requires Node.js 22 or newer** (Node 20 reached end-of-life in April 2026). The Docker image now uses `node:22-slim`.
- **The database is migrated on first start** (versioned migrations; one-way). File locations are no longer stored as absolute paths, so you can move your recordings folder or change the Docker mount path without breaking the library.
- **API:** recording objects no longer include `audioPath`, `transcriptPath`, `summaryPath`, or `metadataPath`. Build file URLs from `mediaBase` + `audioFilename` (or the fixed names `transcript.json`, `transcript.txt`, `summary.md`, `metadata.json`). New `plaudIsTrans` field.
- Media links and live updates use short-lived signed tickets (`GET /api/auth/ticket`) instead of putting your LAN access token in URLs. `?token=` on `/media` still works for existing automations but is deprecated.
- Recordings Plaud hasn't transcribed yet are no longer re-requested from Plaud on every sync. Applaud waits until Plaud reports a transcript (**Resync** still checks on demand).

### Fixed
- Live sync updates now work when a LAN access token is set (always the case in Docker); previously the dashboard silently fell back to polling. The login watch in the setup wizard works there too.
- A media file that disappears or is locked mid-request no longer crashes the server.
- Old-style (legacy token) accounts that Plaud moves to another region now follow the redirect automatically instead of failing every sync.
- First-party sessions recover on their own when the stored Plaud workspace changes, and **Resync** refreshes an expired workspace token first.
- Plaud sign-in calls now time out instead of hanging a sync or the connect step.
- A sync cycle stopped by the 30-minute safety timeout now actually stops, rather than continuing in the background alongside the next one.
- Saving a webhook URL that isn't a URL returns a validation error instead of a server error.
- Turning on a webhook no longer replays your whole library. Automatic re-delivery only covers recordings downloaded after the webhook was enabled.
- A webhook receiver that is down no longer stalls syncing. Failed deliveries are retried with a growing back-off (5 min, then up to once a day, 8 tries; tunable via `APPLAUD_WEBHOOK_REDRIVE_*`), at most 10 per sync cycle. After that, use **Redeliver** in Settings.
- You can now reconnect an expired or revoked Plaud session: Settings → Account Details → **Reconnect Plaud account**. The "auth required" badge links there, and syncing resumes as soon as the new session is accepted.

### Added
- App version shown at the bottom of Settings.
- **Settings → Webhook Outbound → Public URL**: webhook `http_urls` use this address, and with a LAN access token each link carries a read-only ticket for that one recording (valid 7 days, `APPLAUD_WEBHOOK_URL_TTL_HOURS`), so receivers like n8n can download files without the token or URL rewriting.
- LAN access token: optional bearer/`?token=` auth gating `/api` and `/media` for LAN-exposed instances (Settings → LAN Access).
- `/api/health` liveness endpoint + Docker `HEALTHCHECK`; container now runs as the non-root `node` user.
- Webhook replay protection: signatures now cover `${timestamp}.${body}` and every signed delivery carries `X-Applaud-Timestamp`.
- Webhook delivery log in Settings with per-attempt status and a **Redeliver** button for failures (`GET /api/webhooks/log`, `POST /api/webhooks/redeliver`); per-recording webhook timestamps on the detail page.
- Dashboard: sorting (date/duration/size), date-range filter, starred-only filter, pagination, debounced search, bulk select with **Resync**/**Move to Trash**; Trash: pagination + bulk **Restore**/**Delete permanently**.
- Stars (Plaud `is_markmemo`) and tag ids (`filetag_id_list`) are now synced and shown; starred filter end-to-end.
- Recording detail: attachments gallery, file downloads (transcript/summary/metadata), copy buttons (transcript, summary, recording id), playback speed, volume, keyboard shortcuts (Space, ←/→), waveform drag-to-seek + keyboard seeking.
- Mobile navigation menu; toast notifications; styled confirmation dialogs replacing `window.confirm`.
- Token-expiry warning in the sync badge; badge now shows the actual sync error and a next-sync countdown.
- Setup wizard resumes after a refresh and completed steps are clickable.
- ESLint + Prettier, CI lint/build steps, coverage thresholds; `docs/api.md`, `CONTRIBUTING.md`, this changelog.
- Editable recording titles (`POST /api/recordings/:id/rename`) — local override shown everywhere in place of Plaud's filename; automatically cleared on the recording's next resync, since Plaud's filename is authoritative once re-pulled from source.
- Server tuning is now overridable via environment variables (`server/src/constants.ts`, documented in the README): retry counts, page sizes, webhook backoff schedule, trash retention/probe cadence, User-Agent, and the recordings-list limit cap.
- Real audio waveform: the player now decodes the audio (`AudioContext`) and renders actual amplitude peaks instead of a synthetic seeded shape, cached per recording, with a graceful fallback for very long/undecodable files.

### Accessibility
- Transcript click-to-seek is now a real button: reachable by Tab, activated with Enter/Space, and announced as "Play from &lt;timestamp&gt;, &lt;speaker&gt;".
- Closing a dialog, the expanded summary, or transcript search returns focus to whatever opened it instead of dropping it at the top of the page.
- Ctrl/Cmd+F opens transcript search when focus is inside the transcript, not just while hovering it.
- Error toasts announce assertively and stay long enough to read — timing now scales with message length, and messages over ~160 characters wait for you to dismiss them. Adding a toast no longer re-announces the ones already on screen.
- The Settings sync-status indicator uses a check / warning icon rather than colour alone.

### Security
- **Docker instances now require a LAN access token.** A container listens on `0.0.0.0`; on first start Applaud generates a token and prints it to the container log (`docker logs applaud`), then requires it on every `/api` and `/media` request. Pin your own with `APPLAUD_LAN_TOKEN`, or opt out with `APPLAUD_ALLOW_NO_AUTH=1` if something else authenticates in front. Local installs are unchanged (loopback, no auth unless you set a token).
- **Webhook targets must resolve to a public address.** The URL is validated (http(s) only, no embedded credentials) and resolved before connecting, and redirects are no longer followed — closing the SSRF read-oracle in **Test webhook**. Set `APPLAUD_WEBHOOK_ALLOW_PRIVATE=1` if your webhook target is on localhost or your LAN (n8n, Home Assistant, Node-RED).
- Files under `/media` are served with `X-Content-Type-Options: nosniff` and a sandboxing CSP, and anything that isn't audio or a raster image (`.svg`, `.html`, `.md`, `.json`, …) is served as a download — an `.svg` sitting in a recording folder can no longer run script in the app's origin.
- Requests arriving under an unknown `Host` are rejected (DNS-rebinding defense); add your own hostname with `APPLAUD_ALLOWED_HOSTS` when behind a reverse proxy.
- LAN tokens are compared in constant time, must be at least 16 characters, and repeated failed attempts are throttled. `/api` accepts the token by `Authorization` header only; `?token=` remains for `/media` elements, and every response sends `Referrer-Policy: no-referrer`.
- Per-IP rate limits on `/api`, `/media`, and the outbound/filesystem routes (all env-tunable).
- `POST /api/config/validate-recordings-dir` no longer creates directories implicitly: creation is opt-in and limited to a single folder under an existing parent. The setup wizard now offers an explicit **Create it** button.
- Windows: the config directory ACL is locked to your account and `SYSTEM` on first run (`icacls /inheritance:r`), since `chmod 600` does nothing there. Skip with `APPLAUD_SKIP_ACL_HARDENING=1`.

### Fixed (UI)
- Opening a second recording no longer inherits the previous one's playhead, open rename box, or resync error.
- The recordings and Trash lists no longer collapse to a skeleton on every keystroke or page turn — the current rows stay put (dimmed) while the next result loads.
- Editing Settings is no longer clobbered by a background config refresh; unsaved changes survive until you save or leave.
- Arrow keys on the waveform now step ±5% as documented, instead of being overridden by the player's ∓10s/+30s shortcut.
- Per-row resync errors on the dashboard are cleared when the filter, sort, or page changes, so a returning row can't show a stale message.
- Links inside an AI summary open in a new tab with `rel="noopener noreferrer"`.

### Changed
- Audio files are now saved and served under their true extension derived from Plaud's `filetype` (e.g. `audio.mp3`, `audio.opus`) instead of always `audio.ogg`; the download link, media URLs, and webhook payload all reference the real filename. Existing `audio.ogg` recordings are unaffected. Added `.opus`/`.flac`/`.webm` to the media content types.

### Changed
- Transcript speaker colors and the sync-status glow now read from CSS custom properties instead of hardcoded hex/rgba — fixes the status dot glow showing the wrong theme's color in light mode.
- Removed unused code: `md5File`, `listAll`, `resetConfigCache`, and the never-used `opus` param on `getAudioUrl`.

### Fixed
- 401 from Plaud no longer flips `setupComplete`; poll-interval changes apply live; bind changes report `restartRequired`.
- Atomic file writes (temp + rename) for audio/transcript/summary/metadata — crashes can no longer leave corrupt files that look complete.
- Manual resync no longer races the scheduled poll on the same recording.
- OGG duration "Infinity" display/seek bug; light-mode summary typography; Settings health label color; silent dashboard resync failures.
- SSE reconnects after network blips; AuthStep no longer leaks EventSources.
- `better-sqlite3` bumped to v12 (Node 20–26 support — v11 crashed at runtime on Node 26).
- Query-param validation on list routes; absolute recordings path no longer leaked to the browser; `install.ps1` version drift.

## [0.5.10] and earlier

See the [GitHub releases](https://github.com/rsteckler/applaud/releases) for prior history.
