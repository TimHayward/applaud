# Applaud HTTP API

The local server exposes a JSON API under `/api` and file serving under `/media`. Everything binds to `127.0.0.1:44471` by default (`0.0.0.0` in Docker).

**Authentication:** none by default on a local install; **always required in Docker**, where a token is generated on first start and printed to the container log (see the README). When a **LAN access token** is set (Settings → LAN Access), every `/api` and `/media` request must carry it as `Authorization: Bearer <token>`. Requests that can't set headers — `<audio>`/`<img>`/download links and `EventSource` — instead pass a short-lived signed **ticket** as `?ticket=` (get one from `GET /api/auth/ticket`). Tickets are read-only (GET/HEAD), expire on their own, are path-scoped, and are revoked by changing the LAN token; on `/api` they are accepted only by the two SSE streams. `/media` still accepts `?token=<lanToken>` for existing automations, but that form is **deprecated** — the raw token in a URL leaks into logs and history. `/api/health` is always unauthenticated. Tokens must be at least 16 characters, are compared in constant time, and repeated failures from one client get 429s.

**Host header:** requests arriving under an unrecognised hostname are rejected with 403 (DNS-rebinding defense). IP literals, `localhost`, `.local`/`.lan`/`.internal`/`.home.arpa`/`.ts.net` names, and `APPLAUD_ALLOWED_HOSTS` entries are accepted.

**Rate limits:** ~600/min per client on `/api`, ~900/min on `/media`, 20/min on `test-webhook` and `validate-recordings-dir`. Over the limit returns 429 with `Retry-After`. All caps are env-tunable (README).

**Response headers:** every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a CSP.

Types for every payload live in [`shared/src/api.ts`](../shared/src/api.ts) and [`shared/src/recording.ts`](../shared/src/recording.ts).

## Health & setup

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Liveness probe (used by the Docker `HEALTHCHECK`). Always `{ "ok": true }`, never gated by the LAN token, discloses nothing. |
| GET | `/api/setup/status` | `{ setupComplete, hasToken, hasRecordingsDir }` — drives the setup-wizard redirect. |

## Auth (Plaud session)

Applaud signs in to Plaud with OAuth (authorisation code + PKCE) against Plaud's hosted authorisation server, registering itself there by dynamic client registration.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/auth/status` | `{ connected, connectedAt, email, accessTokenExp, refreshTokenExp }` (expiries in seconds since epoch). |
| POST | `/api/auth/plaud/start` | Begin sign-in. Registers this install for the redirect URI the browser is using (once per URI) and returns `{ authorizeUrl, redirectUri }`; open `authorizeUrl` in the browser. |
| GET | `/api/auth/plaud/callback` | Where Plaud sends the browser back (`?code&state`). Completes the sign-in and shows a short page. **Not behind the LAN token**: a top-level navigation can't carry it, so the single-use, 15-minute `state` from `/plaud/start` authorises the request instead. |
| POST | `/api/auth/plaud/complete` | Fallback when the browser can't reach the redirect URI. Body: `{ callbackUrl }`, the full address the Plaud tab ended on. Returns `{ ok, email? }` or `{ ok: false, error }`. |
| POST | `/api/auth/disconnect` | Clear the session locally. Revocation at Plaud is attempted but Plaud's authorisation server currently offers none. |
| GET | `/api/auth/ticket` | `{ ticket, expiresAt }`: a signed ticket for media links and SSE, valid for `APPLAUD_BROWSER_TICKET_TTL_HOURS` (default 24). Both null when no LAN token is set. |

After setup, a completed sign-in starts a sync immediately.

