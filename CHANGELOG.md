# Changelog

All notable changes to Applaud are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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

### Security
- **Docker instances now require a LAN access token.** A container listens on `0.0.0.0`; on first start Applaud generates a token and prints it to the container log (`docker logs applaud`), then requires it on every `/api` and `/media` request. Pin your own with `APPLAUD_LAN_TOKEN`, or opt out with `APPLAUD_ALLOW_NO_AUTH=1` if something else authenticates in front. Local installs are unchanged (loopback, no auth unless you set a token).
- **Webhook targets must resolve to a public address.** The URL is validated (http(s) only, no embedded credentials) and resolved before connecting, and redirects are no longer followed — closing the SSRF read-oracle in **Test webhook**. Set `APPLAUD_WEBHOOK_ALLOW_PRIVATE=1` if your webhook target is on localhost or your LAN (n8n, Home Assistant, Node-RED).
- Files under `/media` are served with `X-Content-Type-Options: nosniff` and a sandboxing CSP, and anything that isn't audio or a raster image (`.svg`, `.html`, `.md`, `.json`, …) is served as a download — an `.svg` sitting in a recording folder can no longer run script in the app's origin.
- Requests arriving under an unknown `Host` are rejected (DNS-rebinding defense); add your own hostname with `APPLAUD_ALLOWED_HOSTS` when behind a reverse proxy.
- LAN tokens are compared in constant time, must be at least 16 characters, and repeated failed attempts are throttled. `/api` accepts the token by `Authorization` header only; `?token=` remains for `/media` elements, and every response sends `Referrer-Policy: no-referrer`.
- Per-IP rate limits on `/api`, `/media`, and the outbound/filesystem routes (all env-tunable).
- `POST /api/config/validate-recordings-dir` no longer creates directories implicitly: creation is opt-in and limited to a single folder under an existing parent. The setup wizard now offers an explicit **Create it** button.
- Windows: the config directory ACL is locked to your account and `SYSTEM` on first run (`icacls /inheritance:r`), since `chmod 600` does nothing there. Skip with `APPLAUD_SKIP_ACL_HARDENING=1`.

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
