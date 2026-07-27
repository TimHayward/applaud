# Applaud

A self-hosted local server that mirrors your [Plaud](https://plaud.ai) recordings to disk and fires webhooks when new recordings or transcripts arrive, so you can easily hook it up to n8n (or any other custom integration). Runs on your machine, uses your existing Plaud browser session for auth, and ships with a web UI for setup and browsing.

> Applaud is not affiliated with Plaud. It talks to the same undocumented web API that the Plaud web app uses, via your own logged-in session.

> [!NOTE]
> <img src="assets/rovenotes-logo.png" align="right" width="80" alt="RoveNotes" />
>
> **Want more features without the complexity of self-hosting?** Check out the professionally managed version at **[rovenotes.com](https://rovenotes.com)**. It includes everything in Applaud plus additional destinations — Google Drive, Notion, Obsidian, reMarkable tablet, Google Calendar, Todoist, and email (in addition to webhooks / n8n) — and supports multiple AI summaries per recording.

## Features

- **Automatic sync** — polls Plaud every 10 minutes (configurable) and downloads audio, transcripts, and AI summaries to local disk
- **Full-text search** — search recordings by filename or transcript content
- **Audio player** — custom player with waveform visualization, play/pause, skip -10s/+30s, click-to-seek
- **Transcript viewer** — speaker-labeled, timestamped, color-coded blocks with auto-scroll during playback, click-to-seek, and full-text search within transcripts
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
curl -fsSL https://raw.githubusercontent.com/rsteckler/applaud/v0.5.11/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/rsteckler/applaud/v0.5.11/install.ps1 | iex
```

The installer does everything needed to install Applaud into a subfolder named `./applaud`. To run it:

```bash
cd applaud
pnpm start
```

Your browser will open to `http://127.0.0.1:44471/setup`. Walk through the 5-step wizard and you're done.

### Manual install

```bash
git clone https://github.com/rsteckler/applaud.git
cd applaud
pnpm install
pnpm build
pnpm start
```

Requires Node.js >= 20 and pnpm >= 9.

## How it works

1. **Auth:** Applaud reads your existing Plaud session from Chrome (or Edge / Brave / Arc / Vivaldi). No passwords, no OAuth, no Playwright — just your existing session.
   - **Legacy accounts** still expose a long-lived JWT in Local Storage. Applaud copies the browser's `Local Storage/leveldb` directory to a temp path (which sidesteps Chrome's file lock) and pulls the bearer from the `tokenstr` key for `web.plaud.ai`.
   - **Newer accounts** (Plaud stopped exposing `tokenstr` — see issue #31) use short-lived cookies instead. When `tokenstr` is absent, Applaud reads the `pld_ut` (user token, ~1 day) and `pld_urt` (refresh token, ~30 days) cookies from Chromium's on-disk cookie store, decrypting them with the platform key (Linux login keyring / the well-known fallback, or the macOS Keychain). It then lists your workspaces and mints a short-lived workspace token for the API, refreshing the user token off the refresh token as it ages — the same first-party flow the RoveNotes Connector uses. On **Windows**, cookies are DPAPI-encrypted and can't be read off disk, so paste them manually instead: sign in at `web.plaud.ai`, open `api.plaud.ai/auth/refresh-user-token` in the same browser to refresh your session, then copy `pld_urt` and `pld_ut` from your `api.plaud.ai` cookies.

2. **Sync:** every 10 minutes (configurable), the server calls `/file/simple/web` on `api.plaud.ai` to list your latest recordings. New ones get a per-recording subfolder, their audio streamed down from S3, and — once Plaud finishes transcribing — transcript + summary pulled via `/ai/transsumm/` (with S3 fallback for older recordings).

3. **Webhook:** if configured, Applaud POSTs a JSON payload to your URL whenever a new `audio_ready` or `transcript_ready` event happens. Includes file paths (relative to your recordings dir) plus ready-to-fetch HTTP URLs that the local media server serves, and — on `transcript_ready` — the flattened transcript text and summary markdown inline so n8n-style workflows don't need a second fetch.

## Folder layout

Each recording gets its own folder under your chosen recordings directory:

```
<recordings-dir>/
  2026-04-11_My_meeting_title__74560101/
    audio.ogg
    transcript.json     # raw Plaud transcript segments (with speaker embeddings)
    transcript.txt      # speaker-labeled, timestamped plaintext
    summary.md          # Plaud's AI-generated summary (when available)
    metadata.json       # full /file/detail response
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

Pull the pre-built image and run:

```bash
docker run -d \
  --name applaud \
  -p 44471:44471 \
  -v applaud-config:/data/config \
  -v applaud-recordings:/data/recordings \
  ghcr.io/rsteckler/applaud:latest
```

Or build from source:

```bash
docker build -t applaud .
docker run -d \
  --name applaud \
  -p 44471:44471 \
  -v applaud-config:/data/config \
  -v applaud-recordings:/data/recordings \
  applaud
```

### Docker Compose

Or use the bundled compose file:

```bash
docker compose up -d
```

To build from source instead of pulling the image, uncomment `build: .` (and comment out `image:`) in `docker-compose.yml`.

Open `http://localhost:44471/setup` to configure. On first run, the setup wizard will ask you to paste your Plaud token manually (browser auto-detect doesn't work inside a container).

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

## Running in the background

Applaud is a foreground process. To keep it running without a terminal:

**macOS (launchd):** create `~/Library/LaunchAgents/dev.applaud.plist` pointing to `pnpm start` in the install dir.

**Linux (systemd user):** create `~/.config/systemd/user/applaud.service` with `ExecStart=pnpm --dir=%h/applaud start`.

**Both platforms:** or just run it inside `tmux` / `screen`.

## Config

Settings live in `~/.config/applaud/settings.json` (or `~/Library/Application Support/applaud/` on macOS, `%APPDATA%\applaud\` on Windows). Recording state is in `state.sqlite` alongside. Both are managed through the web UI — you shouldn't need to edit them by hand.

The Plaud tokens are stored as plaintext in `settings.json` (with `chmod 600`) — the bearer/workspace token, and for newer accounts the `pld_ut` / `pld_urt` cookie values used to keep it fresh. The file lives in a user-only directory, and their scope is equivalent to "read this user's own Plaud data." The web UI never receives these values back — they're redacted in the config API. OS keychain integration is a future enhancement.

**On Windows**, `chmod 600` is a no-op, so on first run Applaud restricts the ACL on `%APPDATA%\applaud\` instead (`icacls /inheritance:r`, granting only your account and `SYSTEM`) and drops an `.acl-hardened` marker so it only does this once. The tokens, your `lanToken`, and `webhook.secret` are still stored in cleartext — anything running as your user can read them. Set `APPLAUD_SKIP_ACL_HARDENING=1` to skip the ACL change; DPAPI-encrypted storage is a future enhancement.

### Security notes

- **Webhook targets must be public by default.** Applaud resolves the URL and refuses private, loopback, and link-local addresses before connecting, so the "Test" button can't be used to probe your machine or LAN. Pointing it at a local n8n / Home Assistant / Node-RED instance is a normal thing to want — set `APPLAUD_WEBHOOK_ALLOW_PRIVATE=1` for that. Redirects are never followed (a 3xx is logged as a failed delivery).
- **Files under `/media` are served as downloads** unless they're audio or a raster image, with `nosniff` and a sandboxing CSP, so an `.svg`/`.html` file inside a recording folder can't run script in the app's origin.
- **Requests must arrive under a known hostname** — an IP literal, `localhost`, a `.local`/`.lan`/`.internal`/`.home.arpa`/`.ts.net` name, your `bind.host`, or something in `APPLAUD_ALLOWED_HOSTS`. This is what stops a web page you visit from rebinding its own domain to `127.0.0.1` and driving the API.
- **`/api` takes the LAN token by `Authorization: Bearer` header only.** `?token=` works on `/media` (for `<audio>`/`<a>`/`<img>`, which can't set headers) and is stripped from the URL after first load; responses send `Referrer-Policy: no-referrer` so it doesn't leak onward.

### Advanced tuning (environment variables)

These are optional and only matter for unusual setups (very large libraries, flaky networks, stricter retention). Defaults match what Applaud has always shipped with.

| Variable | Default | What it controls |
| --- | --- | --- |
| `APPLAUD_PLAUD_MAX_ATTEMPTS` | `3` | Retries for a single Plaud API call |
| `APPLAUD_PLAUD_USER_AGENT` | a desktop Chrome UA | Spoofed User-Agent sent to Plaud (bypasses Cloudflare's bot check) |
| `APPLAUD_POLLER_PAGE_SIZE` | `50` | Page size when walking your Plaud recording list |
| `APPLAUD_POLLER_MAX_PAGES` | `200` | Hard cap on pages walked per poll (safety limit) |
| `APPLAUD_WEBHOOK_BACKOFF_MS` | `5000,30000,120000` | Comma-separated retry backoff schedule for webhook delivery |
| `APPLAUD_TRASH_RETENTION_DAYS` | `7` | Days a soft-deleted recording stays in Trash before local files are purged |
| `APPLAUD_TRASH_PROBE_INTERVAL_HOURS` | `6` | How often Plaud-trashed recordings are re-checked for a transcript/summary |
| `APPLAUD_TRASH_PROBE_SCHEDULED_LIMIT` | `25` | Max Plaud-trash rows probed per scheduled poll |
| `APPLAUD_TRASH_PROBE_MANUAL_LIMIT` | `100` | Max Plaud-trash rows probed on a manual Sync Now |
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