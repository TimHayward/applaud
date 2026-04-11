# applaud

A self-hosted local server that mirrors your [Plaud](https://plaud.ai) recordings to disk and fires webhooks when new recordings or transcripts arrive. Runs on your machine, uses your existing Plaud browser session for auth, and ships with a React web UI for setup and browsing.

> applaud is not affiliated with Plaud. It talks to the same undocumented web API that the Plaud web app uses, via your own logged-in session.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/rsteckler/applaud/main/install.sh | sh
```

The installer bootstraps [pnpm](https://pnpm.io) and Node.js (if missing), clones this repo to `~/applaud`, and runs the build. Then:

```bash
cd ~/applaud
pnpm start
```

Your browser will open to `http://127.0.0.1:7528/setup` (T9 for "PLAU"). Walk through the 5-step wizard and you're done.

### Manual install

```bash
git clone https://github.com/rsteckler/applaud.git
cd applaud
pnpm install
pnpm build
pnpm start
```

Requires Node.js ≥ 20 and pnpm ≥ 9.

## How it works

1. **Auth:** applaud reads your existing Plaud session from Chrome (or Edge / Brave / Arc / Vivaldi) by copying the browser's `Local Storage/leveldb` directory to a temp path (which sidesteps Chrome's file lock) and pulling the JWT bearer from the `tokenstr` key for `web.plaud.ai`. No passwords, no OAuth, no Playwright — just your existing session. Tokens are good for ~10 months.

2. **Sync:** every 10 minutes (configurable), the server calls `/file/simple/web` on `api.plaud.ai` to list your latest recordings. New ones get a per-recording subfolder, their audio streamed down from S3, and — once Plaud finishes transcribing — transcript + summary pulled via `/ai/transsumm/`.

3. **Webhook:** if configured, applaud POSTs a JSON payload to your URL whenever a new `audio_ready` or `transcript_ready` event happens. Includes file paths (relative to your recordings dir) plus ready-to-fetch HTTP URLs that the local media server serves, and — on `transcript_ready` — the flattened transcript text and summary markdown inline so n8n-style workflows don't need a second fetch.

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
  "event": "audio_ready" | "transcript_ready",
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
    "audio": "http://127.0.0.1:7528/media/2026-04-11_...__74560101/audio.ogg",
    "transcript": "http://127.0.0.1:7528/media/2026-04-11_...__74560101/transcript.json",
    "summary": "http://127.0.0.1:7528/media/2026-04-11_...__74560101/summary.md"
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

## Running in the background

applaud is a foreground process. To keep it running without a terminal:

**macOS (launchd):** create `~/Library/LaunchAgents/dev.applaud.plist` pointing to `pnpm start` in the install dir.

**Linux (systemd user):** create `~/.config/systemd/user/applaud.service` with `ExecStart=pnpm --dir=%h/applaud start`.

**Both platforms:** or just run it inside `tmux` / `screen`.

## Config

Settings live in `~/.config/applaud/settings.json` (or `~/Library/Application Support/applaud/` on macOS, `%APPDATA%\applaud\` on Windows). Recording state is in `state.sqlite` alongside. Both are managed through the web UI — you shouldn't need to edit them by hand.

The bearer token is stored as plaintext in `settings.json` (with `chmod 600`). The file lives in a user-only directory, and the token's scope is equivalent to "read this user's own Plaud data." OS keychain integration is a future enhancement.

## Development

```bash
pnpm dev
```

Runs the Vite dev server (for the React UI) on port 5173 with a proxy for `/api` and `/media` to the Express server on 7528. The server runs in `tsx watch` mode. Hot reload works on both sides.

## License

MIT
