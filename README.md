# Applaud

A self-hosted local server that mirrors your [Plaud](https://plaud.ai) recordings to disk and fires webhooks when new recordings or transcripts arrive, so you can easily hook it up to n8n (or any other custom integration). Runs on your machine, signs in through Plaud's own OAuth page, and ships with a web UI for setup and browsing.

> Applaud is not affiliated with Plaud. It uses Plaud's official developer API, signing in through the OAuth server Plaud runs for its MCP integration (`mcp.plaud.ai`). Plaud documents that server for AI assistants rather than for apps like this one, so treat the integration as best effort.


## Features

- **Automatic sync** — polls Plaud every 10 minutes (configurable) and downloads audio, transcripts, AI summaries and other note tabs to local disk
- **History window** — downloads only the last N days (default 30) before install in full; older recordings are indexed as details only and can be downloaded one at a time
- **Full-text search** — search recordings by filename or transcript content
- **Audio player** — custom player with waveform visualization, play/pause, skip -10s/+30s, click-to-seek
- **Transcript viewer** — speaker-labeled, timestamped, color-coded blocks with auto-scroll during playback, click-to-seek, and full-text search within transcripts
- **Speaker identification** — optional and off by default: recognises people by voice across recordings, with names you confirm applied to a separate `-Applaud` transcript. Runs entirely on your host (Docker image; see [Speaker identification](#speaker-identification))
- **AI summaries** — rendered markdown with expandable full-screen modal for long summaries
- **Webhooks** — POST JSON payloads on `audio_ready` and `transcript_ready` events for n8n, Zapier, or custom integrations
- **Dark & light mode** — toggle between themes, defaults to system preference
- **Setup wizard** — guided 5-step onboarding (auth, folder, webhook, review)

![Recordings dashboard](assets/Screenshot%202026-04-11%20203407.png)

![Recording detail](assets/Screenshot%202026-04-11%20203843.png)

## Install

First, you should never run commands you find on the internet that end in `| sh`. With that said, here's the easiest way to install Applaud:

**macOS / Linux / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/TimHayward/applaud/v0.6.0/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/TimHayward/applaud/v0.6.0/install.ps1 | iex
```

The installer does everything needed to install Applaud into a subfolder named `./applaud`. To run it:

```bash
cd applaud
pnpm start
```

Your browser will open to `http://127.0.0.1:44471/setup`. Walk through the 5-step wizard and you're done.

### Manual install

```bash
git clone https://github.com/TimHayward/applaud.git
cd applaud
pnpm install
pnpm build
pnpm start
```

Requires Node.js >= 22 and pnpm >= 9.

## How it works

1. **Auth:** Applaud signs in with OAuth. In the setup wizard, **Sign in with Plaud** opens Plaud's own sign-in page in a new tab; you approve access and Plaud sends the tab back to Applaud. Applaud never sees your Plaud password.
   - Plaud does not let individuals register developer apps, so Applaud registers itself with the authorisation server Plaud runs for its MCP integration (`mcp.plaud.ai`, dynamic client registration with PKCE). The token it receives works against Plaud's official developer API (`platform.plaud.ai/developer/api`).
   - The access token (24 hours) renews itself from a refresh token (7 days); each renewal issues a fresh 7-day refresh token, so Applaud stays signed in as long as it runs at least once a week. If Plaud refuses the refresh token (expired or revoked), syncing pauses and Settings asks you to sign in again.
   - Running Applaud somewhere that reaches the internet only through an `HTTPS_PROXY`? Node's built-in `fetch` ignores that variable unless you also set `NODE_USE_ENV_PROXY=1` (Node 22.21 or newer).
   - Plaud sends the browser back to the address you opened Applaud on (for example `http://127.0.0.1:44471` or `http://nas.lan:44471`), so the browser must be able to reach that address. If the Plaud tab ends on a page that won't load, paste its address into the box under the sign-in button and Applaud finishes the sign-in.

2. **Sync:** every 10 minutes (configurable), Applaud lists your recordings and stores their details. Recordings inside the **history window** (from *N* days before setup onwards; Settings → History window) are then downloaded in full: Applaud fetches each recording's record and immediately downloads its audio (Plaud's signed links expire after an hour), transcript, polished transcript, outline, highlights, summary and any other note tabs. Older recordings stay as details only until you press **Download** on one. Content is only fetched over https from Plaud's storage hosts.

3. **Webhook:** if configured, Applaud POSTs a JSON payload to your URL whenever a new `audio_ready` or `transcript_ready` event happens. Includes file paths (relative to your recordings dir) plus ready-to-fetch HTTP URLs that the local media server serves, and — on `transcript_ready` — the flattened transcript text and summary markdown inline so n8n-style workflows don't need a second fetch.

## Folder layout

Each recording gets its own folder under your chosen recordings directory:

```
<recordings-dir>/
  2026-04-11_My_meeting_title__b8c9d0e1/   # date, title, last 8 characters of the Plaud id
    audio.ogg
    transcript.json            # Plaud transcript segments (speaker + timestamps)
    transcript.txt             # speaker-labeled, timestamped plaintext
    transcript_polished.json   # Plaud's cleaned-up transcript (when available)
    outline.json               # topic outline (when available)
    highlights.json            # moments flagged with the device button (when available)
    summary.md                 # Plaud's AI summary (when available)
    <Tab_name>__<type>__<id>.md  # any other note tab (templates, saved Ask Plaud answers)
    metadata.json              # the recording's record from Plaud, without its signed links
    transcript-Applaud.json    # Plaud's transcript with Applaud's speaker names (speaker identification only)
    transcript-Applaud.txt     # the same, as plaintext
```

## Webhook payload

```json
{
  "event": "audio_ready | transcript_ready",
  "recording": {
    "id": "74560101636422f79bacd66696bab17b",
    "filename": "04-11 Validation of Automated Transcription...",
    "start_time_ms": 1775929909000,
    "duration_ms": 22000,
    "filesize_bytes": 95744,
    "serial_number": "8810B30227298497"
  },
  "files": {
    "folder": "2026-04-11_...__74560101",
    "audio": "2026-04-11_...__74560101/audio.ogg",
    "transcript": "2026-04-11_...__74560101/transcript.json",
    "summary": "2026-04-11_...__74560101/summary.md"
  },
  "http_urls": {
    "audio": "http://127.0.0.1:44471/media/2026-04-11_...__74560101/audio.ogg",
    "transcript": "http://127.0.0.1:44471/media/2026-04-11_...__74560101/transcript.json",
    "summary": "http://127.0.0.1:44471/media/2026-04-11_...__74560101/summary.md"
  },
  "content": {
    "transcript_text": "[00:01] Speaker: ...",
    "summary_markdown": "## Core Synopsis\n\n..."
  }
}
```

- `content` is only present on `transcript_ready` events. Both fields are nullable — if Plaud didn't generate a summary for a recording, `summary_markdown` will be `null`.
- `http_urls` are rooted at **Settings → Webhook Outbound → Public URL** (`publicBaseUrl`). Set it to an address your receiver can reach (e.g. `http://192.168.1.20:44471`); left empty, URLs use `127.0.0.1`, which only works when the receiver runs on the same machine. When a LAN access token is set, each URL carries a `?ticket=` that grants read-only access to that one recording's folder for 7 days (`APPLAUD_WEBHOOK_URL_TTL_HOURS`), so receivers can download files without ever holding the token.
- Failed deliveries are retried automatically on later syncs with a growing back-off (see `APPLAUD_WEBHOOK_REDRIVE_*` below). Turning a webhook on doesn't replay recordings downloaded before it was enabled; use **Redeliver** in Settings for those.
- Webhook consumers should treat `(id, event)` as idempotent. `audio_ready` always fires before `transcript_ready`; on recordings that are already fully transcribed when first seen, both fire back-to-back in the same poll cycle.
- Custom headers on every webhook: `User-Agent: applaud/0.1.0` and `X-Applaud-Event: audio_ready|transcript_ready`.

### Verifying the signature

If you set a signing secret on the Settings page, every outgoing webhook (including the test one from the Settings **Test** button) includes two extra headers:

```
X-Applaud-Timestamp: <unix seconds>
X-Applaud-Signature: sha256=<hex>
```

where the hex is the HMAC-SHA256 of `<timestamp>.<raw request body>`, keyed with your secret — not the body alone. Both headers are absent entirely when no secret is configured, so receivers can distinguish "signing not configured" from "signing failed." Including the timestamp in the signed message lets receivers reject old, replayed requests instead of just checking the hash.

**Node.js example** (Express):

```js
import crypto from "node:crypto";
import express from "express";

const SECRET = process.env.APPLAUD_WEBHOOK_SECRET;
const MAX_CLOCK_SKEW_SEC = 5 * 60;
const app = express();

app.post("/ingest", express.raw({ type: "application/json" }), (req, res) => {
  const header = req.get("x-applaud-signature") ?? "";
  const timestamp = req.get("x-applaud-timestamp") ?? "";
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SEC) {
    return res.status(401).send("stale timestamp");
  }
  const signedMessage = `${timestamp}.${req.body.toString("utf8")}`;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(signedMessage).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send("bad signature");
  }
  const payload = JSON.parse(req.body.toString("utf8"));
  // ... handle payload
  res.sendStatus(200);
});
```

**Python example** (Flask):

```python
import hmac, hashlib, os, time
from flask import Flask, request, abort

SECRET = os.environ["APPLAUD_WEBHOOK_SECRET"].encode()
MAX_CLOCK_SKEW_SEC = 5 * 60
app = Flask(__name__)

@app.post("/ingest")
def ingest():
    header = request.headers.get("X-Applaud-Signature", "")
    timestamp = request.headers.get("X-Applaud-Timestamp", "0")
    if abs(time.time() - int(timestamp)) > MAX_CLOCK_SKEW_SEC:
        abort(401)
    signed_message = timestamp.encode() + b"." + request.get_data()
    expected = "sha256=" + hmac.new(SECRET, signed_message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(header, expected):
        abort(401)
    payload = request.get_json(force=True)
    # ... handle payload
    return "", 200
```

Both snippets verify against the raw request bytes — don't re-serialize the JSON before signing, or the hash won't match.

## n8n workflows

The `n8n/` folder contains importable n8n workflow templates. To use one, open n8n, create a new workflow, then **Import from File** and select the JSON file. See [`n8n/README.md`](n8n/README.md) for setup details.

![n8n workflow](assets/Screenshot%202026-04-11%20205220.png)

![Settings](assets/Screenshot%202026-04-11%20204912.png)

## Docker

> **Portainer:** see [`docs/portainer.md`](docs/portainer.md) for a step-by-step guide (stack built from this repository, LAN-only access, network requirements, updates and backups).

Each release publishes an image for linux/amd64 and linux/arm64 as `ghcr.io/timhayward/applaud:v0.6.0` and `:latest`. To build from source instead:

```bash
git clone https://github.com/TimHayward/applaud.git
cd applaud
docker compose up -d --build
```

`docker-compose.yml` builds the image, creates the `config` and `recordings` volumes, and reads three optional variables (from the shell or an `.env` file):

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLAUD_PORT` | `44471` | Host port |
| `APPLAUD_ALLOWED_HOSTS` | empty | Hostname(s) you open Applaud on, when not an IP or a `.lan`/`.local` name |
| `APPLAUD_LAN_TOKEN` | generated | Pin the LAN access token (first start only) |

Open `http://<host>:44471/setup` (with `?token=…`, see below), click **Sign in with Plaud**, and enter `/data/recordings` as the recordings folder. The container needs outbound HTTPS to Plaud (`mcp.plaud.ai`, `platform.plaud.ai`, Plaud's storage on `*.amazonaws.com`) but no inbound access from the internet.

### Docker access token

A container listens on `0.0.0.0`, so anything that can route to it could otherwise read every recording and change your config. Applaud therefore **requires a LAN access token in container mode**: on first start it generates one and prints it to the container log —

```bash
docker logs applaud
#   ┌─ LAN access token generated ────────────────────────────────
#   │  8264b0defd648c33878b9ec045c726fefe7537c72057e494
```

Open `http://<host>:44471/?token=<token>` once per browser (it's saved in local storage and stripped from the URL), or change it later in **Settings → LAN Access**. Every `/api` and `/media` request needs it; `/api/health` stays open for the healthcheck.

- Pin your own with `APPLAUD_LAN_TOKEN=<at least 16 chars>`.
- Already have an authenticating reverse proxy in front? `APPLAUD_ALLOW_NO_AUTH=1` disables the requirement.
- Serving it on a real hostname through that proxy? Add it to `APPLAUD_ALLOWED_HOSTS` (see the table below) — requests arriving under an unknown hostname are rejected as DNS rebinding.

A local (non-Docker) install still binds `127.0.0.1` and stays unauthenticated by default; set a token only if you open it to your LAN.

## Speaker identification

Turn it on in **Settings → Speaker identification**. Applaud analyses each downloaded recording once in the background and learns your voice from recordings where Plaud tagged you. Name other people in the **Speakers** panel on a recording's page; from then on they are named automatically when the match is clear, and suggested when it is close. Plaud's own transcript files are never modified.

The speaker model ships in the Docker image and runs inside the container, so audio and voiceprints never leave your host. Voiceprints are biometric data: they stay in Applaud's database and are not included in webhooks. A non-Docker install has no model by default; run `node scripts/fetch-speaker-model.mjs models` from the install folder to fetch it. Requirements, resource use and tuning are in the [Portainer guide](docs/portainer.md#speaker-identification), and they apply to any Docker host.

## Running in the background

Applaud is a foreground process. To keep it running without a terminal:

**macOS (launchd):** create `~/Library/LaunchAgents/dev.applaud.plist` pointing to `pnpm start` in the install dir.

**Linux (systemd user):** create `~/.config/systemd/user/applaud.service` with `ExecStart=pnpm --dir=%h/applaud start`.

**Both platforms:** or just run it inside `tmux` / `screen`.

## Config

Settings live in `~/.config/applaud/settings.json` (or `~/Library/Application Support/applaud/` on macOS, `%APPDATA%\applaud\` on Windows). Recording state is in `state.sqlite` alongside. Both are managed through the web UI — you shouldn't need to edit them by hand.

The Plaud OAuth tokens (access and refresh) are stored as plaintext in `settings.json` (with `chmod 600`). The file lives in a user-only directory, and the tokens' scope is equivalent to "read this user's own Plaud data." The web UI never receives these values back — they're redacted in the config API. **Settings → Account Details** lets you sign in again; `POST /api/auth/disconnect` forgets the session (Plaud's authorisation server offers no revocation, so it can't be cancelled at Plaud's end). OS keychain integration is a future enhancement.

**On Windows**, `chmod 600` is a no-op, so on first run Applaud restricts the ACL on `%APPDATA%\applaud\` instead (`icacls /inheritance:r`, granting only your account and `SYSTEM`) and drops an `.acl-hardened` marker so it only does this once. The tokens, your `lanToken`, and `webhook.secret` are still stored in cleartext — anything running as your user can read them. Set `APPLAUD_SKIP_ACL_HARDENING=1` to skip the ACL change; DPAPI-encrypted storage is a future enhancement.

### Security notes

- **Webhook targets must be public by default.** Applaud resolves the URL and refuses private, loopback, and link-local addresses before connecting, so the "Test" button can't be used to probe your machine or LAN. Pointing it at a local n8n / Home Assistant / Node-RED instance is a normal thing to want — set `APPLAUD_WEBHOOK_ALLOW_PRIVATE=1` for that. Redirects are never followed (a 3xx is logged as a failed delivery).
- **Files under `/media` are served as downloads** unless they're audio or a raster image, with `nosniff` and a sandboxing CSP, so an `.svg`/`.html` file inside a recording folder can't run script in the app's origin.
- **Requests must arrive under a known hostname** — an IP literal, `localhost`, a `.local`/`.lan`/`.internal`/`.home.arpa`/`.ts.net` name, your `bind.host`, or something in `APPLAUD_ALLOWED_HOSTS`. This is what stops a web page you visit from rebinding its own domain to `127.0.0.1` and driving the API.
- **`/api` takes the LAN token by `Authorization: Bearer` header only.** Things that can't send headers — audio/image/download links and the live-update stream — use a short-lived signed `?ticket=` instead: read-only, scoped, expiring, and revoked when you change the token. The raw token never appears in a URL the UI generates. (`?token=<token>` on `/media` still works for existing automations but is deprecated.) The `?token=` in the share link from Settings → LAN Access is stripped from the address bar after first load.

### Advanced tuning (environment variables)

These are optional and only matter for unusual setups (very large libraries, flaky networks, stricter retention). Defaults match what Applaud has always shipped with.

| Variable | Default | What it controls |
| --- | --- | --- |
| `APPLAUD_PLAUD_MAX_ATTEMPTS` | `3` | Retries for a single Plaud API call |
| `APPLAUD_PLAUD_OAUTH_ISSUER` | `https://mcp.plaud.ai` | Plaud OAuth authorisation server (registration, sign-in, tokens) |
| `APPLAUD_PLAUD_API_BASE` | `https://platform.plaud.ai/developer/api` | Plaud developer API |
| `APPLAUD_PLAUD_CONTENT_HOSTS` | unset | Extra hosts (comma-separated, suffix match) Plaud's signed content links may use, beyond `amazonaws.com` and `plaud.ai` |
| `APPLAUD_POLLER_PAGE_SIZE` | `50` | Page size when walking your Plaud recording list |
| `APPLAUD_POLLER_MAX_PAGES` | `200` | Hard cap on pages walked per poll (safety limit). After the first full walk, routine polls stop at the first page with nothing new; **Sync Now** walks the whole list |
| `APPLAUD_WEBHOOK_BACKOFF_MS` | `5000,30000,120000` | Comma-separated retry backoff schedule for webhook delivery |
| `APPLAUD_WEBHOOK_REDRIVE_BASE_MINUTES` | `5` | Delay before the first automatic re-delivery of a failed webhook; each further failure triples it |
| `APPLAUD_WEBHOOK_REDRIVE_MAX_HOURS` | `24` | Upper bound on the automatic re-delivery delay |
| `APPLAUD_WEBHOOK_REDRIVE_MAX_ATTEMPTS` | `8` | Failed deliveries before automatic re-delivery gives up (manual **Redeliver** still works) |
| `APPLAUD_WEBHOOK_REDRIVE_MAX_PER_POLL` | `10` | Most webhook re-deliveries attempted in one sync cycle |
| `APPLAUD_WEBHOOK_URL_TTL_HOURS` | `168` | How long the signed `http_urls` in a webhook payload stay valid (LAN token installs) |
| `APPLAUD_BROWSER_TICKET_TTL_HOURS` | `24` | Lifetime of the signed ticket the web UI uses for media links and live updates |
| `APPLAUD_TRASH_RETENTION_DAYS` | `7` | Days a soft-deleted recording stays in Trash before local files are purged |
| `APPLAUD_RECORDINGS_MAX_LIMIT` | `500` | Hard cap on `limit` for any recordings list/search query |

Security-related (see [Security notes](#security-notes)):

| Variable | Default | What it controls |
| --- | --- | --- |
| `APPLAUD_WEBHOOK_ALLOW_PRIVATE` | unset | `1` allows webhook deliveries/tests to private, loopback, and link-local addresses (local n8n, Home Assistant, …) |
| `APPLAUD_ALLOWED_HOSTS` | unset | Extra `Host` values to accept, comma-separated. `*.example.com` matches subdomains; `*` disables the check |
| `APPLAUD_LAN_TOKEN` | unset | Container mode: use this LAN token instead of generating one (min. 16 chars) |
| `APPLAUD_ALLOW_NO_AUTH` | unset | `1` lets container mode run unauthenticated (only if something else authenticates in front of it) |
| `APPLAUD_LAN_TOKEN_MIN_LENGTH` | `16` | Minimum accepted LAN-token length |
| `APPLAUD_RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate-limit window |
| `APPLAUD_RATE_LIMIT_API_MAX` | `600` | Requests per window per client for `/api` |
| `APPLAUD_RATE_LIMIT_MEDIA_MAX` | `900` | Requests per window per client for `/media` |
| `APPLAUD_RATE_LIMIT_SENSITIVE_MAX` | `20` | Requests per window for `test-webhook` / `validate-recordings-dir` |
| `APPLAUD_RATE_LIMIT_AUTH_FAILURES` | `20` | Failed LAN-token attempts per window before a client gets 429s |
| `APPLAUD_SKIP_ACL_HARDENING` | unset | `1` skips the Windows config-directory ACL lockdown |

## Development

```bash
pnpm dev
```

Runs the Vite dev server on port 44470 with a proxy for `/api` and `/media` to the Express server on port 44471. The server runs in `tsx watch` mode. Hot reload works on both sides.

- HTTP API reference: [`docs/api.md`](docs/api.md)
- Contributing guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License
 MIT see [`LICENSE`](LICENSE)