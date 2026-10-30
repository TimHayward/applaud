# Running Applaud on Portainer

This guide deploys Applaud as a Portainer stack that is **built from this Git repository**, reachable **only from your local network**, with outbound internet access so it can talk to Plaud.

The example values used throughout:

| Setting | Example |
| --- | --- |
| Address you open Applaud on | `http://docker.hayward.mx:44471` |
| Stack name | `applaud` |
| Host port | `44471` (change it with `APPLAUD_PORT`) |

## How it fits together

```
Your browser (LAN + internet)
   │  1. opens http://docker.hayward.mx:44471            ──► Applaud container (Docker host, LAN only)
   │  2. "Sign in with Plaud" opens Plaud's sign-in page ──► web.plaud.ai / mcp.plaud.ai
   │  3. Plaud sends the browser back to                   http://docker.hayward.mx:44471/api/auth/plaud/callback
   │
Applaud container ── outbound HTTPS only ──► mcp.plaud.ai, platform.plaud.ai, Plaud storage on *.amazonaws.com
```

- **Inbound:** only your local subnets need to reach the container. Nothing on the internet connects to Applaud, including Plaud itself: the sign-in callback is a redirect of *your browser*, not a call from Plaud's servers.
- **Outbound:** the container needs HTTPS (port 443) to Plaud. See [Network requirements](#network-requirements).

## Before you start

1. **Portainer** with a Docker *standalone* environment on the host (Portainer CE 2.x or BE). Docker Swarm environments do not build images from a stack; use a standalone environment.
2. **DNS:** `docker.hayward.mx` must resolve to the Docker host's LAN IP for every machine that will use Applaud (a record on your local DNS server or router, or a public DNS record pointing at the private IP).
3. **A LAN access token.** Applaud requires one in a container. Generate a random one now and keep it in your password manager, for example:

   ```bash
   openssl rand -hex 24
   ```

   (If you skip this, Applaud generates one on first start and prints it to the container log.)

## 1. Create the stack

In Portainer: **Stacks → Add stack**.

1. **Name:** `applaud`
2. **Build method:** **Repository**
3. **Repository URL:** `https://github.com/TimHayward/applaud`
   The repository is public, so leave **Authentication** off.
4. **Repository reference:** `refs/heads/main`
5. **Compose path:** `docker-compose.yml`
6. **Environment variables** (Advanced mode lets you paste them):

   ```
   APPLAUD_PORT=44471
   APPLAUD_ALLOWED_HOSTS=docker.hayward.mx
   APPLAUD_LAN_TOKEN=<the token you generated>
   ```

   | Variable | Why |
   | --- | --- |
   | `APPLAUD_PORT` | Host port the stack publishes. Use whatever port you want in `docker.hayward.mx:PORT`. |
   | `APPLAUD_ALLOWED_HOSTS` | Applaud rejects requests addressed to hostnames it doesn't know (a defence against DNS rebinding). IP addresses and `.lan` / `.local` / `.internal` / `.home.arpa` names are always accepted; `docker.hayward.mx` must be listed. Comma-separate several names. |
   | `APPLAUD_LAN_TOKEN` | Pins the access token. **Read on first start only**: once stored, change it in **Settings → LAN Access**, not here. |

7. Click **Deploy the stack**.

Portainer clones the repository and builds the image (`applaud:local`). The first build downloads the Node.js base image, Debian packages and npm packages and takes a few minutes; the page waits until it finishes.

The stack creates two volumes, named after the stack:

| Volume | Mounted at | Holds |
| --- | --- | --- |
| `applaud_config` | `/data/config` | Settings (including your Plaud tokens and the LAN token), the recordings database |
| `applaud_recordings` | `/data/recordings` | Audio, transcripts, summaries, metadata |

## 2. Check it is running

**Containers → applaud** should show the state **healthy** within about a minute (the image has a built-in health check on `/api/health`). If it doesn't, open **Logs**.

## 3. First-run setup

1. On a machine on your LAN **that also has internet access** (you'll need it for Plaud's sign-in page), open:

   ```
   http://docker.hayward.mx:44471/?token=<your LAN token>
   ```

   The token is saved in that browser and removed from the address bar. Repeat this once on each browser you use.

2. The setup wizard opens.
   - **Connect your Plaud account:** click **Sign in with Plaud**. A new tab opens on Plaud's site; sign in and approve access. The tab returns to Applaud and shows "Plaud connected"; close it, and the wizard shows your account. Click **Continue**.
     Open Applaud on the same address you'll normally use (`docker.hayward.mx:PORT`) when you sign in: Plaud sends you back to the address you started from.
   - **Recordings folder:** enter **`/data/recordings`**. This is the path *inside the container*, backed by the `applaud_recordings` volume. Any other path would be lost when the container is recreated.
   - **Webhook:** optional. A target on your LAN (for example n8n) also needs `APPLAUD_WEBHOOK_ALLOW_PRIVATE=1`; uncomment it in the compose file (see [Changing settings](#changing-settings)).
   - **Review:** set **days of history** (default 30). Recordings from that many days before today onwards download in full; older ones are listed as *details only* and can be downloaded individually with **Download**.

3. Click **Save & start syncing**. The first sync indexes your whole Plaud library and downloads the recordings inside the history window.

## Keeping it local-only

Applaud is safe to expose to your LAN (token required, hostname check) but should not be exposed to the internet:

- **Don't forward the port** on your router or firewall.
- Docker publishes ports on **all of the host's interfaces** and inserts its own firewall rules, so host firewalls such as `ufw` do not restrict published ports. If the host has an interface that faces the internet (or a VPN you don't trust), publish on the LAN address only by changing the port line in `docker-compose.yml` to, for example, `"192.168.1.10:${APPLAUD_PORT:-44471}:44471"`. For finer rules, filter in the `DOCKER-USER` iptables chain.
- Traffic is plain HTTP, so the LAN token and your recordings cross the LAN unencrypted. On a trusted home or office LAN that is usually acceptable; if not, put Applaud behind a reverse proxy with TLS (for example Nginx Proxy Manager or Traefik), open it on the `https://` address, and sign in to Plaud from that address.

## Network requirements

**Inbound (from local subnets only):** TCP `APPLAUD_PORT` on the Docker host.

**Outbound from the container (HTTPS, port 443):**

| Host | Used for |
| --- | --- |
| `mcp.plaud.ai` | Sign-in registration, token exchange and the daily token renewal |
| `platform.plaud.ai` | Recording list and records (Plaud's developer API) |
| `*.amazonaws.com` (for example `euc1-prod-plaud-content-storage.s3-accelerate.amazonaws.com`) | Audio, transcript and note downloads (Plaud's storage; the exact host depends on your account's region) |
| Your webhook target | Only if you configure a webhook |

**Outbound while building the image:** `registry-1.docker.io` (and Docker Hub's CDN) for the base image, `deb.debian.org`, `registry.npmjs.org`, and `github.com` for Portainer's clone and the speaker model (served from GitHub's release download host, `release-assets.githubusercontent.com` or `objects.githubusercontent.com`).

**The browser you sign in with** needs `web.plaud.ai` and `mcp.plaud.ai`, plus LAN access to Applaud.

## Staying signed in

Plaud's access token lasts 24 hours and its refresh token 7 days; Applaud renews daily and each renewal issues a fresh 7-day refresh token. In practice: **Applaud stays signed in as long as the container runs at least once a week.** After a longer outage the status badge shows *auth required*; use **Settings → Account Details → Reconnect Plaud account**.

## Updating

Until a versioned image is published, updates come from rebuilding the stack from `main`:

1. **Stacks → applaud → Pull and redeploy** (on Portainer versions with Git stacks, the button is on the stack's page; confirm when asked).
2. Check **Images → `applaud:local`**: its *Created* time should be the time of the redeploy.
3. If it wasn't rebuilt, stop the stack, delete the `applaud:local` image under **Images**, and start the stack again; Portainer then has to build it.

If a redeploy fails with `pull access denied for applaud`, the stack is building from a commit older than the `pull_policy: build` line in `docker-compose.yml`, and Portainer's re-pull option is asking Docker Hub for the local image. Redeploy once with re-pull turned off; later redeploys work either way.

Your settings, sign-in and recordings live in the volumes and survive both.

> These Portainer steps have not been tested against a specific Portainer version from this repository. If your version's button names differ, the principle is the same: re-clone, rebuild, recreate the container, keep the volumes.

## Changing settings

- Most settings (history window, poll interval, webhook, LAN token) are in Applaud's **Settings** page.
- Environment variables: **Stacks → applaud → Environment variables** → change → **Update the stack**. Remember that `APPLAUD_LAN_TOKEN` is only read on first start.
- Compose-file changes (publishing on one IP, `APPLAUD_WEBHOOK_ALLOW_PRIVATE`) need to be in the repository the stack builds from. Commit them to the repository, or switch the stack to Portainer's **Web editor** with the same content if you want local-only changes (note that the web editor can't build from the repository, so this only works once there is a published image to use instead of `build:`).

## Speaker identification

Optional, and off until you turn it on in **Settings → Speaker identification**. Applaud then learns voices from your recordings and recognises speakers across them. Everything runs inside the Applaud container: audio and voiceprints never leave it, and no extra container or port is needed.

When you turn it on, Applaud:

1. **Checks the host** by loading the speaker model and analysing a second of silence. The card then shows **Available**, or **Not supported on this host** with the reason (see requirements below). Applaud itself carries on either way.
2. **Analyses every downloaded recording once**, one at a time in the background, then each new recording as its transcript arrives. Sync is never delayed by this. Recordings shown as *details only* are analysed once you download them.
3. **Learns your voice** from the recordings where Plaud tagged you. Choose your name under **Which name is you in Plaud's transcripts?**; until you do, Applaud uses your Plaud account name if Plaud tags you with it.
4. **Names speakers it recognises.** Once you have confirmed who someone is, their voice is matched in other recordings: named automatically when the match is clear, offered as a suggestion when it is close. Each analysed recording's folder gets `transcript-Applaud.json` and `transcript-Applaud.txt`, Plaud's transcript with these names applied; they are rewritten whenever a name changes. Plaud's own `transcript.json` and `transcript.txt` are never modified.

Name people on a recording's page, in the **Speakers** panel: play a clip, then confirm the suggestion, pick someone, type a new name, or ignore the label. The transcript there can show Applaud's or Plaud's names, and a single line can be assigned to someone else. **Settings → People and voiceprints** lists everyone, with rename, merge and delete, and each person's voiceprints. Recordings with speakers still to name are marked on the Recordings list.

The bands for automatic names and suggestions are under **Matching thresholds** on the same card. The defaults come from calibration on real recordings; changing them re-checks every recording at once and never alters a name you confirmed.

**Requirements and resources**

| | |
| --- | --- |
| CPU | x86-64 with AVX (any recent Intel or AMD), or arm64. Hosts without AVX, such as some Celeron and Atom NAS models, show *Not supported on this host*. |
| Memory | The speaker model runs in a separate process that starts when there is work and exits after 5 minutes idle. It needs about 200 to 400 MB on top of Applaud while running. |
| Memory limit | If you set one for the stack, allow at least 600 MB. Below that the speaker process is the one killed, and the card shows "killed, most likely for running out of memory". |
| CPU time | The model took about 8 seconds per hour of audio on 2 threads in testing; decoding the recording adds to that. A large library takes a while to work through the first time. |

**Optional environment variables**

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLAUD_SPEAKER_THREADS` | `2` | CPU threads the model uses |
| `APPLAUD_SPEAKER_IDLE_SEC` | `300` | Stop the speaker process after this long with no work |

**Privacy.** Voiceprints are biometric data. They are stored only in the database in the `applaud_config` volume, never sent anywhere, and never included in webhooks or exports, so treat backups of that volume accordingly.

## Backups

Back up **both volumes**. `applaud_config` contains your Plaud tokens and the LAN token, so store backups as securely as a password.

Stop the stack first so the database is consistent, then from the Docker host:

```bash
docker run --rm -v applaud_config:/v -v "$PWD":/backup alpine tar czf /backup/applaud_config.tgz -C /v .
docker run --rm -v applaud_recordings:/v -v "$PWD":/backup alpine tar czf /backup/applaud_recordings.tgz -C /v .
```

Restore by extracting into empty volumes of the same names before starting the stack.

Removing the stack leaves its volumes in place; delete them under **Volumes** only if you really want to discard everything.

## Getting at the files

Files are served by Applaud itself (player, downloads, webhook URLs). On the Docker host they are at `/var/lib/docker/volumes/applaud_recordings/_data/` (root access needed). If you want them on a share instead, replace the `recordings` volume with a bind mount to a host folder owned by uid `1000` (the user the container runs as).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `host not allowed` (HTTP 403) | The hostname you used isn't in `APPLAUD_ALLOWED_HOSTS`. Add it and update the stack. |
| Every page asks for the token / HTTP 401 | Open `http://docker.hayward.mx:PORT/?token=<token>` once in this browser. Lost the token? It's in the first container log lines (if generated) or, if pinned, in your stack variables; otherwise read `lanToken` from `settings.json` in the `applaud_config` volume. |
| The Plaud tab ends on a page that won't load | Your browser couldn't reach the address Plaud sent it back to. Copy that tab's full address into the box under **Sign in with Plaud** and click **Finish sign-in**. |
| *Auth required* after downtime | The container was off for more than 7 days. Reconnect in **Settings**. |
| Build fails with `429 Too Many Requests` from Docker Hub | Docker Hub's anonymous pull limit. Add Docker Hub credentials under Portainer **Registries**, or retry later. |
| A recording shows *details only* | It's older than the history window. Click **Download**, or raise **Settings → History window**. |
| Recordings folder errors in the wizard | Use `/data/recordings`, the volume's path inside the container. |

## Later: switching to a released image

When a release is tagged, GitHub builds a multi-architecture image (`ghcr.io/timhayward/applaud:<version>`). To switch, replace `build: .` and `image: applaud:local` in the stack with `image: ghcr.io/timhayward/applaud:<version>` and redeploy. The volumes, and therefore your sign-in and library, carry over.
