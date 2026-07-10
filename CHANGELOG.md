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