## Config

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/config` | Current config with secrets (`token`, `lanToken`, `webhook.secret`) redacted to `***REDACTED***`. |
| POST | `/api/config` | Patch config. Accepts `recordingsDir`, `webhook` (`{ url, enabled?, secret? }` or `null`; http(s) only), `pollIntervalMinutes` (applies live), `bind` (returns `restartRequired: true`), `historyDays` (0–3650; raising it starts a sync for the newly covered recordings), `lanToken` (min. 16 chars), `publicBaseUrl` (http(s) base URL used for webhook `http_urls`; `""`/`null` clears it). Turning a webhook on stamps `webhook.enabledAt`; automatic re-delivery only covers recordings downloaded after it. Sending the redaction sentinel preserves the stored secret; empty string clears it. |
| POST | `/api/config/test-webhook` | POST a sample payload to a URL. Body: `{ url }` — http(s) only, must resolve to a public address unless `APPLAUD_WEBHOOK_ALLOW_PRIVATE=1`, redirects not followed. |
| POST | `/api/config/validate-recordings-dir` | Report a directory's existence, writability, and free space. Body: `{ path, create? }`. Read-only unless `create: true`, which makes a single directory under an existing parent (never a whole tree). |
| POST | `/api/config/clear-sync-ignore` | Clear the purge blocklist and trigger a sync. |
| POST | `/api/config/complete-setup` | Mark setup complete, record `installedAt` (the anchor for `historyDays`), and start the poller. |

## Recordings

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/recordings` | List. Query: `limit` (≤500, see `APPLAUD_RECORDINGS_MAX_LIMIT` in the README), `offset`, `search` (filename + transcript full-text), `from`/`to` (epoch-ms range on start time), `sort` (`date_desc` default, `date_asc`, `duration_desc/asc`, `size_desc/asc`), `starred` (`1` = only Plaud-starred). Returns `{ total, totalBytes, items }`. |
| GET | `/api/recordings/trash` | Soft-deleted recordings. Query: `limit`, `offset`. |
| GET | `/api/recordings/sync-blocklist` | Purged Plaud ids the poller skips. |
| GET | `/api/recordings/:id` | Detail: row + `transcriptText`, `summaryMarkdown`, `metadata`, `attachments`, plus `mediaBase` for building `/media` URLs. Rows no longer carry absolute `audioPath`/`transcriptPath`/`summaryPath`/`metadataPath`; files are `<mediaBase>/<audioFilename>`, `transcript.json`, `transcript.txt`, `summary.md`, `metadata.json`. `status` is `metadata_only` for recordings outside the history window that haven't been requested; `plaudIsTrans` says whether Applaud is still checking Plaud for a transcript; `downloadRequestedAt` is set once the user asked for an out-of-window recording. |
| DELETE | `/api/recordings/:id` | Soft-delete (moves to Applaud trash; auto-purge after ~7 days). |
| POST | `/api/recordings/:id/restore` | Restore from trash. |
| POST | `/api/recordings/:id/purge` | Purge immediately (removes files, blocklists the Plaud id). |
| POST | `/api/recordings/:id/download` | Download a recording that is outside the history window (`status: "metadata_only"`). Marks it as requested so later syncs keep it complete, starts the download in the background, and returns `202 { ok, recording }`. |
| POST | `/api/recordings/:id/resync` | Re-fetch transcript/summary/assets and re-fire the webhook. |
| POST | `/api/recordings/:id/rename` | Set a local title override. Body: `{ displayName: string \| null }` (`null` clears it). Cleared automatically on the recording's next resync — Plaud's filename is always authoritative once re-pulled from source. |

## Sync

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/sync/status` | `{ lastPollAt, nextPollAt, polling, pendingTranscripts, pendingSummaries, errorsLast24h, lastError, authRequired }`. |
| POST | `/api/sync/trigger` | Run a poll cycle now (queued if one is already in flight). |
| GET | `/api/sync/events` | SSE stream of sync events (`poll_start`, `poll_end`, `recording_new`, `recording_downloaded`, `recording_renamed`, `error`, `auth_required`) with a 15 s heartbeat. Accepts `?ticket=` (EventSource can't send headers). |

## Webhooks

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/webhooks/log` | Recent delivery attempts (each retry is a row), newest first, with the recording filename joined. Query: `limit` (≤200), `offset`. |
| POST | `/api/webhooks/redeliver` | Re-drive a webhook. Body: `{ recordingId, event: "audio_ready" \| "transcript_ready" }`. 502 if delivery fails again. |

Outgoing webhook payloads, headers, and HMAC signature verification (with `X-Applaud-Timestamp` replay protection) are documented in the root [`README.md`](../README.md#webhook-payload).

## Media

| Method | Path | Description |
| --- | --- | --- |
| GET | `/media/<folder>/<file>` | Serves files from the recordings directory with `Range` support (audio seeking). Path-traversal safe; 404 outside the recordings dir. Audio and raster images are served inline; everything else (`.svg`, `.html`, `.md`, `.json`, unknown types) comes back as `Content-Disposition: attachment`, and every response carries `Content-Security-Policy: default-src 'none'; sandbox`. Authenticate with the bearer header or `?ticket=` (deprecated: `?token=`). A file that disappears or is locked mid-request returns 404/500 rather than taking the server down. |
